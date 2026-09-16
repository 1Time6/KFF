import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {createAcquisitionFixture,createMonitor,controlMonitor,projectDiscoveryLeads,acquisitionWorkspace,queueOutreach,controlDiscoveryLead,configureAcquisitionAutomation,prepareAcquisitionAction,prepareDiscoveryScan} from '../../packages/core/src/acquisition';
import {claimCollection,commitCollectionPage,processCollectionPage} from '../../packages/core/src/collections';
import {localDiscoveryPage} from '../../packages/adapters/src/discovery';
import {dispatchOne,claimCommand,beginSubmission,acceptReport} from '../../packages/core/src/execution';
import {createAccount} from '../../packages/core/src/service';
import {normalizeApifyComment} from '../../packages/adapters/src/apify';
const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{
  const db=(await query('SELECT current_database() AS name'))[0].name;if(db!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(db))throw new Error('Isolated database required');
  await query('TRUNCATE kff.acquisition_monitors,kff.acquisition_suppressions,kff.collection_queries,kff.collection_objects,kff.tasks CASCADE');
  await query('UPDATE kff.accounts SET outbound_paused=false');await query('UPDATE kff.brands SET outbound_paused=false');await query('UPDATE kff.organizations SET outbound_paused=false');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1",[localIds.agent]);
});
afterAll(closePool);
async function setup(platform:'facebook'|'instagram'='facebook'){
  const a=await createAcquisitionFixture(scope,{request_id:randomUUID(),platform,agent_id:localIds.agent});
  const input={request_id:randomUUID(),account_id:a.account_id,title:'Intent monitor',discovery:{platform,strategy:'COMMENTS',provider:'LOCAL_FIXTURE',keywords:['consultation'],exclusions:[],target:'',processing_basis:'Local synthetic acquisition verification'},interval_minutes:5,max_records:100,max_pages:10,retention_days:7};
  const m=await createMonitor(scope,input);return {a,m,input};
}
async function scan(m:{id:string;version:number}){await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:m.version,action:'SCAN',reason:'Manual isolated scan'});await processCollectionPage();await projectDiscoveryLeads();return (await acquisitionWorkspace(scope)).leads;}
it('deduplicates monitor requests and repeated observations without increasing unique leads',async()=>{
  const {m,input}=await setup();expect((await createMonitor(scope,input)).id).toBe(m.id);
  await expect(createMonitor(scope,{...input,title:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  let leads=await scan(m);expect(leads).toHaveLength(3);expect(leads.filter(l=>l.score===75)).toHaveLength(2);
  leads=await scan(m);expect(leads).toHaveLength(3);expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(8);
});
it('supports Instagram and isolates accounts, roles and brands',async()=>{
  const {m}=await setup('instagram');const leads=await scan(m);expect(leads[0].config.discovery.platform).toBe('instagram');
  expect((await acquisitionWorkspace({...scope,brand_id:randomUUID()})).leads).toHaveLength(0);
  await expect(createMonitor({...scope,role:'viewer'},{})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(controlDiscoveryLead({...scope,brand_id:randomUUID()},leads[0].id,{request_id:randomUUID(),expected_version:1,state:'QUALIFIED',reason:'Test other brand'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
});
it('keeps an approved delayed action valid when a new scan returns the exact same comment',async()=>{
  const {a,m}=await setup(),lead=(await scan(m))[0];
  const input={request_id:randomUUID(),lead_id:lead.id,expected_version:lead.version,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Delayed local response',authorization_basis:'Approved synthetic source for unchanged repeat',delay_minutes:30};
  const prepared=await queueOutreach(scope,input);
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Repeat unchanged comment'});
  const claim=(await claimCollection())!,page=localDiscoveryPage(claim);
  page.rows=page.rows.filter(row=>row.source_object_id===lead.source_object_id).map(row=>({...row,fields:lead.fields,source_url:lead.source_url}));
  await commitCollectionPage(claim,page);await projectDiscoveryLeads();
  const current=(await acquisitionWorkspace(scope)).leads.find(row=>row.id===lead.id)!;
  expect(current.version).toBe(lead.version);expect(current.observation_id).toBe(lead.observation_id);
  await query('UPDATE kff.jobs SET available_at=clock_timestamp() WHERE action_id IN (SELECT id FROM kff.actions WHERE run_id=$1)',[prepared.run_id]);
  await dispatchOne();const command=(await claimCommand({id:localIds.agent,organization_id:scope.organization_id,brand_id:scope.brand_id,status:'ONLINE'}))!;
  expect(command.snapshot.outreach?.source_object_id).toBe(lead.source_object_id);
});
it('a pause fences a page already claimed by a worker and prevents stale data commit',async()=>{
  const {m}=await setup();await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Scan for stopping test'});
  const claim=(await claimCollection())!;expect(claim).toBeTruthy();await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'PAUSE',reason:'Pause before page commit'});
  await expect(commitCollectionPage(claim,localDiscoveryPage(claim))).rejects.toMatchObject({code:'STALE_COLLECTION_LEASE'});expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(0);
});
it('turns a selected comment into exactly one original task and validates its recipient receipt',async()=>{
  const {a,m}=await setup(),lead=(await scan(m))[0];
  const input={request_id:randomUUID(),lead_id:lead.id,expected_version:lead.version,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Would you like more details?',authorization_basis:'Explicit local test approval for this comment',delay_minutes:0};
  const rows=await Promise.all([queueOutreach(scope,input),queueOutreach(scope,input)]);expect(rows[0].task_id).toBe(rows[1].task_id);
  await expect(queueOutreach(scope,{...input,request_id:randomUUID()})).rejects.toMatchObject({code:'OUTREACH_ALREADY_EXISTS'});
  await dispatchOne();const agent={id:localIds.agent,organization_id:scope.organization_id,brand_id:scope.brand_id,status:'ONLINE'},command=(await claimCommand(agent))!;
  expect(command.snapshot.outreach?.source_object_id).toBe(lead.source_object_id);await beginSubmission(agent,command.id);
  await expect(acceptReport(agent,{event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:'synthetic_'+randomUUID(),actual_account_id:command.snapshot.external_account_id,recipient_id:'77777',content_hash:command.snapshot.content_hash,evidence_kind:'synthetic_message',observed_at:new Date().toISOString()},diagnostic:{step:'test'}})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
});
it('blocks author opt-out even when the same customer is collected again in another monitor',async()=>{
  const {a,m,input}=await setup(),lead=(await scan(m))[0];
  await controlDiscoveryLead(scope,lead.id,{request_id:randomUUID(),expected_version:lead.version,state:'OPTED_OUT',reason:'Customer asked to stop contact'});
  const other=await createMonitor(scope,{...input,request_id:randomUUID()});const leads=await scan(other);const next=leads.find(l=>l.monitor_id===other.id&&l.source_object_id===lead.source_object_id)!;
  await expect(queueOutreach(scope,{request_id:randomUUID(),lead_id:next.id,expected_version:next.version,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Hello',authorization_basis:'Isolated test attempts stale contact'})).rejects.toMatchObject({code:'CONTACT_BLOCKED'});
});
it('a due monitor generates a real queued scan, then automated delayed tasks with no duplicate scheduling',async()=>{
  const {a,m}=await setup();await configureAcquisitionAutomation(scope,{request_id:randomUUID(),monitor_id:m.id,expected_version:1,enabled:true,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Hello from configured workflow',authorization_basis:'Approved synthetic automation scope',min_score:70,daily_limit:5,delay_minutes:30});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:2,action:'START',reason:'Start test automation'});
  await Promise.all([prepareDiscoveryScan(),prepareDiscoveryScan()]);expect((await query('SELECT count(*)::int AS n FROM kff.acquisition_scans'))[0].n).toBe(1);
  await processCollectionPage();await projectDiscoveryLeads();await prepareAcquisitionAction();
  const ws=await acquisitionWorkspace(scope);expect(ws.actions).toHaveLength(1);expect(ws.actions[0].state).toBe('QUEUED');
  expect((await query("SELECT available_at>clock_timestamp()+interval '29 minutes' AS delayed FROM kff.jobs WHERE kind='EXECUTION'"))[0].delayed).toBe(true);
});
it('does not turn provider/competitor matches into private-message permission',async()=>{
  const {m}=await setup();await scan(m);
  await scoped({...scope,role:'viewer'},async client=>{const rows=await client.query('SELECT id FROM kff.acquisition_leads');expect(rows.rowCount).toBe(3);});
  const a=(await query('SELECT * FROM kff.accounts WHERE id=$1',[m.account_id]))[0];
  await expect(createMonitor(scope,{...m.config,request_id:randomUUID(),discovery:{...m.config.discovery,provider:'DATA_PROVIDER'}})).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});expect(a.is_synthetic).toBe(true);
});
it('accepts Apify observations without Meta credentials, preserves account state and blocks provider outreach',async()=>{
  const account=await createAccount(scope,{display_name:'Apify isolated scope',platform:'facebook',account_type:'page',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString()});
  const m=await createMonitor(scope,{request_id:randomUUID(),account_id:account.id,title:'Apify isolated contract',discovery:{platform:'facebook',provider:'DATA_PROVIDER',strategy:'COMMENTS',keywords:['help'],target:'apify-run:'+'r'.repeat(17),processing_basis:'Isolated contract data; no external crawl'},interval_minutes:30,max_records:20,max_pages:5,retention_days:7});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Validate provider ingestion'});
  const claim=(await claimCollection())!;expect(claim).toBeTruthy();
  const record=normalizeApifyComment({commentId:'987',text:'I need help',profileId:'pfbidOpaque',date:new Date().toISOString(),commentUrl:'https://www.facebook.com/123/posts/456?comment_id=987'},claim);
  await commitCollectionPage(claim,{schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:claim.query_id,account_external_id:account.external_id,cursor:null,next_cursor:null,observed_at:new Date().toISOString(),reported_total:1,coverage:'PROVIDER_RESULTS_ONLY',rows:[record]});
  await projectDiscoveryLeads();const lead=(await acquisitionWorkspace(scope)).leads[0];expect(lead.score).toBe(75);expect(lead.fields.author_id.kind).toBe('NOT_RETURNED');
  expect((await query('SELECT state,credential_ref FROM kff.accounts WHERE id=$1',[account.id]))[0]).toEqual({state:'DRAFT',credential_ref:null});
  await expect(queueOutreach(scope,{request_id:randomUUID(),lead_id:lead.id,expected_version:1,environment_id:randomUUID(),action:'PRIVATE_REPLY',body:'Test only',authorization_basis:'Isolated test does not authorize contact'})).rejects.toMatchObject({code:'CONTACT_BASIS_MISSING'});
  await query("UPDATE kff.accounts SET state='DISABLED' WHERE id=$1",[account.id]);
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Disabled account remains blocked'});expect(await claimCollection()).toBeNull();
});
it('excludes old matches, keeps unknown dates for review and preserves decisions on identical rescan',async()=>{
  const {a,input}=await setup();
  const m=await createMonitor(scope,{...input,request_id:randomUUID(),discovery:{...input.discovery,max_age_days:7}});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Isolated age filter test'});
  const claim=(await claimCollection())!,page=localDiscoveryPage(claim),now=Date.now();
  page.rows[0].fields.created_time={kind:'VALUE',value:new Date(now-30*86400000).toISOString()};
  page.rows[1].fields.created_time={kind:'VALUE',value:new Date(now-86400000).toISOString()};
  page.rows[3].fields.created_time={kind:'NOT_RETURNED'};
  await commitCollectionPage(claim,page);await projectDiscoveryLeads();
  const initial=(await acquisitionWorkspace(scope)).leads;expect(initial).toHaveLength(2);
  expect(initial.some(l=>l.source_object_id===page.rows[0].source_object_id)).toBe(false);
  const recent=initial.find(l=>l.source_object_id===page.rows[1].source_object_id)!,unknown=initial.find(l=>l.source_object_id===page.rows[3].source_object_id)!;
  expect(recent.publication_age).toBe('RECENT');expect(unknown).toMatchObject({publication_age:'UNKNOWN',state:'NEW'});expect(unknown.reason).toContain('发布时间待核对');
  await expect(queueOutreach(scope,{request_id:randomUUID(),lead_id:unknown.id,expected_version:unknown.version,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Fixture only',authorization_basis:'Isolated test of missing publication time'})).rejects.toMatchObject({code:'SOURCE_TIME_UNVERIFIED'});
  const decision=await controlDiscoveryLead(scope,recent.id,{request_id:randomUUID(),expected_version:recent.version,state:'DISMISSED',reason:'Operator excludes this exact test lead'});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Identical source rescan'});
  const next=(await claimCollection())!;
  await commitCollectionPage(next,{...localDiscoveryPage(next),rows:structuredClone(page.rows)});await projectDiscoveryLeads();
  const after=(await acquisitionWorkspace(scope)).leads;expect(after).toHaveLength(2);
  expect(after.find(l=>l.id===recent.id)).toMatchObject({state:'DISMISSED',version:decision.version,reason:'Operator excludes this exact test lead'});
  expect((await query('SELECT count(*)::int n FROM kff.collection_observations'))[0].n).toBe(8);
  expect((await query('SELECT count(*)::int n FROM kff.acquisition_evaluations WHERE reason LIKE $1',['原始发布时间已超出最近 7 天%']))[0].n).toBe(2);
});
it('stores promotional observations without making them leads or automatic outreach tasks',async()=>{
  const {a,input}=await setup();
  const m=await createMonitor(scope,{...input,request_id:randomUUID(),discovery:{...input.discovery,keywords:['八字']}});
  await configureAcquisitionAutomation(scope,{request_id:randomUUID(),monitor_id:m.id,expected_version:1,enabled:true,environment_id:a.environment_id,action:'PRIVATE_REPLY',body:'Configured fixture reply',authorization_basis:'Isolated synthetic workflow authorization',min_score:70,daily_limit:5,delay_minutes:30});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:2,action:'START',reason:'Validate promotion filtering with active synthetic automation'});
  await prepareDiscoveryScan();
  const claim=(await claimCollection())!,page=localDiscoveryPage(claim);page.rows=page.rows.slice(0,2);
  page.rows[0].fields.message={kind:'VALUE',value:'想知道自己八字有什么健康问题？\n可以购买我的「八字健康」网上课程。'};
  page.rows[1].fields.message={kind:'VALUE',value:'我想购买八字咨询，请问价格多少？'};
  await commitCollectionPage(claim,page);await projectDiscoveryLeads();
  expect((await query('SELECT count(*)::int n FROM kff.collection_observations'))[0].n).toBe(2);
  const evaluations=await query('SELECT score,reason FROM kff.acquisition_evaluations ORDER BY score');
  expect(evaluations.map(row=>row.score)).toEqual([0,75]);expect(evaluations[0].reason).toContain('商家自推');
  const leads=(await acquisitionWorkspace(scope)).leads;expect(leads).toHaveLength(1);expect(leads[0].source_object_id).toBe(page.rows[1].source_object_id);
  await prepareAcquisitionAction();await prepareAcquisitionAction();
  const actions=(await acquisitionWorkspace(scope)).actions;expect(actions).toHaveLength(1);
  expect((await query("SELECT snapshot->'outreach'->>'source_object_id' source FROM kff.tasks"))[0].source).toBe(page.rows[1].source_object_id);
});
it('keeps the original manual decision reason when a later observation is screened out',async()=>{
  const {m}=await setup(),lead=(await scan(m))[0],reason='Operator reviewed this source and excluded it';
  await controlDiscoveryLead(scope,lead.id,{request_id:randomUUID(),expected_version:lead.version,state:'DISMISSED',reason});
  await controlMonitor(scope,m.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Source changed into an explicit promotional offer'});
  const claim=(await claimCollection())!,page=localDiscoveryPage(claim);page.rows=page.rows.filter(row=>row.source_object_id===lead.source_object_id);
  page.rows[0].fields.message={kind:'VALUE',value:'Buy our consultation course. Contact us to book.'};
  await commitCollectionPage(claim,page);await projectDiscoveryLeads();
  const after=(await acquisitionWorkspace(scope)).leads.find(row=>row.id===lead.id)!;
  expect(after).toMatchObject({state:'DISMISSED',score:0,reason});expect(after.observation_id).not.toBe(lead.observation_id);
  expect((await query('SELECT score FROM kff.acquisition_evaluations WHERE observation_id=$1',[lead.observation_id]))[0].score).toBe(lead.score);
  expect((await query('SELECT reason FROM kff.acquisition_evaluations WHERE observation_id=$1',[after.observation_id]))[0].reason).toContain('商家自推');
  expect((await query("SELECT count(*)::int n FROM kff.audit_events WHERE object_id=$1 AND event_type='acquisition.lead_controlled'",[lead.id]))[0].n).toBe(1);
});
