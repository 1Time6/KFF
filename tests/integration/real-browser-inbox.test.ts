import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool,projectRoot} from '@kff/database';
import type {AgentCommand,ActionReport} from '@kff/contracts';
import {digest} from '@kff/core';
import {leadScope as scope,leadAgent as agent,clearLeads} from '../helpers/lead-fixture';
import {createAccount,createEnvironment,createTask} from '../../packages/core/src/service';
import {configureEnvironment} from '../../packages/core/src/environments';
import {configureBrowserInbox,controlBrowserInbox,prepareBrowserInboxPage,syncBrowserInboxTasks,browserInboxWorkspace} from '../../packages/core/src/browser-inbox';
import {configureBudget} from '../../packages/core/src/costs';
import {attachLocalEvidence} from '../../packages/core/src/capabilities';
import {adapterImplementationDigest} from '../../packages/core/src/artifacts';
import {dispatchOne,claimCommand,acceptReport,agentHeartbeat} from '../../packages/core/src/execution';
import {recordQuiescence} from '../../packages/core/src/reconciliation';
import {configureFacebook} from '../../packages/core/src/facebook-inbound';
import {requestReceptionDraft} from '../../packages/core/src/reception-drafts';

const original=process.env.KFF_ENABLE_BROWSER_INBOX;
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{await clearLeads();await query('TRUNCATE kff.browser_inbox_monitors,kff.cost_budgets CASCADE');process.env.KFF_ENABLE_BROWSER_INBOX='true';await configureBudget(scope,{request_id:randomUUID(),expected_version:0,currency:'USD',minor_unit_exponent:2,precision_source:'Isolated contract currency',limit_minor:'0',reason:'Zero-cost inbox read contract'});});
afterAll(async()=>{if(original===undefined)delete process.env.KFF_ENABLE_BROWSER_INBOX;else process.env.KFF_ENABLE_BROWSER_INBOX=original;await closePool();});
async function setup(attach=true,discovery=false,maxThreads=2){
  const account=await createAccount(scope,{display_name:'Contract profile',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),platform:'facebook',account_type:'profile'});
  const environment=await createEnvironment(scope,{name:'Isolated AdsPower binding - no browser call',account_id:account.id,agent_id:localIds.agent});
  await configureEnvironment(scope,environment.id,{expected_version:1,configuration:{driver:'adspower',provider_profile_id:'contract-'+randomUUID(),login_account_id:account.external_id,operating_identity_id:account.external_id,locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}});
  const monitor=await configureBrowserInbox(scope,{request_id:randomUUID(),environment_id:environment.id,expected_version:0,...(discovery?{discovery:{strategy:'RECENT_ACCEPTED',max_threads:maxThreads}}:{target:{thread_id:'123456',peer_id:'987654',display_name:'Contract sender'}}),page_size:25});
  const capability=(await query("SELECT * FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.inbox.read.browser'",[account.id]))[0];
  if(attach){const hash=adapterImplementationDigest(projectRoot,'facebook');await query("INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,'facebook-graph-v1','{}',1,'ISOLATED CONTRACT FIXTURE',now(),'{\"synthetic_test\":true}') ON CONFLICT DO NOTHING",[hash]);await attachLocalEvidence(scope,capability.id);}
  const scan=await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:monitor.version,action:'SCAN'});
  return {account,environment,capability,monitor:scan};
}
async function next(){await agentHeartbeat(agent);const task=await prepareBrowserInboxPage();expect(task).not.toBeNull();expect(await dispatchOne()).toBe(true);const command=await claimCommand(agent);expect(command).not.toBeNull();return command!;}
function report(command:AgentCommand):ActionReport{
  const request=command.snapshot.inbox!,target=request.binding.target??{thread_id:'123456',peer_id:'987654',display_name:'Contract sender'};
  const inbox_page={monitor_id:request.monitor_id,cursor:null,next_cursor:null,has_more:false,batch:{schema_version:'kff.browser-inbox-batch.v1' as const,login_account_id:command.snapshot.external_account_id,operating_identity_id:command.snapshot.external_account_id,observed_at:new Date().toISOString(),coverage:'VISIBLE_MESSAGES_ONLY' as const,messages:[{message_id:'contract-id.1',thread_id:target.thread_id,peer_id:target.peer_id,thread_kind:'UNVERIFIED' as const,direction:'INBOUND' as const,body:'Contract incoming',display_name:target.display_name,occurred_at:null,displayed_time:'11:59',has_attachment:false,source_url:'https://www.facebook.com/messages/e2ee/t/'+target.thread_id+'/'}]}};
  return {event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',inbox_page,receipt:{remote_id:'inbox:'+request.monitor_id+':'+request.token,actual_account_id:command.snapshot.external_account_id,content_hash:digest(inbox_page),evidence_kind:'browser_dom',observed_at:inbox_page.batch.observed_at},diagnostic:{step:'isolated-contract-only'}};
}
function directoryReport(command:AgentCommand):ActionReport{
 const value=report(command),page=value.inbox_page!,first=page.batch.messages[0],second={...first,message_id:'contract-id.2',thread_id:'123457',peer_id:'987655',display_name:'Other sender',source_url:'https://www.facebook.com/messages/e2ee/t/123457/'};
 page.batch.messages.push(second);page.discovery={strategy:'RECENT_ACCEPTED',visible_threads:2,unparsed_rows:0,threads:page.batch.messages.map(m=>({thread_id:m.thread_id,peer_id:m.peer_id,display_name:m.display_name!})),skipped:[],window_limited:false,empty_list:false};value.receipt!.content_hash=digest(page);return value;
}
async function close(command:AgentCommand){await recordQuiescence(agent,command.id,{protocol_version:'kff.guardian-closure.v1',command_id:command.id,action_id:command.action_id,closed_at:new Date().toISOString(),proof_sha256:'c'.repeat(64)});await syncBrowserInboxTasks();}
it('uses original read permits and closure gates, stores unknown dates as null, and deduplicates changed time labels',async()=>{
  const h=await setup(),command=await next();
  expect(command.snapshot).toMatchObject({mode:'CONTROLLED_PILOT',capability_key:'facebook.inbox.read.browser',platform_api_version:null,credential_ref:null});
  expect((await query('SELECT access_path,expected_evidence FROM kff.pilot_permits WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[command.action_id]))[0]).toEqual({access_path:'browser_read',expected_evidence:'inbox_page'});
  await acceptReport(agent,report(command));await syncBrowserInboxTasks();expect(await prepareBrowserInboxPage()).toBeNull();await close(command);
  const messages=await query('SELECT m.client_sent_at,m.contact_permission_id,m.source,v.handling_mode,v.reply_window_expires_at FROM kff.messages m JOIN kff.conversations v ON v.id=m.conversation_id WHERE v.account_id=$1',[h.account.id]);
  expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({client_sent_at:null,contact_permission_id:null,handling_mode:'HUMAN',reply_window_expires_at:null,source:{displayed_time:'11:59',thread_kind:'UNVERIFIED'}});
  await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:h.monitor.version,action:'SCAN'});const again=await next(),second=report(again);second.inbox_page!.batch.messages[0].displayed_time='昨天 11:59';second.receipt!.content_hash=digest(second.inbox_page);await acceptReport(agent,second);await close(again);
  expect((await query('SELECT sum(stored)::int AS stored,sum(duplicates)::int AS duplicates FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))[0]).toEqual({stored:1,duplicates:1});
});
it('rejects another sender, thread, timestamp, and evidence kind without partially ingesting a page',async()=>{
  await setup();const command=await next();
  for(const change of [{peer_id:'444'},{thread_id:'444',source_url:'https://www.facebook.com/messages/e2ee/t/444/'},{occurred_at:new Date(Date.now()-1000).toISOString()},{thread_kind:'DIRECT' as const}]){const value=report(command);Object.assign(value.inbox_page!.batch.messages[0],change);value.receipt!.content_hash=digest(value.inbox_page);await expect(acceptReport(agent,value)).rejects.toMatchObject({code:'INBOX_SOURCE_MISMATCH'});}
  const wrong=report(command);wrong.receipt!.evidence_kind='synthetic_dom';await expect(acceptReport(agent,wrong)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect((await query('SELECT count(*)::int n FROM kff.browser_inbox_checkpoints'))[0].n).toBe(0);
});
it('requires registered evidence, explicit feature enablement, and the monitor-bound snapshot',async()=>{
  await setup(false);expect(await prepareBrowserInboxPage()).toBeNull();
  const h=await setup();process.env.KFF_ENABLE_BROWSER_INBOX='false';expect(await prepareBrowserInboxPage()).toBeNull();
  await expect(createTask(scope,{title:'Missing inbox scope',account_id:h.account.id,environment_id:h.environment.id,capability_id:h.capability.id,mode:'CONTROLLED_PILOT',body:'',fixture_scenario:'normal',idempotency_key:randomUUID()})).rejects.toThrow();
  expect(await claimCommand(agent)).toBeNull();
});
it('discovers multiple threads into the owning Inbox without creating reply permission, then deduplicates a reread',async()=>{
 const h=await setup(true,true),command=await next();expect(command.snapshot.inbox?.binding.discovery?.max_threads).toBe(2);expect(command.snapshot.inbox?.binding.target).toBeUndefined();
 await acceptReport(agent,directoryReport(command));await close(command);
 const conversations=await query('SELECT account_id,handling_mode,reply_window_expires_at FROM kff.conversations WHERE account_id=$1',[h.account.id]);expect(conversations).toHaveLength(2);for(const c of conversations)expect(c).toMatchObject({account_id:h.account.id,handling_mode:'HUMAN',reply_window_expires_at:null});
 expect((await query('SELECT count(*)::int n FROM kff.messages WHERE contact_permission_id IS NOT NULL'))[0].n).toBe(0);
 const workspace=await browserInboxWorkspace(scope);expect(workspace.reads[0].discovery.threads).toHaveLength(2);
 await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:h.monitor.version,action:'SCAN'});const again=await next(),value=directoryReport(again);for(const m of value.inbox_page!.batch.messages)m.displayed_time='昨天 11:59';value.receipt!.content_hash=digest(value.inbox_page);await acceptReport(agent,value);await close(again);
 expect((await query('SELECT sum(stored)::int stored,sum(duplicates)::int duplicates FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))[0]).toEqual({stored:2,duplicates:2});
});
it('rejects a directory report over its approved thread bound before storing messages',async()=>{
 await setup(true,true,1);const command=await next();await expect(acceptReport(agent,report(command))).rejects.toMatchObject({code:'INBOX_SOURCE_MISMATCH'});await expect(acceptReport(agent,directoryReport(command))).rejects.toMatchObject({code:'INBOX_SOURCE_MISMATCH'});expect((await query('SELECT count(*)::int n FROM kff.browser_inbox_checkpoints'))[0].n).toBe(0);
});
it('preserves a skipped thread failure phase through report ingestion without ingesting or authorizing that peer',async()=>{
 const h=await setup(true,true),command=await next(),value=directoryReport(command),page=value.inbox_page!;
 const skipped=page.discovery!.threads.pop()!;page.batch.messages=page.batch.messages.filter(m=>m.thread_id!==skipped.thread_id);
 const failure={stage:'facebook-inbox-peer-menu' as const,code:'TIMEOUT' as const};
 page.discovery!.skipped=[{thread_id:skipped.thread_id,reason:'THREAD_WINDOW_UNAVAILABLE',failure}];page.discovery!.window_limited=true;
 value.receipt!.content_hash=digest(page);await acceptReport(agent,value);await close(command);
 const workspace=await browserInboxWorkspace(scope);expect(workspace.reads[0].discovery.skipped).toEqual([{thread_id:skipped.thread_id,reason:'THREAD_WINDOW_UNAVAILABLE',failure}]);
 const conversations=await query('SELECT i.remote_id,v.handling_mode,v.reply_window_expires_at FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1',[h.account.id]);
 expect(conversations).toEqual([{remote_id:'123456',handling_mode:'HUMAN',reply_window_expires_at:null}]);
 expect((await query('SELECT stored,duplicates FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))).toEqual([{stored:1,duplicates:0}]);
 expect((await query('SELECT count(*)::int n FROM kff.contact_permissions p JOIN kff.contact_targets t ON t.id=p.target_id WHERE t.account_id=$1',[h.account.id]))[0].n).toBe(0);
});
it('discards a discovered page after the operator pauses its monitor',async()=>{
 const h=await setup(true,true),command=await next();await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:h.monitor.version,action:'PAUSE'});expect((await agentHeartbeat(agent,command.id)).continue).toBe(false);await acceptReport(agent,directoryReport(command));await close(command);expect((await query('SELECT count(*)::int n FROM kff.conversations WHERE account_id=$1',[h.account.id]))[0].n).toBe(0);
});
// A conversation that was read through the read-only path is a real read: it is ingested and
// deduplicated like any other, it keeps its reason on record, and a skipped conversation is never
// counted as read. This is the local proof for the isolation rule used by the live window.
it('ingests a read-only conversation, records its reason, and never counts a skipped one as read',async()=>{
 const h=await setup(true,true,2),command=await next(),value=directoryReport(command),page=value.inbox_page!,readOnly=page.discovery!.threads[0],skipped=page.discovery!.threads.pop()!;
 page.batch.messages=page.batch.messages.filter(m=>m.thread_id!==skipped.thread_id);
 Object.assign(readOnly,{read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'});
 page.discovery!.skipped=[{thread_id:skipped.thread_id,reason:'THREAD_COMPOSER_ABSENT',failure:{stage:'facebook-inbox-directory-composer',code:'THREAD_COMPOSER_ABSENT'}}];
 page.discovery!.observed=[{thread_id:readOnly.thread_id,reason:'THREAD_COMPOSER_ABSENT',failure:{stage:'facebook-inbox-directory-composer',code:'THREAD_COMPOSER_ABSENT'}}];
 page.discovery!.coverage={threads_attempted:2,threads_read:1,threads_skipped:1,threads_failed:0};
 page.discovery!.window_limited=true;value.receipt!.content_hash=digest(page);
 await acceptReport(agent,value);await close(command);
 const workspace=await browserInboxWorkspace(scope);
 expect(workspace.reads[0].discovery.coverage).toEqual({threads_attempted:2,threads_read:1,threads_skipped:1,threads_failed:0});
 expect(workspace.reads[0].discovery.threads).toMatchObject([{thread_id:readOnly.thread_id,read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'}]);
 expect((await query('SELECT i.remote_id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1',[h.account.id])).map(r=>r.remote_id)).toEqual([readOnly.thread_id]);
 expect((await query('SELECT stored,duplicates FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))).toEqual([{stored:1,duplicates:0}]);
 // The same read-only conversation read again in a later cycle is a duplicate, never a new message.
 await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:h.monitor.version,action:'SCAN'});const again=await next(),repeat=directoryReport(again),repeatPage=repeat.inbox_page!;
 repeatPage.batch.messages=structuredClone(page.batch.messages);Object.assign(repeatPage.discovery!.threads[0],{read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'});
 repeatPage.discovery!.threads.pop();repeatPage.discovery!.skipped=[{thread_id:skipped.thread_id,reason:'THREAD_COMPOSER_ABSENT',failure:{stage:'facebook-inbox-directory-composer',code:'THREAD_COMPOSER_ABSENT'}}];
 repeatPage.discovery!.coverage={threads_attempted:2,threads_read:1,threads_skipped:1,threads_failed:0};repeatPage.discovery!.window_limited=true;repeat.receipt!.content_hash=digest(repeatPage);
 await acceptReport(agent,repeat);await close(again);
 expect((await query('SELECT sum(stored)::int stored,sum(duplicates)::int duplicates FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))[0]).toEqual({stored:1,duplicates:1});
});
// The controller refuses a window whose per-thread counts, coverage or read flags do not match the
// batch it is being asked to store.
it('refuses a window whose read counts or coverage do not match the stored messages',async()=>{
 const h=await setup(true,true,2),command=await next();
 for(const [label,change] of [
  ['per-thread count above the batch',(value:ReturnType<typeof directoryReport>)=>{value.inbox_page!.discovery!.threads[0].message_count=5;}],
  ['per-thread count below the batch',(value:ReturnType<typeof directoryReport>)=>{value.inbox_page!.discovery!.threads[0].message_count=2;}],
  ['coverage claiming a read the summary does not have',(value:ReturnType<typeof directoryReport>)=>{value.inbox_page!.discovery!.coverage!.threads_read=1;}],
  ['coverage claiming a failure that is not in the skip list',(value:ReturnType<typeof directoryReport>)=>{value.inbox_page!.discovery!.coverage!.threads_failed=1;}],
 ] as const){
  const value=directoryReport(command);value.inbox_page!.discovery!.coverage={threads_attempted:2,threads_read:2,threads_skipped:0,threads_failed:0};value.inbox_page!.discovery!.threads.forEach(t=>{t.message_count=1;});change(value);value.receipt!.content_hash=digest(value.inbox_page);
  // Some mutations already fail the contract parse and the rest fail the controller check; in both
  // layers the page is refused, so nothing is stored under a window that disagrees with itself.
  await expect(acceptReport(agent,value),label).rejects.toThrow();
 }
 expect((await query('SELECT count(*)::int n FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1',[h.monitor.id]))[0].n).toBe(0);
});
it('keeps the same discovered thread identifiers isolated between two operating accounts',async()=>{
 const first=await setup(true,true),a=await next();await acceptReport(agent,directoryReport(a));await close(a);
 const second=await setup(true,true),b=await next();await acceptReport(agent,directoryReport(b));await close(b);
 const rows=await query('SELECT v.account_id,v.id,v.customer_id,i.remote_id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=ANY($1::uuid[])',[ [first.account.id,second.account.id] ]);
 expect(rows).toHaveLength(4);expect(new Set(rows.map(r=>r.customer_id)).size).toBe(4);for(const id of [first.account.id,second.account.id])expect(rows.filter(r=>r.account_id===id).map(r=>r.remote_id).sort()).toEqual(['123456','123457']);
});
it('stores photo-presence markers with text, preserves deduplication and leaves unread images for human handling',async()=>{
 const h=await setup(true,true);await query("UPDATE kff.accounts SET state='ACTIVE' WHERE id=$1",[h.account.id]);
 await configureFacebook(scope,{request_id:randomUUID(),account_id:h.account.id,environment_id:h.environment.id,transport:'BROWSER',expected_version:0,state:'ACTIVE',auto_reply:false,reply_window_hours:1,policy_ref:'kff.facebook-browser.explicit-consent.v1'});
 const first=await next();await acceptReport(agent,directoryReport(first));await close(first);
 const conversation=(await query('SELECT v.* FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1 AND i.remote_id=$2',[h.account.id,'123456']))[0];
 await expect(requestReceptionDraft(scope,conversation.id,{request_id:randomUUID(),expected_version:conversation.control_version})).resolves.toMatchObject({status:'DRAFT_QUEUED'});
 const scan=await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:h.monitor.version,action:'SCAN'}),command=await next(),value=directoryReport(command),base=value.inbox_page!.batch.messages[0];
 value.inbox_page!.batch.messages.push({...base,message_id:'photo.outgoing',direction:'OUTBOUND',display_name:null,has_attachment:true,body:'[图片附件，内容未读取]'}, {...base,message_id:'photo.incoming',has_attachment:true,body:'[图片附件，内容未读取]'});
 const invalid=structuredClone(value);invalid.inbox_page!.batch.messages.at(-1)!.body='Invented image interpretation';invalid.receipt!.content_hash=digest(invalid.inbox_page);
 await expect(acceptReport(agent,invalid)).rejects.toMatchObject({code:'INBOX_SOURCE_MISMATCH'});
 value.receipt!.content_hash=digest(value.inbox_page);await acceptReport(agent,value);await close(command);
 const c=(await query('SELECT * FROM kff.conversations WHERE id=$1',[conversation.id]))[0];expect(c).toMatchObject({handling_mode:'HUMAN',control_version:conversation.control_version+2});
 const photos=await query("SELECT direction,body,source,contact_permission_id FROM kff.messages WHERE conversation_id=$1 AND source->>'has_attachment'='true' ORDER BY sequence",[c.id]);
 expect(photos).toHaveLength(2);expect(photos.map(p=>p.direction)).toEqual(['EXTERNAL_OUTBOUND','INBOUND']);for(const photo of photos)expect(photo).toMatchObject({body:'[图片附件，内容未读取]',source:{has_attachment:true},contact_permission_id:null});
 await expect(requestReceptionDraft(scope,c.id,{request_id:randomUUID(),expected_version:c.control_version})).rejects.toMatchObject({code:'DRAFT_UNAVAILABLE'});
 expect((await query("SELECT count(*)::int n FROM kff.jobs WHERE kind='RECEPTION'"))[0].n).toBe(1);
 await controlBrowserInbox(scope,h.monitor.id,{request_id:randomUUID(),expected_version:scan.version,action:'SCAN'});const again=await next(),repeat=directoryReport(again);repeat.inbox_page!.batch.messages=structuredClone(value.inbox_page!.batch.messages);for(const m of repeat.inbox_page!.batch.messages)m.displayed_time='昨天 11:59';repeat.receipt!.content_hash=digest(repeat.inbox_page);await acceptReport(agent,repeat);await close(again);
 expect((await query('SELECT stored,duplicates FROM kff.browser_inbox_checkpoints WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[again.action_id]))[0]).toEqual({stored:0,duplicates:4});
 expect((await query('SELECT count(*)::int n FROM kff.contact_permissions p JOIN kff.contact_targets t ON t.id=p.target_id WHERE t.account_id=$1',[h.account.id]))[0].n).toBe(0);
});
