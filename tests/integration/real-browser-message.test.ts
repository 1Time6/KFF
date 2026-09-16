import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool,projectRoot} from '@kff/database';
import type {AgentCommand,ActionReport} from '@kff/contracts';
import {digest} from '@kff/core';
import {leadScope as scope,leadAgent as agent,clearLeads} from '../helpers/lead-fixture';
import {createAccount,createEnvironment,enqueueTask} from '../../packages/core/src/service';
import {configureEnvironment} from '../../packages/core/src/environments';
import {configureBrowserInbox,controlBrowserInbox,prepareBrowserInboxPage,syncBrowserInboxTasks} from '../../packages/core/src/browser-inbox';
import {configureFacebook} from '../../packages/core/src/facebook-inbound';
import {prepareMessengerPilot,configureWhatsapp,recordBrowserConsent,conversationReception} from '../../packages/core/src/lead-reception';
import {revokeContactPermission} from '../../packages/core/src/contacts';
import {createPermit} from '../../packages/core/src/permits';
import {configureBudget} from '../../packages/core/src/costs';
import {attachLocalEvidence} from '../../packages/core/src/capabilities';
import {adapterImplementationDigest} from '../../packages/core/src/artifacts';
import {dispatchOne,claimCommand,acceptReport,agentHeartbeat,beginSubmission} from '../../packages/core/src/execution';
import {recordQuiescence} from '../../packages/core/src/reconciliation';
import {requestReceptionDraft} from '../../packages/core/src/reception-drafts';
import {processReceptionOne} from '../../packages/core/src/reception-worker';
import {adjudicateAction} from '../../packages/core/src/adjudication';

const previous={inbox:process.env.KFF_ENABLE_BROWSER_INBOX,live:process.env.KFF_ENABLE_LIVE};
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{await clearLeads();await query('TRUNCATE kff.browser_inbox_monitors,kff.cost_budgets CASCADE');process.env.KFF_ENABLE_BROWSER_INBOX='true';process.env.KFF_ENABLE_LIVE='true';await configureBudget(scope,{request_id:randomUUID(),expected_version:0,currency:'USD',minor_unit_exponent:2,precision_source:'Isolated contract currency',limit_minor:'0',reason:'Isolated browser message contract'});});
afterAll(async()=>{for(const [key,value] of [['KFF_ENABLE_BROWSER_INBOX',previous.inbox],['KFF_ENABLE_LIVE',previous.live]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}await closePool();});
async function close(command:AgentCommand){await recordQuiescence(agent,command.id,{protocol_version:'kff.guardian-closure.v1',command_id:command.id,action_id:command.action_id,closed_at:new Date().toISOString(),proof_sha256:'c'.repeat(64)});await syncBrowserInboxTasks();}
async function setup(){
  const account=await createAccount(scope,{display_name:'Isolated browser message profile',external_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),platform:'facebook',account_type:'profile'});
  const environment=await createEnvironment(scope,{name:'No real provider calls',account_id:account.id,agent_id:localIds.agent});
  await configureEnvironment(scope,environment.id,{expected_version:1,configuration:{driver:'adspower',provider_profile_id:'contract-'+randomUUID(),login_account_id:account.external_id,operating_identity_id:account.external_id,locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}});
  const monitor=await configureBrowserInbox(scope,{request_id:randomUUID(),environment_id:environment.id,expected_version:0,target:{thread_id:'123456',peer_id:'987654',display_name:'合同客户'}});
  const hash=adapterImplementationDigest(projectRoot,'facebook');await query("INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,'facebook-graph-v1','{}',1,'ISOLATED CONTRACT FIXTURE',now(),'{\"synthetic_test\":true}') ON CONFLICT DO NOTHING",[hash]);
  const readCap=(await query("SELECT id FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.inbox.read.browser'",[account.id]))[0];await attachLocalEvidence(scope,readCap.id);
  await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:monitor.version,action:'SCAN'});await agentHeartbeat(agent);await prepareBrowserInboxPage();await dispatchOne();const read=(await claimCommand(agent))!;
  const request=read.snapshot.inbox!,inbox_page={monitor_id:request.monitor_id,cursor:null,next_cursor:null,has_more:false,batch:{schema_version:'kff.browser-inbox-batch.v1' as const,login_account_id:account.external_id,operating_identity_id:account.external_id,observed_at:new Date().toISOString(),coverage:'VISIBLE_MESSAGES_ONLY' as const,messages:[{message_id:'987654@msgr.123',thread_id:'123456',peer_id:'987654',thread_kind:'UNVERIFIED' as const,direction:'INBOUND' as const,body:'Isolated incoming',display_name:'合同客户',occurred_at:null,displayed_time:'11:59',has_attachment:false,source_url:'https://www.facebook.com/messages/e2ee/t/123456/'}]}};
  await acceptReport(agent,{event_id:randomUUID(),command_id:read.id,outcome:'VERIFIED_SUCCEEDED',inbox_page,receipt:{remote_id:'inbox:'+request.monitor_id+':'+request.token,actual_account_id:account.external_id,content_hash:digest(inbox_page),evidence_kind:'browser_dom',observed_at:inbox_page.batch.observed_at},diagnostic:{step:'isolated-contract-only'}});await close(read);
  expect((await query('SELECT state FROM kff.accounts WHERE id=$1',[account.id]))[0].state).toBe('ACTIVE');
  const config={request_id:randomUUID(),account_id:account.id,environment_id:environment.id,expected_version:0,transport:'BROWSER' as const,state:'ACTIVE' as const,auto_reply:false,reply_window_hours:1,policy_ref:'kff.facebook-browser.explicit-consent.v1'};
  await configureFacebook(scope,config);const capability=(await query("SELECT * FROM kff.capabilities WHERE account_id=$1 AND capability_key='facebook.messenger.reply.browser'",[account.id]))[0];await attachLocalEvidence(scope,capability.id);
  const conversation=(await query('SELECT v.*,i.contact_target_id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1',[account.id]))[0];
  const incoming=(await query('SELECT * FROM kff.messages WHERE conversation_id=$1',[conversation.id]))[0];
  expect(incoming.contact_permission_id).toBeNull();expect(incoming.client_sent_at).toBeNull();expect(conversation.reply_window_expires_at).toBeNull();
  const now=Date.now(),policy={basis_type:'explicit_consent' as const,purpose:'customer_service' as const,source_type:'manual_record' as const,source_ref:'facebook-browser-inbound:'+incoming.id,source_observed_at:new Date(now-1000).toISOString(),source_use_status:'CONFIRMED' as const,starts_at:new Date(now-1000).toISOString(),expires_at:new Date(now+1200000).toISOString(),policy_ref:'kff.facebook-browser.explicit-consent.v1',window_rule:'EXPLICIT_END' as const,window_expires_at:new Date(now+1200000).toISOString(),evidence_note:'Isolated explicit test consent; no platform authorization or send.'};
  const consent={request_id:randomUUID(),expected_version:conversation.control_version,consented_at:policy.starts_at,expires_at:policy.expires_at,evidence_note:policy.evidence_note,confirmation:'CUSTOMER_CONFIRMED_THIS_CONTACT'};
  const permission=await recordBrowserConsent(scope,conversation.id,consent);expect((await recordBrowserConsent(scope,conversation.id,consent)).id).toBe(permission.id);
  const destination=await configureWhatsapp(scope,{request_id:randomUUID(),account_id:account.id,expected_version:0,name:'Contract sales',phone:'15550001111',state:'ACTIVE',template:'Contact our test sales: {whatsapp_url}',cooldown_hours:24});
  const input={request_id:randomUUID(),expected_version:conversation.control_version,body:'Isolated reply',refer_whatsapp:true,contact_permission_id:permission.id};
  return {account,environment,conversation,permission,policy,destination,input,config,read,consent};
}
function permit(task_id:string){return {task_id,max_actions:1,starts_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+1200000).toISOString(),currency:'USD',max_cost_minor:'0',per_action_max_minor:'0',cost_basis:'No provider call in isolated contract',authorization_evidence:'Synthetic consent for isolated contract only',platform_conditions:'No production capability established by this test',expected_evidence:'message_acceptance' as const,stop_rule:'stop_on_first_unknown_or_failure' as const,confirmation:'I_CONFIRM_THIS_EXACT_SCOPE' as const};}
async function prepared(h:Awaited<ReturnType<typeof setup>>){return prepareMessengerPilot(scope,h.conversation.id,h.input);}
async function commandFor(h:Awaited<ReturnType<typeof setup>>){const task=await prepared(h);await createPermit(scope,permit(task.task_id));await enqueueTask(scope,task.task_id);await agentHeartbeat(agent);await dispatchOne();const command=(await claimCommand(agent))!;expect(command).not.toBeNull();return command;}
function success(command:AgentCommand):ActionReport{return {event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:'123456@msgr.999',actual_account_id:command.snapshot.external_account_id,recipient_id:'987654',thread_id:'123456',content_hash:command.snapshot.content_hash,evidence_kind:'browser_message',observed_at:new Date().toISOString()},diagnostic:{step:'isolated-contract-only'}};}
type InboxMessage=NonNullable<ActionReport['inbox_page']>['batch']['messages'][number];
function observedMessage(message_id:string,body:string,direction:InboxMessage['direction']='INBOUND'):InboxMessage {
  return {message_id,thread_id:'123456',peer_id:'987654',thread_kind:'UNVERIFIED',direction,body,display_name:direction==='INBOUND'?'合同客户':'Isolated browser message profile',occurred_at:null,displayed_time:'12:00',has_attachment:false,source_url:'https://www.facebook.com/messages/e2ee/t/123456/'};
}
async function nextRead(h:Awaited<ReturnType<typeof setup>>) {
  const monitor=(await query('SELECT id,version FROM kff.browser_inbox_monitors WHERE id=$1',[h.read.snapshot.inbox!.monitor_id]))[0];
  await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:monitor.version,action:'SCAN'});
  await agentHeartbeat(agent);expect(await prepareBrowserInboxPage()).not.toBeNull();expect(await dispatchOne()).toBe(true);
  const command=(await claimCommand(agent))!;expect(command.snapshot.inbox).toBeDefined();return command;
}
function historyReport(command:AgentCommand,messages:InboxMessage[]):ActionReport {
  const request=command.snapshot.inbox!;
  const inbox_page={monitor_id:request.monitor_id,cursor:null,next_cursor:null,has_more:false,batch:{schema_version:'kff.browser-inbox-batch.v1' as const,login_account_id:command.snapshot.external_account_id,operating_identity_id:command.snapshot.external_account_id,observed_at:new Date().toISOString(),coverage:'VISIBLE_MESSAGES_ONLY' as const,messages}};
  return {event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',inbox_page,receipt:{remote_id:'inbox:'+request.monitor_id+':'+request.token,actual_account_id:command.snapshot.external_account_id,content_hash:digest(inbox_page),evidence_kind:'browser_dom',observed_at:inbox_page.batch.observed_at},diagnostic:{step:'isolated-mixed-history-contract-only'}};
}
it('requires explicit consent and prepares once without a job or a fabricated inbound window',async()=>{
  const h=await setup();await expect(prepareMessengerPilot(scope,h.conversation.id,{...h.input,contact_permission_id:undefined})).rejects.toMatchObject({code:'CONTACT_BASIS_MISSING'});
  await expect(recordBrowserConsent({...scope,role:'viewer'},h.conversation.id,h.consent)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(recordBrowserConsent(scope,h.conversation.id,{...h.consent,confirmation:undefined})).rejects.toThrow();
  await expect(query("UPDATE kff.facebook_connections SET transport='API',version=version+1 WHERE account_id=$1",[h.account.id])).rejects.toThrow('FACEBOOK_ACCOUNT_MISMATCH');
  await expect(configureFacebook(scope,{...h.config,request_id:randomUUID(),expected_version:1,auto_reply:true})).rejects.toMatchObject({code:'SOURCE_NOT_CONFIGURED'});
  const a=await prepared(h),b=await prepared(h);expect(a.task_id).toBe(b.task_id);expect(await query('SELECT * FROM kff.runs WHERE task_id=$1',[a.task_id])).toHaveLength(0);
  const task=(await query('SELECT snapshot FROM kff.tasks WHERE id=$1',[a.task_id]))[0].snapshot;expect(task).toMatchObject({capability_key:'facebook.messenger.reply.browser',mode:'CONTROLLED_PILOT',credential_ref:null,platform_api_version:null,message:{actor_kind:'HUMAN',browser:{thread_id:'123456',peer_id:'987654',display_name:'合同客户',trigger_content_hash:digest('Isolated incoming')}}});
  await expect(enqueueTask(scope,a.task_id)).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
});
it('runs through original submission intent and records a WhatsApp referral once from the browser receipt',async()=>{
  const h=await setup(),command=await commandFor(h);await expect(acceptReport(agent,success(command))).rejects.toMatchObject({code:'SUBMISSION_UNCERTAIN'});
  await beginSubmission(agent,command.id);const report=success(command);await acceptReport(agent,report);await acceptReport(agent,report);await close(command);
  expect((await query("SELECT body FROM kff.messages WHERE conversation_id=$1 AND direction='OUTBOUND'",[h.conversation.id]))).toEqual([{body:'Contact our test sales: https://wa.me/15550001111'}]);
  expect((await query('SELECT state FROM kff.whatsapp_referrals WHERE action_id=$1',[command.action_id]))[0].state).toBe('REFERRED');
  expect((await query('SELECT reserved_actions,access_path FROM kff.pilot_permits WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[command.action_id]))[0]).toEqual({reserved_actions:1,access_path:'browser_message'});
});
it('reconciles a receipt echo plus new incoming through the original read report, then rescans without duplicate messages or reusable old consent',async()=>{
  const h=await setup(),sent=await commandFor(h);await beginSubmission(agent,sent.id);await acceptReport(agent,success(sent));await close(sent);
  const controlVersion=(await query('SELECT control_version FROM kff.conversations WHERE id=$1',[h.conversation.id]))[0].control_version;
  const history=[observedMessage('987654@msgr.123','Isolated incoming'),observedMessage('123456@msgr.999',sent.snapshot.body,'OUTBOUND'),observedMessage('987654@msgr.124','New isolated incoming')];
  const read=await nextRead(h);await acceptReport(agent,historyReport(read,history));await close(read);
  expect(await query('SELECT sequence,direction,body FROM kff.messages WHERE conversation_id=$1 ORDER BY sequence',[h.conversation.id])).toEqual([
    {sequence:1,direction:'INBOUND',body:'Isolated incoming'},
    {sequence:2,direction:'OUTBOUND',body:sent.snapshot.body},
    {sequence:3,direction:'INBOUND',body:'New isolated incoming'},
  ]);
  expect((await query('SELECT stored,duplicates FROM kff.browser_inbox_checkpoints WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[read.action_id]))[0]).toEqual({stored:2,duplicates:1});
  expect((await query('SELECT last_inbound_sequence,last_answered_sequence,handling_mode,reply_window_expires_at,control_version FROM kff.conversations WHERE id=$1',[h.conversation.id]))[0]).toEqual({last_inbound_sequence:3,last_answered_sequence:1,handling_mode:'HUMAN',reply_window_expires_at:null,control_version:controlVersion});
  expect((await conversationReception(scope,h.conversation.id)).manual_permissions).toEqual([]);
  await expect(prepareMessengerPilot(scope,h.conversation.id,{...h.input,request_id:randomUUID(),expected_version:controlVersion,refer_whatsapp:false})).rejects.toMatchObject({code:'CONTACT_NEW_CONSENT_REQUIRED'});
  const again=await nextRead(h);await acceptReport(agent,historyReport(again,history.map(message=>({...message,displayed_time:'昨天 12:00'}))));await close(again);
  expect((await query('SELECT stored,duplicates FROM kff.browser_inbox_checkpoints WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[again.action_id]))[0]).toEqual({stored:0,duplicates:3});
  expect(await query('SELECT id FROM kff.messages WHERE conversation_id=$1',[h.conversation.id])).toHaveLength(3);
  expect(await query('SELECT id FROM kff.whatsapp_referrals WHERE conversation_id=$1',[h.conversation.id])).toHaveLength(1);
  expect(await query("SELECT id FROM kff.audit_events WHERE event_type='facebook.own_echo_stored' AND details->>'action_id'=$1",[sent.action_id])).toHaveLength(1);
});
it('keeps native outgoing separate, preserves unknown dates, and rejects a changed identity or reused message ID atomically',async()=>{
  const h=await setup(),read=await nextRead(h);
  const native=observedMessage('123456@msgr.888','Reply written outside KFF','OUTBOUND');
  const newIncoming=observedMessage('987654@msgr.125','Another isolated incoming');
  const badPeer=historyReport(read,[newIncoming,{...native,peer_id:'444'}]);
  await expect(acceptReport(agent,badPeer)).rejects.toMatchObject({code:'INBOX_SOURCE_MISMATCH'});
  const conflict=historyReport(read,[native,{...observedMessage('987654@msgr.123','Isolated incoming'),direction:'OUTBOUND'}]);
  await expect(acceptReport(agent,conflict)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect(await query('SELECT id FROM kff.messages WHERE conversation_id=$1',[h.conversation.id])).toHaveLength(1);
  expect(await query("SELECT id FROM kff.inbound_events WHERE source_kind='facebook_browser' AND split_part(source_key,'/',1)=$1",[h.account.id])).toHaveLength(1);
  expect(await query('SELECT task_id FROM kff.browser_inbox_checkpoints WHERE task_id=(SELECT task_id FROM kff.actions WHERE id=$1)',[read.action_id])).toHaveLength(0);
  await acceptReport(agent,historyReport(read,[observedMessage('987654@msgr.123','Isolated incoming'),native,newIncoming]));await close(read);
  expect(await query('SELECT sequence,direction,client_sent_at,contact_permission_id FROM kff.messages WHERE conversation_id=$1 ORDER BY sequence',[h.conversation.id])).toEqual([
    {sequence:1,direction:'INBOUND',client_sent_at:null,contact_permission_id:null},
    {sequence:2,direction:'EXTERNAL_OUTBOUND',client_sent_at:null,contact_permission_id:null},
    {sequence:3,direction:'INBOUND',client_sent_at:null,contact_permission_id:null},
  ]);
  expect((await query('SELECT last_inbound_sequence,last_answered_sequence,handling_mode,control_version,reply_window_expires_at FROM kff.conversations WHERE id=$1',[h.conversation.id]))[0]).toEqual({last_inbound_sequence:3,last_answered_sequence:0,handling_mode:'HUMAN',control_version:h.conversation.control_version+1,reply_window_expires_at:null});
  expect(await query('SELECT id FROM kff.whatsapp_referrals WHERE conversation_id=$1',[h.conversation.id])).toHaveLength(0);
});
it('rejects expanded permits and identity evidence that is missing its original closure',async()=>{
  const h=await setup(),task=await prepared(h);
  await expect(createPermit(scope,{...permit(task.task_id),max_actions:2})).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
  await expect(createPermit(scope,{...permit(task.task_id),expires_at:new Date(Date.now()+7200000).toISOString()})).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
  await query('UPDATE kff.agent_commands SET quiesced_at=NULL WHERE id=$1',[h.read.id]);await expect(createPermit(scope,permit(task.task_id))).rejects.toMatchObject({code:'ACCOUNT_UNVERIFIED'});
});
it('rechecks revoked consent at submission and keeps the source message unchanged',async()=>{
  const h=await setup(),command=await commandFor(h);await revokeContactPermission(scope,h.permission.id,'Contract withdrawal');await expect(beginSubmission(agent,command.id)).rejects.toMatchObject({code:'CONTACT_BASIS_REVOKED'});
  expect((await query('SELECT contact_permission_id,client_sent_at FROM kff.messages WHERE id=$1',[command.snapshot.message!.trigger_message_id]))[0]).toEqual({contact_permission_id:null,client_sent_at:null});
});
it('rejects another recipient or graph receipt and preserves uncertainty without repeating the action',async()=>{
  const h=await setup(),command=await commandFor(h);await beginSubmission(agent,command.id);
  const wrong=success(command);wrong.receipt!.recipient_id='111';await expect(acceptReport(agent,wrong)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  const graph=success(command);graph.receipt!.evidence_kind='graph_message';graph.receipt!.remote_id='123_999';await expect(acceptReport(agent,graph)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await acceptReport(agent,{event_id:randomUUID(),command_id:command.id,outcome:'UNKNOWN_OUTCOME',error_code:'SUBMISSION_UNCERTAIN',diagnostic:{step:'isolated-contract-only'}});await close(command);
  expect((await query('SELECT state FROM kff.environments WHERE id=$1',[h.environment.id]))[0].state).toBe('QUARANTINED');expect(await claimCommand(agent)).toBeNull();expect(await query("SELECT * FROM kff.messages WHERE conversation_id=$1 AND direction='OUTBOUND'",[h.conversation.id])).toHaveLength(0);
  const action=(await query('SELECT adjudication_version FROM kff.actions WHERE id=$1',[command.action_id]))[0];
  const review={request_id:randomUUID(),snapshot_hash:command.snapshot_hash,expected_version:action.adjudication_version,expected_state:'UNKNOWN_OUTCOME' as const,decision:'CONFIRMED_SUCCESS' as const,evidence:{source:'platform_ui' as const,external_account_id:command.snapshot.external_account_id,recipient_id:'987654',thread_id:'123456',content_hash:command.snapshot.content_hash,remote_id:'123456@msgr.999',observed_at:new Date().toISOString(),reference:'Isolated contract fixture for a reviewed original message',failure_basis:null,matched_original_submission:true},reason:'Contract fixture only: original message identity and body match.',confirmation:'I_REVIEWED_THIS_ORIGINAL_ACTION' as const};
  await expect(adjudicateAction(scope,command.run_id,{...review,evidence:{...review.evidence,thread_id:'777'}})).rejects.toMatchObject({code:'ACCOUNT_MISMATCH'});
  await adjudicateAction(scope,command.run_id,review);await adjudicateAction(scope,command.run_id,review);
  expect(await query("SELECT * FROM kff.messages WHERE conversation_id=$1 AND direction='OUTBOUND'",[h.conversation.id])).toHaveLength(1);expect((await query('SELECT state FROM kff.environments WHERE id=$1',[h.environment.id]))[0].state).toBe('QUARANTINED');
});

it('adopts a draft in the browser pilot path without creating a send, approval bypass or inbound service window',async()=>{
  const h=await setup();process.env.KFF_ENABLE_LIVE='false';
  const before=(await query('SELECT count(*)::int n FROM kff.tasks'))[0].n;
  const draft=await requestReceptionDraft(scope,h.conversation.id,{request_id:randomUUID(),expected_version:h.conversation.control_version});await processReceptionOne();
  expect((await query('SELECT count(*)::int n FROM kff.tasks'))[0].n).toBe(before);
  expect((await conversationReception(scope,h.conversation.id)).jobs[0]).toMatchObject({draft_only:true,draft_usable:true,result:{status:'DRAFT_READY'}});
  const input={...h.input,draft_job_id:draft.job_id,refer_whatsapp:false,body:'Human reviewed the isolated suggestion'};
  await expect(prepareMessengerPilot(scope,h.conversation.id,{...input,contact_permission_id:undefined})).rejects.toMatchObject({code:'CONTACT_BASIS_MISSING'});
  const prepared=await prepareMessengerPilot(scope,h.conversation.id,input),task=(await query('SELECT snapshot FROM kff.tasks WHERE id=$1',[prepared.task_id]))[0].snapshot;
  expect(task).toMatchObject({body:input.body,capability_key:'facebook.messenger.reply.browser',message:{actor_kind:'HUMAN',draft:{job_id:draft.job_id,model:'LOCAL_RULES'}}});
  expect(await query('SELECT id FROM kff.runs WHERE task_id=$1',[prepared.task_id])).toHaveLength(0);
  await expect(enqueueTask(scope,prepared.task_id)).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
  expect((await query('SELECT auto_reply FROM kff.facebook_connections WHERE account_id=$1',[h.account.id]))[0].auto_reply).toBe(false);
});
