import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool,projectRoot,scoped} from '@kff/database';
import type {AgentCommand,ActionReport,Task} from '@kff/contracts';
import {digest} from '@kff/core';
import {leadScope as scope,leadAgent as agent,clearLeads} from '../helpers/lead-fixture';
import {createAccount,createEnvironment,approveTask,enqueueTask} from '../../packages/core/src/service';
import {configureEnvironment} from '../../packages/core/src/environments';
import {createMonitor,controlMonitor,projectDiscoveryLeads,controlDiscoveryLead,queueOutreach,outreachSubmissionGate} from '../../packages/core/src/acquisition';
import {prepareBrowserCollectionPage,syncBrowserCollectionTasks} from '../../packages/core/src/browser-collections';
import {configureBudget} from '../../packages/core/src/costs';
import {attachLocalEvidence} from '../../packages/core/src/capabilities';
import {adapterImplementationDigest} from '../../packages/core/src/artifacts';
import * as artifacts from '../../packages/core/src/artifacts';
import {createPermit} from '../../packages/core/src/permits';
import {dispatchOne,claimCommand,acceptReport,agentHeartbeat,beginSubmission} from '../../packages/core/src/execution';
import {recordQuiescence} from '../../packages/core/src/reconciliation';
import {taskSnapshotSchema} from '@kff/contracts';
import {configureBrowserInbox,controlBrowserInbox,prepareBrowserInboxPage,syncBrowserInboxTasks} from '../../packages/core/src/browser-inbox';
import {conversationReception} from '../../packages/core/src/lead-reception';

const previous={discovery:process.env.KFF_ENABLE_DISCOVERY,live:process.env.KFF_ENABLE_LIVE};
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{await clearLeads();await query('TRUNCATE kff.browser_inbox_monitors,kff.acquisition_monitors,kff.collection_queries,kff.collection_objects,kff.cost_budgets CASCADE');process.env.KFF_ENABLE_DISCOVERY='true';process.env.KFF_ENABLE_LIVE='false';await configureBudget(scope,{request_id:randomUUID(),expected_version:0,currency:'USD',minor_unit_exponent:2,precision_source:'Isolated contract currency',limit_minor:'0',reason:'Isolated public comment tests; no browser or platform calls'});});
afterAll(async()=>{for(const [key,value] of [['KFF_ENABLE_DISCOVERY',previous.discovery],['KFF_ENABLE_LIVE',previous.live]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}await closePool();});
async function close(command:AgentCommand){await recordQuiescence(agent,command.id,{protocol_version:'kff.guardian-closure.v1',command_id:command.id,action_id:command.action_id,closed_at:new Date().toISOString(),proof_sha256:'d'.repeat(64)});await syncBrowserCollectionTasks();}
async function setup(){
  const account=await createAccount(scope,{display_name:'Isolated public reply account',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),platform:'facebook',account_type:'profile'});
  const environment=await createEnvironment(scope,{name:'Isolated AdsPower contract',account_id:account.id,agent_id:localIds.agent});
  await configureEnvironment(scope,environment.id,{expected_version:1,configuration:{driver:'adspower',provider_profile_id:'contract-'+randomUUID(),login_account_id:account.external_id,operating_identity_id:account.external_id,locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}});
  const monitor=await createMonitor(scope,{request_id:randomUUID(),title:'Isolated controlled Reel',account_id:account.id,discovery:{platform:'facebook',strategy:'COMMENTS',provider:'LOCAL_BROWSER',browser:{environment_id:environment.id,template:'facebook-comments-dom-v1'},target:'https://www.facebook.com/reel/123456/',keywords:['help'],processing_basis:'Isolated local contract only; no live source.'},interval_minutes:60,max_records:2,max_pages:1,page_size:2,retention_days:1});
  const hash=adapterImplementationDigest(projectRoot,'facebook');await query("INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,'facebook-graph-v1','{}',1,'ISOLATED CONTRACT FIXTURE',now(),'{\"synthetic_test\":true}') ON CONFLICT DO NOTHING",[hash]);
  const cap=(await query("SELECT id FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.discovery.read.browser'",[account.id]))[0];await attachLocalEvidence(scope,cap.id);
  await controlMonitor(scope,monitor.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Bounded contract read only'});await agentHeartbeat(agent);await prepareBrowserCollectionPage();await dispatchOne();const read=(await claimCommand(agent))!;expect(read).not.toBeNull();
  const request=read.snapshot.collection!,sourceId='facebook:comment:000999',sourceUrl=monitor.config.discovery.target+'?comment_id=000999';
  const page={schema_version:'kff.collection-page.v1' as const,source_key:'social.discovery' as const,source_version:'social-discovery-v1' as const,query_id:request.query_id,account_external_id:account.external_id,cursor:null,next_cursor:null,observed_at:new Date().toISOString(),reported_total:null,coverage:'BROWSER_VISIBLE_ONLY' as const,rows:[{source_object_id:sourceId,source_url:sourceUrl,fields:{message:{kind:'VALUE' as const,value:'I need help with BaZi'},author_id:{kind:'VALUE' as const,value:'9912345678'},created_time:{kind:'DISPLAYED_TIME' as const,value:'刚刚'},reaction_count:{kind:'NOT_RETURNED' as const},comment_count:{kind:'NOT_RETURNED' as const}}}]};
  await acceptReport(agent,{event_id:randomUUID(),command_id:read.id,outcome:'VERIFIED_SUCCEEDED',collection_page:page,receipt:{remote_id:'collection:'+request.run_id+':1',actual_account_id:account.external_id,content_hash:digest(page),observed_at:page.observed_at,evidence_kind:'browser_dom'},diagnostic:{step:'isolated-contract-only'}});await close(read);await projectDiscoveryLeads();
  const lead=(await query('SELECT * FROM kff.acquisition_leads WHERE monitor_id=$1',[monitor.id]))[0];expect(lead).toBeDefined();
  const qualified=await controlDiscoveryLead(scope,lead.id,{request_id:randomUUID(),expected_version:lead.version,state:'QUALIFIED',reason:'Isolated reviewer accepted this fixture'});
  const input={request_id:randomUUID(),lead_id:lead.id,expected_version:qualified.version,environment_id:environment.id,action:'COMMENT_REPLY' as const,body:'A reviewed public reply for this isolated test.',authorization_basis:'Only this isolated public comment, no real contact.',delay_minutes:0,expires_at:new Date(Date.now()+1200000).toISOString()};
  return {account,environment,monitor,read,lead:qualified,input,sourceUrl};
}
async function prepare(h:Awaited<ReturnType<typeof setup>>){const result=await queueOutreach(scope,h.input) as {task_id:string;status:string};const task=(await query<Task>('SELECT * FROM kff.tasks WHERE id=$1',[result.task_id]))[0];await attachLocalEvidence(scope,task.capability_id);return task;}
const permit=(id:string)=>({task_id:id,max_actions:1,starts_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),currency:'USD',max_cost_minor:'0',per_action_max_minor:'0',cost_basis:'Isolated local test, no paid or platform request.',authorization_evidence:'This exact isolated task is approved for a contract test.',platform_conditions:'Mock acceptance only; no browser, no real permission.',expected_evidence:'message_acceptance' as const,stop_rule:'stop_on_first_unknown_or_failure' as const,confirmation:'I_CONFIRM_THIS_EXACT_SCOPE' as const});
async function approved(h:Awaited<ReturnType<typeof setup>>){const task=await prepare(h);await approveTask(scope,task.id,{snapshot_hash:task.snapshot_hash,decision:'APPROVED'});await createPermit(scope,permit(task.id));return task;}
async function commandFor(h:Awaited<ReturnType<typeof setup>>){const task=await approved(h);process.env.KFF_ENABLE_LIVE='true';await enqueueTask(scope,task.id);await agentHeartbeat(agent);await dispatchOne();const command=(await claimCommand(agent))!;expect(command).not.toBeNull();return {...command,task_id:task.id};}
function replyReport(command:AgentCommand):ActionReport{const source=command.snapshot.outreach!.browser!;return {event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:'000777',parent_id:source.comment_id,source_url:source.comment_url+'&reply_comment_id=000777',recipient_id:command.snapshot.outreach!.author_id,actual_account_id:command.snapshot.external_account_id,content_hash:command.snapshot.content_hash,evidence_kind:'browser_comment',observed_at:new Date().toISOString()},diagnostic:{step:'isolated-comment-contract'}};}

async function readIncoming(h:Awaited<ReturnType<typeof setup>>,peer='9912345678') {
  const previous=process.env.KFF_ENABLE_BROWSER_INBOX;process.env.KFF_ENABLE_BROWSER_INBOX='true';
  try{
    const existing=(await query('SELECT version FROM kff.browser_inbox_monitors WHERE account_id=$1',[h.account.id]))[0];
    const thread=BigInt('0x'+randomUUID().replaceAll('-','')).toString();
    const monitor=await configureBrowserInbox(scope,{request_id:randomUUID(),environment_id:h.environment.id,expected_version:existing?.version??0,target:{thread_id:thread,peer_id:peer,display_name:'Same display name'},page_size:25});
    const cap=(await query("SELECT id FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.inbox.read.browser'",[h.account.id]))[0];await attachLocalEvidence(scope,cap.id);
    await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:monitor.version,action:'SCAN'});await agentHeartbeat(agent);expect(await prepareBrowserInboxPage()).not.toBeNull();expect(await dispatchOne()).toBe(true);const command=(await claimCommand(agent))!;
    const page={monitor_id:monitor.id,cursor:null,next_cursor:null,has_more:false,batch:{schema_version:'kff.browser-inbox-batch.v1' as const,login_account_id:h.account.external_id,operating_identity_id:h.account.external_id,observed_at:new Date().toISOString(),coverage:'VISIBLE_MESSAGES_ONLY' as const,messages:[{message_id:'trace.'+randomUUID(),thread_id:thread,peer_id:peer,thread_kind:'UNVERIFIED' as const,direction:'INBOUND' as const,body:'An independently received inquiry.',display_name:'Same display name',occurred_at:null,displayed_time:'刚刚',has_attachment:false,source_url:'https://www.facebook.com/messages/e2ee/t/'+thread+'/'}]}};
    await acceptReport(agent,{event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',inbox_page:page,receipt:{remote_id:'inbox:'+monitor.id+':'+command.snapshot.inbox!.token,actual_account_id:h.account.external_id,content_hash:digest(page),observed_at:page.batch.observed_at,evidence_kind:'browser_dom'},diagnostic:{step:'isolated-trace-inbound-contract'}});
    await close(command);await syncBrowserInboxTasks();
    return (await query('SELECT v.id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1 AND i.remote_id=$2',[h.account.id,thread]))[0].id as string;
  }finally{if(previous===undefined)delete process.env.KFF_ENABLE_BROWSER_INBOX;else process.env.KFF_ENABLE_BROWSER_INBOX=previous;}
}

it('creates an immutable reviewable draft with source text, displayed time and no Messenger contact or send',async()=>{
  const h=await setup(),task=await prepare(h);expect(task.status).toBe('DRAFT');expect(task.snapshot).toMatchObject({capability_key:'facebook.comment.reply.browser',adapter_version:'facebook-browser-comment-v1',credential_ref:null,platform_api_version:null,outreach:{action:'COMMENT_REPLY',source_object_id:'facebook:comment:000999',browser:{comment_url:h.sourceUrl,displayed_time:'刚刚',source_body:'I need help with BaZi'}}});
  expect(task.snapshot.message).toBeUndefined();expect(task.snapshot.outreach!.occurred_at).toBeUndefined();
  expect((await queueOutreach(scope,h.input) as {task_id:string}).task_id).toBe(task.id);
  expect((await query('SELECT count(*)::int n FROM kff.approval_decisions WHERE task_id=$1',[task.id]))[0].n).toBe(0);
  await expect(enqueueTask(scope,task.id)).rejects.toMatchObject({code:'APPROVAL_STALE'});
  await expect(createPermit(scope,permit(task.id))).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
  await expect(query("UPDATE kff.tasks SET snapshot=jsonb_set(snapshot,'{body}','\"changed\"') WHERE id=$1",[task.id])).rejects.toThrow('IMMUTABLE_TASK_SNAPSHOT');
  expect((await query('SELECT count(*)::int n FROM kff.conversations'))[0].n).toBe(0);
  expect(taskSnapshotSchema.safeParse({...task.snapshot,outreach:{...task.snapshot.outreach,action:'PRIVATE_REPLY'}}).success).toBe(false);
});
it('rejects foreign environments, private reply, unreviewed leads and expired preparation',async()=>{
  const h=await setup();await expect(queueOutreach(scope,{...h.input,action:'PRIVATE_REPLY'})).rejects.toMatchObject({code:'CONTACT_BASIS_MISSING'});
  await expect(queueOutreach(scope,{...h.input,environment_id:randomUUID()})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(queueOutreach(scope,{...h.input,expires_at:new Date(Date.now()-1000).toISOString()})).rejects.toMatchObject({code:'CONTACT_WINDOW_CLOSED'});
  const changed=await controlDiscoveryLead(scope,h.lead.id,{request_id:randomUUID(),expected_version:h.lead.version,state:'NEW',reason:'Return to manual review'});
  await expect(queueOutreach(scope,{...h.input,expected_version:changed.version})).rejects.toMatchObject({code:'CONTACT_BLOCKED'});
  await expect(queueOutreach({...scope,brand_id:randomUUID()},h.input)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
});
it('requires explicit draft replacement and retains both snapshots without permitting replacement after approval',async()=>{
  const h=await setup(),first=await prepare(h);await expect(queueOutreach(scope,{...h.input,request_id:randomUUID()})).rejects.toMatchObject({code:'OUTREACH_ALREADY_EXISTS'});
  const replacement={...h.input,request_id:randomUUID(),replaces_task_id:first.id,body:'Updated reviewed content.'};
  const second=await queueOutreach(scope,replacement) as {task_id:string};
  expect(await queueOutreach(scope,replacement)).toEqual(second);
  expect((await query('SELECT status FROM kff.tasks WHERE id=$1',[first.id]))[0].status).toBe('REJECTED');
  expect((await query('SELECT count(*)::int n FROM kff.acquisition_action_links WHERE lead_id=$1',[h.lead.id]))[0].n).toBe(2);
  const row=(await query<Task>('SELECT * FROM kff.tasks WHERE id=$1',[second.task_id]))[0];await approveTask(scope,row.id,{snapshot_hash:row.snapshot_hash,decision:'APPROVED'});
  await expect(queueOutreach(scope,{...h.input,request_id:randomUUID(),replaces_task_id:row.id})).rejects.toMatchObject({code:'OUTREACH_ALREADY_EXISTS'});
});

it('rebuilds a closed unsubmitted locator failure only after an implementation change and requires new approval',async()=>{
  const h=await setup(),command=await commandFor(h);
  await acceptReport(agent,{event_id:randomUUID(),command_id:command.id,outcome:'BLOCKED',error_code:'BROWSER_LOCATOR_AMBIGUOUS',diagnostic:{step:'fixture-before-submit'}});await close(command);
  const replacement={...h.input,request_id:randomUUID(),replaces_task_id:command.task_id};
  await expect(queueOutreach(scope,replacement)).rejects.toMatchObject({code:'OUTREACH_ALREADY_EXISTS'});
  const changed=vi.spyOn(artifacts,'adapterImplementationDigest').mockReturnValue('e'.repeat(64));
  try{const next=await queueOutreach(scope,replacement) as {task_id:string};expect(await queueOutreach(scope,replacement)).toEqual(next);
    expect((await query('SELECT status FROM kff.tasks WHERE id=$1',[command.task_id]))[0].status).toBe('FAILED');
    expect((await query('SELECT status,snapshot FROM kff.tasks WHERE id=$1',[next.task_id]))[0]).toMatchObject({status:'DRAFT',snapshot:{implementation_digest:'e'.repeat(64)}});
    expect((await query('SELECT revoked_at FROM kff.pilot_permits WHERE task_id=$1',[command.task_id]))[0].revoked_at).not.toBeNull();
    expect(await query('SELECT id FROM kff.actions WHERE task_id=$1',[next.task_id])).toEqual([]);
    expect((await query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='acquisition.failed_preparation_superseded'",[command.task_id]))[0].details).toMatchObject({submitted:false,closure_verified:true});
  }finally{changed.mockRestore();}
});

for(const condition of ['open-command','missing-proof','submission-intent','login-challenge'])it('refuses failed preparation replacement with '+condition,async()=>{
  const h=await setup(),command=await commandFor(h);
  await acceptReport(agent,{event_id:randomUUID(),command_id:command.id,outcome:'BLOCKED',error_code:condition==='login-challenge'?'LOGIN_CHALLENGE':'BROWSER_LOCATOR_AMBIGUOUS',diagnostic:{step:'fixture-before-submit'}});
  if(condition!=='open-command')await close(command);
  if(condition==='missing-proof')await query("DELETE FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'",[command.id]);
  if(condition==='submission-intent')await query('UPDATE kff.action_attempts SET submitted_at=clock_timestamp() WHERE action_id=$1',[command.action_id]);
  const changed=vi.spyOn(artifacts,'adapterImplementationDigest').mockReturnValue('e'.repeat(64));
  try{await expect(queueOutreach(scope,{...h.input,request_id:randomUUID(),replaces_task_id:command.task_id})).rejects.toMatchObject({code:'OUTREACH_ALREADY_EXISTS'});}finally{changed.mockRestore();}
});
it('keeps the one-action permit, live switch and original submit-once protocol',async()=>{
  const h=await setup(),task=await approved(h);await expect(enqueueTask(scope,task.id)).rejects.toMatchObject({code:'LIVE_DISABLED'});
  await expect(createPermit(scope,{...permit(task.id),max_actions:2})).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
  await expect(createPermit(scope,{...permit(task.id),expires_at:new Date(Date.now()+1500000).toISOString()})).rejects.toMatchObject({code:'CONTACT_WINDOW_CLOSED'});
  process.env.KFF_ENABLE_LIVE='true';await enqueueTask(scope,task.id);await dispatchOne();const command=(await claimCommand(agent))!;expect(command).not.toBeNull();
  await expect(acceptReport(agent,replyReport(command))).rejects.toMatchObject({code:'SUBMISSION_UNCERTAIN'});
  await beginSubmission(agent,command.id);await expect(beginSubmission(agent,command.id)).rejects.toMatchObject({code:'SUBMISSION_UNCERTAIN'});
  const report=replyReport(command);await expect(acceptReport(agent,{...report,receipt:{...report.receipt!,source_url:h.sourceUrl+'&reply_comment_id=777'}})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(acceptReport(agent,{...report,receipt:{...report.receipt!,actual_account_id:'999'}})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(acceptReport(agent,{...report,receipt:{...report.receipt!,evidence_kind:'browser_message'}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await acceptReport(agent,report);await acceptReport(agent,report);await close(command);
  expect((await query('SELECT count(*)::int n FROM kff.action_attempts WHERE action_id=$1',[command.action_id]))[0].n).toBe(1);
  expect((await query('SELECT access_path,reserved_actions FROM kff.pilot_permits WHERE task_id=$1',[task.id]))[0]).toEqual({access_path:'browser_comment',reserved_actions:1});
});
it('blocks the original command when a lead opts out after preparation and before submit',async()=>{
  const h=await setup(),command=await commandFor(h);await controlDiscoveryLead(scope,h.lead.id,{request_id:randomUUID(),expected_version:h.lead.version,state:'OPTED_OUT',reason:'Isolated recipient withdraws'});
  await expect(beginSubmission(agent,command.id)).rejects.toMatchObject({code:'OUTREACH_STALE'});
  expect((await query('SELECT count(*)::int n FROM kff.action_attempts WHERE action_id=$1 AND submitted_at IS NOT NULL',[command.action_id]))[0].n).toBe(0);
});
it('refuses modified source, expired scope and a closed identity prerequisite',async()=>{
  const h=await setup(),task=await prepare(h);await approveTask(scope,task.id,{snapshot_hash:task.snapshot_hash,decision:'APPROVED'});
  const expired=structuredClone(task.snapshot);expired.outreach!.browser!.expires_at=new Date(Date.now()-1).toISOString();
  await expect(scoped(scope,client=>outreachSubmissionGate(client,expired))).rejects.toMatchObject({code:'CONTACT_WINDOW_CLOSED'});
  const wrong=structuredClone(task.snapshot);wrong.outreach!.browser!.comment_url='https://www.facebook.com/reel/999/?comment_id=000999';
  await expect(scoped(scope,client=>outreachSubmissionGate(client,wrong))).rejects.toMatchObject({code:'OUTREACH_STALE'});
  await query('UPDATE kff.agent_commands SET quiesced_at=NULL WHERE id=$1',[h.read.id]);await expect(createPermit(scope,permit(task.id))).rejects.toMatchObject({code:'ACCOUNT_UNVERIFIED'});
});

it('shows a same-profile public interaction only after verified receipt and closure without granting reception permission',async()=>{
  const h=await setup(),conversation=await readIncoming(h),command=await commandFor(h);
  expect((await conversationReception(scope,conversation)).public_interactions).toEqual([]);
  await beginSubmission(agent,command.id);
  expect((await conversationReception(scope,conversation)).public_interactions).toEqual([]);
  await acceptReport(agent,replyReport(command));
  expect((await conversationReception(scope,conversation)).public_interactions).toEqual([]);
  await close(command);
  const detail=await conversationReception(scope,conversation);
  expect(detail.public_interactions).toHaveLength(1);
  expect(detail.public_interactions[0]).toMatchObject({run_id:command.run_id,action_id:command.action_id,lead_id:h.lead.id,peer_id:'9912345678',source_body:'I need help with BaZi',source_url:h.sourceUrl,reply_body:h.input.body,reply_url:h.sourceUrl+'&reply_comment_id=000777'});
  expect(new Date(detail.public_interactions[0].first_inbox_at).getTime()).toBeLessThanOrEqual(Date.parse(detail.public_interactions[0].verified_at));
  expect(detail.manual_permissions).toEqual([]);expect(detail.referrals).toEqual([]);
  expect((await query('SELECT v.handling_mode,v.reply_window_expires_at,m.contact_permission_id FROM kff.conversations v JOIN kff.messages m ON m.conversation_id=v.id WHERE v.id=$1',[conversation]))[0]).toEqual({handling_mode:'HUMAN',reply_window_expires_at:null,contact_permission_id:null});
});
it('keeps same-name and cross-account conversations out of the public interaction trace and enforces brand scope',async()=>{
  const h=await setup(),command=await commandFor(h);await beginSubmission(agent,command.id);await acceptReport(agent,replyReport(command));await close(command);
  const wrongPeer=await readIncoming(h,'9912345679');expect((await conversationReception(scope,wrongPeer)).public_interactions).toEqual([]);
  const other=await setup(),otherConversation=await readIncoming(other);expect((await conversationReception(scope,otherConversation)).public_interactions).toEqual([]);
  await expect(conversationReception({...scope,brand_id:randomUUID()},otherConversation)).rejects.toMatchObject({code:'NOT_FOUND'});
});
