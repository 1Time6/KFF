import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool,scoped} from '@kff/database';
import {leadScope as scope,clearLeads} from '../helpers/lead-fixture';
import {connectApifySource,importApifyDataset,controlProviderProspect} from '../../packages/core/src/acquisition-provider';
import {createAccount,createEnvironment} from '../../packages/core/src/service';
import {configureEnvironment} from '../../packages/core/src/environments';
import {prepareProviderBrowserVerification} from '../../packages/core/src/provider-verification';
import {acquisitionWorkspace} from '../../packages/core/src/acquisition';
import type {ApifyDataset} from '../../packages/adapters/src/apify-dataset';
const owner='u'.repeat(17),sourceUrl='https://www.facebook.com/reel/123456/';
beforeAll(async()=>{await migrate();await seed();});beforeEach(async()=>{await clearLeads();await query('TRUNCATE kff.acquisition_sources,kff.acquisition_monitors CASCADE');vi.stubEnv('APIFY_USER_ID',owner);vi.stubEnv('APIFY_API_TOKEN','isolated-test-token-123');});afterAll(async()=>{vi.unstubAllEnvs();await closePool();});
async function setup(){
 const source=await connectApifySource(scope,(async()=>Response.json({data:{id:owner,username:'isolated-source'}})) as typeof fetch);
 const data:ApifyDataset={owner_id:owner,run_id:'c'.repeat(17),actor_id:'a'.repeat(17),dataset_id:'d'.repeat(17),kind:'FACEBOOK_COMMENTS',finished_at:new Date().toISOString(),usage_usd:0,input:{startUrls:[{url:sourceUrl}]},rows:[{commentId:'9876',text:'I need help with BaZi',profileId:'4567',profileName:'Isolated source',profileUrl:'https://www.facebook.com/4567/',commentUrl:sourceUrl+'?comment_id=9876',inputUrl:sourceUrl,date:new Date().toISOString()}]};
 await importApifyDataset(scope,{request_id:randomUUID(),source_id:source.id,run_id:data.run_id,kind:data.kind},async()=>data);
 const prospect=(await query('SELECT id,version FROM kff.acquisition_prospects WHERE source_id=$1',[source.id]))[0];
 const account=await createAccount(scope,{display_name:'Isolated verification account',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),platform:'facebook',account_type:'profile'});
 const environment=await createEnvironment(scope,{name:'Isolated AdsPower, no provider calls',account_id:account.id,agent_id:localIds.agent});
 await configureEnvironment(scope,environment.id,{expected_version:1,configuration:{driver:'adspower',provider_profile_id:'test-'+randomUUID(),login_account_id:account.external_id,operating_identity_id:account.external_id,locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}});
 const value={request_id:randomUUID(),expected_version:prospect.version,account_id:account.id,environment_id:environment.id,comment_order:'VISIBLE_WINDOW'};
 return {source,prospect,account,environment,value};
}
async function qualify(h:Awaited<ReturnType<typeof setup>>){const reviewed=await controlProviderProspect(scope,h.prospect.id,{request_id:randomUUID(),expected_version:h.prospect.version,state:'QUALIFIED',reason:'Isolated human review, no real outreach'});return {...h,value:{...h.value,expected_version:reviewed.version}};}
it('flows a reviewed provider comment into one paused original browser monitor while preserving source and customer state',async()=>{
 const h=await qualify(await setup()),counts=(await query("SELECT (SELECT count(*)::int FROM kff.customers) customers,(SELECT count(*)::int FROM kff.tasks) tasks"))[0];
 const [a,b]=await Promise.all([prepareProviderBrowserVerification(scope,h.prospect.id,h.value),prepareProviderBrowserVerification(scope,h.prospect.id,h.value)]);expect(a.monitor_id).toBe(b.monitor_id);expect(a).toMatchObject({status:'PAUSED_REVIEW_SOURCE',read_queued:false,source_comment_id:'9876',prospect_version:2});
 const monitor=(await query('SELECT * FROM kff.acquisition_monitors WHERE id=$1',[a.monitor_id]))[0];expect(monitor.state).toBe('PAUSED');expect(monitor.config).toMatchObject({account_id:h.account.id,max_pages:1,max_records:10,discovery:{provider:'LOCAL_BROWSER',target:sourceUrl,browser:{environment_id:h.environment.id,template:'facebook-comments-dom-v1',comment_order:'VISIBLE_WINDOW'}}});
 expect((await query("SELECT (SELECT count(*)::int FROM kff.customers) customers,(SELECT count(*)::int FROM kff.tasks) tasks"))[0]).toEqual(counts);expect(await query('SELECT id FROM kff.acquisition_scans WHERE monitor_id=$1',[monitor.id])).toHaveLength(0);
 const view=await acquisitionWorkspace(scope);expect(view.candidates.record_count).toBe(1);expect(view.candidates.groups[0].records[0]).toMatchObject({origin:'PROSPECT',state:'QUALIFIED',can_prepare_public_reply:false});
 expect(await scoped(scope,c=>c.query("SELECT id FROM kff.audit_events WHERE event_type='acquisition.provider_verification_prepared' AND object_id=$1",[monitor.id])).then(r=>r.rowCount)).toBe(1);
});
it('requires current human review and never infers a read or send from an expired, ignored or foreign source',async()=>{
 const h=await setup();await expect(prepareProviderBrowserVerification(scope,h.prospect.id,h.value)).rejects.toMatchObject({code:'SOURCE_NOT_QUALIFIED'});
 const q=await qualify(h);await expect(prepareProviderBrowserVerification({...scope,role:'viewer'},q.prospect.id,q.value)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
 await expect(prepareProviderBrowserVerification({...scope,brand_id:randomUUID()},q.prospect.id,q.value)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await expect(prepareProviderBrowserVerification(scope,q.prospect.id,{...q.value,environment_id:randomUUID()})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
 await query("UPDATE kff.acquisition_prospects SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[q.prospect.id]);await expect(prepareProviderBrowserVerification(scope,q.prospect.id,q.value)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 expect(await query('SELECT id FROM kff.acquisition_monitors')).toHaveLength(0);
});
it('keeps request replay exact and rejects unsupported source shapes without opening a browser',async()=>{
 const h=await qualify(await setup());const first=await prepareProviderBrowserVerification(scope,h.prospect.id,h.value);expect(await prepareProviderBrowserVerification(scope,h.prospect.id,h.value)).toEqual(first);
 await expect(prepareProviderBrowserVerification(scope,h.prospect.id,{...h.value,comment_order:'NEWEST'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await query("UPDATE kff.acquisition_prospects SET parent_url='https://www.facebook.com/watch/?v=123456',version=version+1 WHERE id=$1",[h.prospect.id]);
 await expect(prepareProviderBrowserVerification(scope,h.prospect.id,{...h.value,request_id:randomUUID(),expected_version:3})).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});
 expect(await query('SELECT id FROM kff.acquisition_monitors')).toHaveLength(1);
});
