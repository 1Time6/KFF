import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool,projectRoot} from '@kff/database';
import {adapterImplementationDigest} from '../../packages/core/src/artifacts';
import {leadScope as scope,leadAgent as agent,clearLeads} from '../helpers/lead-fixture';
import {createAccount,createEnvironment} from '../../packages/core/src/service';
import {configureEnvironment} from '../../packages/core/src/environments';
import {configureBrowserInbox,controlBrowserInbox,prepareBrowserInboxPage,browserInboxWorkspace} from '../../packages/core/src/browser-inbox';
import {configureBudget} from '../../packages/core/src/costs';
import {attachLocalEvidence} from '../../packages/core/src/capabilities';
import {dispatchOne,claimCommand,agentHeartbeat} from '../../packages/core/src/execution';

// The real window stopped with VERSION_CONFLICT before any command reached the Agent. This isolated
// reproduction proves whether refreshed capability evidence (implementation digest = current adapter
// source) is what the task snapshot check needs, so a later real attempt is not spent re-discovering it.
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{await clearLeads();await query('TRUNCATE kff.browser_inbox_monitors,kff.cost_budgets CASCADE');process.env.KFF_ENABLE_BROWSER_INBOX='true';await configureBudget(scope,{request_id:randomUUID(),expected_version:0,currency:'USD',minor_unit_exponent:2,precision_source:'Isolated contract currency',limit_minor:'0',reason:'Zero-cost inbox read contract'});});
afterAll(async()=>{await closePool();});
async function environment(evidence:'NONE'|'CURRENT'|'STALE'){
 const account=await createAccount(scope,{display_name:'Digest profile',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),platform:'facebook',account_type:'profile'});
 const env=await createEnvironment(scope,{name:'Isolated digest binding - no browser call',account_id:account.id,agent_id:localIds.agent});
 await configureEnvironment(scope,env.id,{expected_version:1,configuration:{driver:'adspower',provider_profile_id:'digest-'+randomUUID(),login_account_id:account.external_id,operating_identity_id:account.external_id,locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}});
 const monitor=await configureBrowserInbox(scope,{request_id:randomUUID(),environment_id:env.id,expected_version:0,discovery:{strategy:'RECENT_ACCEPTED',max_threads:2},page_size:25});
 const capability=(await query<{id:string;implementation_digest:string|null}>("SELECT id,implementation_digest FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.inbox.read.browser'",[account.id]))[0];
 const current=adapterImplementationDigest(projectRoot,'facebook');
 if(evidence==='CURRENT'){
  await query("INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,'facebook-graph-v1','{}',1,'ISOLATED CONTRACT FIXTURE',now(),'{\"synthetic_test\":true}') ON CONFLICT DO NOTHING",[current]);
  await attachLocalEvidence(scope,capability.id);
 } else if(evidence==='STALE') await query('UPDATE kff.capabilities SET implementation_digest=$1 WHERE id=$2',['0'.repeat(64),capability.id]);
 const scan=await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:monitor.version,action:'SCAN'});
 return {account,monitor:scan,current,digest:(await query<{implementation_digest:string|null}>('SELECT implementation_digest FROM kff.capabilities WHERE id=$1',[capability.id]))[0].implementation_digest};
}
async function dispatch(){
 await agentHeartbeat(agent);
 const task=await prepareBrowserInboxPage();
 if(!task)return {task:null,dispatched:false,command:null};
 const dispatched=await dispatchOne();
 const command=await claimCommand(agent);
 return {task,dispatched,command};
}
it('stale capability evidence blocks the inbox command before the Agent can claim it',async()=>{
 const h=await environment('STALE');expect(h.digest).toBe('0'.repeat(64));
 const result=await dispatch();
 // The scheduler refuses to queue the page at all, and the monitor records the real failure code.
 expect(result.task).toBeNull();expect(result.dispatched).toBe(false);expect(result.command).toBeNull();
 expect(['VERSION_CONFLICT','CAPABILITY_UNASSESSED']).toContain((await query<{last_error_code:string|null}>('SELECT last_error_code FROM kff.browser_inbox_monitors WHERE id=$1',[h.monitor.id]))[0].last_error_code);
 expect((await query('SELECT id FROM kff.agent_commands')).length).toBe(0);
});
it('current capability evidence lets the same inbox command reach the Agent',async()=>{
 const h=await environment('CURRENT');expect(h.digest).toBe(h.current);
 const result=await dispatch();
 expect(result.command).not.toBeNull();
 expect(result.command!.snapshot.implementation_digest).toBe(h.current);
 expect((await query<{state:string}>('SELECT state FROM kff.actions WHERE task_id=$1',[result.task!.id]))[0].state).not.toBe('BLOCKED');
});
