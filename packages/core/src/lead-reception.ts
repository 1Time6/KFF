import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {scoped} from '@kff/database';
import {taskSnapshotSchema,type Scope,type TaskSnapshot,type Capability} from '@kff/contracts';
import {whatsappDestinationInput,conversationControlInput,replyInput,referralResultInput,receptionPolicy,type WhatsappDestination} from '../../contracts/src/lead';
import {contactSelectionSchema} from '../../contracts/src/contact';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite,enqueueTaskInTransaction} from './service';
import {assertContactBasisAtSubmission} from './contacts';
import {chooseTemplateVersion,ensureBundledTemplates} from './templates';
import {queueReceptionForConversation} from './reception-queue';

export async function ensureMessengerCapability(client:PoolClient,scope:Scope,account:{id:string;is_synthetic:boolean}){
  await client.query("INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",[scope.organization_id,scope.brand_id,account.id,account.is_synthetic?'kff.fixture.messenger.reply.api':'facebook.messenger.reply.api',account.is_synthetic?'fixture-messenger-v1':'facebook-messenger-v1',account.is_synthetic?'IMPLEMENTED_TEST_ONLY':'UNASSESSED',account.is_synthetic?'TEST_ONLY':'DISABLED',account.is_synthetic,account.is_synthetic?'本地合成 Messenger 接待；不访问真实平台':'Facebook 私信接待；真实凭据、权限及验证待完成']);
  await ensureBundledTemplates(client,scope);
}
export async function whatsappWorkspace(scope:Scope){return scoped(scope,async client=>({destinations:(await client.query<WhatsappDestination>('SELECT * FROM kff.whatsapp_destinations ORDER BY account_id NULLS FIRST,id')).rows}));}
export async function configureWhatsapp(scope:Scope,input:z.infer<typeof whatsappDestinationInput>){
  requireAdmin(scope);const value=whatsappDestinationInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['whatsapp/'+scope.brand_id+'/'+(value.account_id??'default')]);
    const oldRequest=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='whatsapp.configured' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(oldRequest){requireCondition(oldRequest.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求已用于不同 WhatsApp 配置',409);return oldRequest.details.result as WhatsappDestination;}
    if(value.account_id)requireCondition((await client.query("SELECT id FROM kff.accounts WHERE id=$1 AND platform='facebook'",[value.account_id])).rowCount,'FORBIDDEN_SCOPE','账号不属于当前品牌的 Facebook 范围',403);
    const old=(await client.query<WhatsappDestination>('SELECT * FROM kff.whatsapp_destinations WHERE account_id IS NOT DISTINCT FROM $1::uuid FOR UPDATE',[value.account_id])).rows[0];
    requireCondition((old?.version??0)===value.expected_version,'VERSION_CONFLICT','WhatsApp 配置已变化，请刷新',409);
    const result=old?(await client.query<WhatsappDestination>('UPDATE kff.whatsapp_destinations SET name=$1,phone=$2,state=$3,template=$4,cooldown_hours=$5,version=version+1 WHERE id=$6 RETURNING *',[value.name,value.phone,value.state,value.template,value.cooldown_hours,old.id])).rows[0]
      :(await client.query<WhatsappDestination>('INSERT INTO kff.whatsapp_destinations(organization_id,brand_id,account_id,name,phone,state,template,cooldown_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[scope.organization_id,scope.brand_id,value.account_id,value.name,value.phone,value.state,value.template,value.cooldown_hours])).rows[0];
    await audit(client,scope,'whatsapp.configured',result.id,{request_id:value.request_id,request_hash:hash,result});return result;
  });
}
export async function effectiveDestination(client:PoolClient,accountId:string){
  // A paused account override intentionally blocks referral; it must not fall through to another number.
  return (await client.query<WhatsappDestination>('SELECT d.* FROM kff.whatsapp_destinations d JOIN kff.accounts a ON a.brand_id=d.brand_id AND a.organization_id=d.organization_id WHERE a.id=$1 AND (d.account_id=a.id OR d.account_id IS NULL) ORDER BY d.account_id NULLS LAST LIMIT 1 FOR SHARE OF d',[accountId])).rows[0];
}
export async function readStopEpochs(client:PoolClient,accountId:string,agentId:string){
  const row=(await client.query('SELECT o.stop_epoch AS organization,b.stop_epoch AS brand,a.stop_epoch AS account,g.stop_epoch AS agent FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id JOIN kff.agents g ON g.id=$2 AND g.brand_id=a.brand_id AND g.organization_id=a.organization_id WHERE a.id=$1',[accountId,agentId])).rows[0];
  requireCondition(row,'FORBIDDEN_SCOPE','Agent 和账号作用域不一致',403);return {organization:Number(row.organization),brand:Number(row.brand),account:Number(row.account),agent:Number(row.agent)};
}
export async function messageSubmissionGate(client:PoolClient,snapshot:TaskSnapshot,actionId?:string){
  if(!snapshot.capability_key.includes('.messenger.'))return;
  const message=snapshot.message;requireCondition(message,'INVALID_INPUT','消息动作缺少会话快照');
  const connection=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[snapshot.account_id])).rows[0];
  requireCondition(connection&&connection.version===message.connection_version&&connection.environment_id===snapshot.environment_id,'RECEPTION_CONFIG_STALE','接待配置已变化，旧任务失效',409);
  requireCondition(connection.state==='ACTIVE','RECEPTION_PAUSED','账号接待已暂停',409);
  const conversation=(await client.query('SELECT v.*,c.lead_status,c.stage FROM kff.conversations v JOIN kff.customers c ON c.id=v.customer_id WHERE v.id=$1 AND v.account_id=$2 FOR UPDATE OF v',[message.conversation_id,snapshot.account_id])).rows[0];
  requireCondition(conversation&&conversation.channel_kind==='FACEBOOK_MESSENGER'&&conversation.control_version===message.control_version&&conversation.handling_mode===message.actor_kind,'CONVERSATION_STALE','会话处理权已变化，旧任务失效',409);
  requireCondition(conversation.last_inbound_sequence===message.trigger_sequence,'INBOUND_SUPERSEDED','新消息已到达，停止旧回复',409);
  requireCondition(!['BLOCKED','IGNORED','HANDOFF_COMPLETE'].includes(conversation.lead_status)&&conversation.stage!=='OPTED_OUT','LEAD_STOPPED','客户已停止自动接待',409);
  requireCondition(message.actor_kind!=='AI'||(connection.auto_reply&&conversation.last_answered_sequence<message.trigger_sequence),'ALREADY_ANSWERED','此咨询已被回复或自动接待已暂停',409);
  requireCondition(digest(await readStopEpochs(client,snapshot.account_id,snapshot.agent_id))===digest(message.stop_epochs),'STOP_EPOCH_STALE','停止状态曾发生变化，旧任务失效',409);
  const active=await client.query("SELECT a.id FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND a.id IS DISTINCT FROM $2::uuid AND a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME') LIMIT 1",[conversation.id,actionId??null]);
  requireCondition(!active.rowCount,'MESSAGE_IN_FLIGHT','此会话仍有发送在途或结果未知，需先核验原消息',409);
  const trigger=(await client.query("SELECT m.id FROM kff.messages m WHERE m.id=$1 AND m.conversation_id=$2 AND m.sequence=$3 AND m.direction='INBOUND' AND m.message_kind='MESSAGE'",[message.trigger_message_id,conversation.id,message.trigger_sequence])).rows[0];
  requireCondition(trigger,'MESSAGE_IDENTITY_MISMATCH','触发消息不属于当前会话',409);
  requireCondition(message.contact.account_id===snapshot.account_id&&message.contact.channel==='facebook_messenger','FORBIDDEN_SCOPE','接待依据与当前账号不匹配',403);
  await assertContactBasisAtSubmission(client,message.contact);
  if(message.referral){
    const destination=await effectiveDestination(client,snapshot.account_id);
    requireCondition(destination?.state==='ACTIVE'&&destination.id===message.referral.destination_id&&destination.version===message.referral.destination_version&&destination.phone===message.referral.phone,'WHATSAPP_CHANGED','WhatsApp 已暂停或配置变化，停止旧引流',409);
    const previous=await client.query("SELECT r.id FROM kff.whatsapp_referrals r JOIN kff.actions a ON a.id=r.action_id JOIN kff.tasks t ON t.id=a.task_id WHERE r.conversation_id=$1 AND r.action_id IS DISTINCT FROM $2::uuid AND (a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME') OR (a.state IN ('QUEUED','PREPARING') AND (t.snapshot->'message'->>'control_version')::int=$4) OR (r.sent_at>clock_timestamp()-make_interval(hours=>$3) AND r.state IN ('REFERRED','CONFIRMED','DECLINED'))) LIMIT 1",[conversation.id,actionId??null,destination.cooldown_hours,message.control_version]);
    requireCondition(!previous.rowCount,'REFERRAL_COOLDOWN','客户已收到或正在接收 WhatsApp 引导，请等待冷却期',409);
  }
  const policy=receptionPolicy.parse(connection.reception_policy);
  const attempts=(await client.query("SELECT count(*)::int AS sent,COALESCE(bool_or(at.submitted_at>clock_timestamp()-make_interval(secs=>$3)),false) AS cooling FROM kff.action_attempts at JOIN kff.actions a ON a.id=at.action_id JOIN kff.tasks t ON t.id=a.task_id WHERE t.account_id=$1 AND t.conversation_id IS NOT NULL AND at.submitted_at>=date_trunc('day',clock_timestamp()) AND a.id IS DISTINCT FROM $2::uuid",[snapshot.account_id,actionId??null,policy.min_reply_interval_seconds])).rows[0];
  requireCondition(attempts.sent<policy.max_account_replies_per_day&&!attempts.cooling,'RATE_LIMITED','达到账号发送频率或每日上限，请稍后重试',429);
}
export async function conversationControl(scope:Scope,id:string,input:z.infer<typeof conversationControlInput>){
  requireWrite(scope);const value=conversationControlInput.parse(input),hash=digest({id,...value});
  return scoped(scope,async client=>{
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(conversation,'NOT_FOUND','会话不存在',404);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='conversation.controlled' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','控制请求内容已变化',409);return old.details.result;}
    requireCondition(conversation.control_version===value.expected_version,'VERSION_CONFLICT','会话处理权已变化，请刷新',409);
    if(value.mode==='AI')requireCondition(conversation.channel_kind==='FACEBOOK_MESSENGER','RECEPTION_UNAVAILABLE','只有客户主动私信可以恢复 AI 接待',409);
    const result=(await client.query('UPDATE kff.conversations SET handling_mode=$1,control_version=control_version+1 WHERE id=$2 RETURNING id,handling_mode,control_version',[value.mode,id])).rows[0];
    if(value.mode==='AI')await queueReceptionForConversation(client,id);
    const count=(await client.query("SELECT count(*)::int AS in_flight FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME')",[id])).rows[0];
    await audit(client,scope,'conversation.controlled',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,previous_mode:conversation.handling_mode,result:{...result,...count}});return {...result,...count};
  });
}
export async function queueConversationReply(client:PoolClient,scope:Scope,conversationId:string,options:{request_id:string;request_hash:string;body:string;refer_whatsapp:boolean;actor_kind:'AI'|'HUMAN';fixture_scenario?:'normal'|'slow'|'lost_after_submit'}){
  const ownership=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[conversationId])).rows[0];requireCondition(ownership,'NOT_FOUND','会话不存在',404);
  await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[ownership.account_id]);
  const conversation=(await client.query('SELECT v.*,i.remote_id,i.contact_target_id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.id=$1 FOR UPDATE OF v',[conversationId])).rows[0];
  requireCondition(conversation,'NOT_FOUND','会话不存在',404);
  const account=(await client.query('SELECT * FROM kff.accounts WHERE id=$1',[conversation.account_id])).rows[0];
  const connection=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1',[account.id])).rows[0];
  requireCondition(connection,'RECEPTION_UNAVAILABLE','当前会话尚未配置 Facebook 接待',409);
  const environment=(await client.query('SELECT e.*,g.status AS agent_status FROM kff.environments e JOIN kff.agents g ON g.id=e.agent_id WHERE e.id=$1 AND e.account_id=$2',[connection.environment_id,account.id])).rows[0];
  requireCondition(environment&&!['REVOKED','DRAINING','QUARANTINED'].includes(environment.agent_status),'AGENT_UNAVAILABLE','绑定的 Agent 暂不能接单',409);
  const trigger=(await client.query("SELECT * FROM kff.messages WHERE conversation_id=$1 AND sequence=$2 AND direction='INBOUND' AND message_kind='MESSAGE'",[conversation.id,conversation.last_inbound_sequence])).rows[0];
  requireCondition(trigger?.contact_permission_id,'CONTACT_BASIS_MISSING','缺少客户主动私信的有效服务依据',409);
  const permission=(await client.query('SELECT * FROM kff.contact_permissions WHERE id=$1',[trigger.contact_permission_id])).rows[0];
  const contact=contactSelectionSchema.parse({target_id:conversation.contact_target_id,permission_id:permission.id,purpose:'customer_service',account_id:account.id,channel:'facebook_messenger',remote_id:conversation.remote_id,target_version:permission.target_version,policy_hash:permission.policy_hash});
  let referral:NonNullable<TaskSnapshot['message']>['referral']=null,body=options.body;
  if(options.refer_whatsapp){const destination=await effectiveDestination(client,account.id);requireCondition(destination?.state==='ACTIVE','WHATSAPP_UNAVAILABLE','尚未配置可用的 WhatsApp',409);referral={destination_id:destination.id,destination_version:destination.version,phone:destination.phone,template:destination.template,cooldown_hours:destination.cooldown_hours};body=destination.template.replaceAll('{whatsapp_url}','https://wa.me/'+destination.phone).replaceAll('{whatsapp_number}',destination.phone);}
  requireCondition(body.trim().length>0&&body.length<=2000,'INVALID_INPUT','回复内容须为 1–2000 字符');
  const capability=(await client.query<Capability>('SELECT * FROM kff.capabilities WHERE account_id=$1 AND capability_key=$2 ORDER BY revision DESC LIMIT 1',[account.id,account.is_synthetic?'kff.fixture.messenger.reply.api':'facebook.messenger.reply.api'])).rows[0];
  requireCondition(capability,'CAPABILITY_BLOCKED','私信能力尚未配置',409);
  const template=await chooseTemplateVersion(client,capability.capability_key,capability.adapter_version);
  const snapshot=taskSnapshotSchema.parse({account_id:account.id,external_account_id:account.external_id,account_version:account.version,credential_ref:account.credential_ref,environment_id:environment.id,profile_key:environment.profile_key,agent_id:environment.agent_id,capability_id:capability.id,capability_key:capability.capability_key,capability_revision:capability.revision,adapter_version:capability.adapter_version,implementation_digest:capability.implementation_digest??null,platform_api_version:account.is_synthetic?null:process.env.KFF_FACEBOOK_GRAPH_VERSION??null,body,content_hash:digest(body),mode:account.is_synthetic?'TEST_ONLY':'PRODUCTION',template,fixture_scenario:account.is_synthetic?options.fixture_scenario??'normal':'normal',is_synthetic:account.is_synthetic,message:{conversation_id:conversation.id,trigger_message_id:trigger.id,trigger_sequence:trigger.sequence,control_version:conversation.control_version,actor_kind:options.actor_kind,actor_id:scope.user_id,connection_version:connection.version,contact,stop_epochs:await readStopEpochs(client,account.id,environment.agent_id),referral}});
  await messageSubmissionGate(client,snapshot);
  const content=(await client.query('INSERT INTO kff.content_versions(organization_id,brand_id,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[scope.organization_id,scope.brand_id,body,snapshot.content_hash,scope.user_id])).rows[0];
  const task=(await client.query("INSERT INTO kff.tasks(organization_id,brand_id,title,account_id,environment_id,capability_id,content_version_id,snapshot,snapshot_hash,idempotency_key,request_hash,created_by,status,conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'APPROVED',$13) RETURNING id",[scope.organization_id,scope.brand_id,(options.actor_kind==='AI'?'AI':'人工')+(referral?' WhatsApp 引流':' 私信回复'),account.id,environment.id,capability.id,content.id,snapshot,digest(snapshot),'reply_'+options.request_id,options.request_hash,scope.user_id,conversationId])).rows[0];
  await client.query("INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,'APPROVED',$5)",[scope.organization_id,scope.brand_id,task.id,digest(snapshot),scope.user_id]);
  const run=await enqueueTaskInTransaction(client,scope,task.id);
  const action=(await client.query('SELECT id FROM kff.actions WHERE run_id=$1',[run.id])).rows[0];
  if(referral)await client.query('INSERT INTO kff.whatsapp_referrals(organization_id,brand_id,account_id,customer_id,conversation_id,action_id,destination_id,destination_snapshot,actor_kind,actor_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[scope.organization_id,scope.brand_id,account.id,conversation.customer_id,conversation.id,action.id,referral.destination_id,referral,options.actor_kind,scope.user_id,trigger.source??{}]);
  await audit(client,scope,'conversation.reply_queued',conversationId,{action_id:action.id,run_id:run.id,actor_kind:options.actor_kind,control_version:conversation.control_version,referral:!!referral});
  return {task_id:task.id as string,run_id:run.id,action_id:action.id as string,control_version:Number(conversation.control_version)};
}
export async function sendConversationReply(scope:Scope,id:string,input:z.infer<typeof replyInput>,beforeCommit?:()=>Promise<void>){
  requireWrite(scope);const value=replyInput.parse(input),hash=digest({id,...value});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reply/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query('SELECT t.id,t.request_hash,r.id AS run_id,a.id AS action_id,t.snapshot FROM kff.tasks t JOIN kff.runs r ON r.task_id=t.id JOIN kff.actions a ON a.run_id=r.id WHERE t.idempotency_key=$1',['reply_'+value.request_id])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','此回复请求已有不同内容',409);return {task_id:old.id,run_id:old.run_id,action_id:old.action_id,control_version:old.snapshot.message.control_version};}
    const ownership=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(ownership,'NOT_FOUND','会话不存在',404);
    await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[ownership.account_id]);
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(conversation,'NOT_FOUND','会话不存在',404);
    requireCondition(conversation.control_version===value.expected_version,'VERSION_CONFLICT','会话处理权已变化，请刷新',409);
    // Only change the control version, never take run/action locks while holding this conversation lock.
    await client.query("UPDATE kff.conversations SET handling_mode='HUMAN',control_version=control_version+1 WHERE id=$1",[id]);
    const result=await queueConversationReply(client,scope,id,{request_id:value.request_id,request_hash:hash,body:value.body,refer_whatsapp:value.refer_whatsapp,actor_kind:'HUMAN',fixture_scenario:value.fixture_scenario});
    await audit(client,scope,'conversation.manual_takeover',id,{previous_mode:conversation.handling_mode,action_id:result.action_id});if(beforeCommit)await beforeCommit();return result;
  });
}
// Called inside the existing report/recovery/reconciliation transaction, including after a restart.
export async function projectMessageOutcome(client:PoolClient,actionId:string,snapshot:TaskSnapshot){
  const message=snapshot.message;if(!message)return;
  const action=(await client.query('SELECT state,receipt FROM kff.actions WHERE id=$1',[actionId])).rows[0];
  if(action.state!=='VERIFIED_SUCCEEDED'){
    const state=['UNKNOWN_OUTCOME','SUBMITTING','SUBMITTED'].includes(action.state)?'UNKNOWN':action.state==='CANCELED'?'CANCELED':['BLOCKED','VERIFIED_FAILED','NEEDS_HUMAN'].includes(action.state)?'FAILED':null;
    if(state)await client.query("UPDATE kff.whatsapp_referrals SET state=$1,version=version+1 WHERE action_id=$2 AND state IN ('QUEUED','UNKNOWN')",[state,actionId]);return;
  }
  if((await client.query('SELECT id FROM kff.messages WHERE action_id=$1',[actionId])).rowCount)return;
  const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[message.conversation_id])).rows[0];
  const updated=(await client.query('UPDATE kff.conversations SET last_sequence=last_sequence+1,last_message_at=clock_timestamp(),last_outbound_at=clock_timestamp(),last_answered_sequence=GREATEST(last_answered_sequence,$1) WHERE id=$2 RETURNING *',[message.trigger_sequence,conversation.id])).rows[0];
  const source=(await client.query('SELECT source FROM kff.messages WHERE id=$1',[message.trigger_message_id])).rows[0].source;
  const stored=(await client.query("INSERT INTO kff.messages(organization_id,brand_id,conversation_id,sequence,direction,body,received_at,contact_permission_id,action_id,actor_kind,source) VALUES($1,$2,$3,$4,'OUTBOUND',$5,clock_timestamp(),$6,$7,$8,$9) RETURNING id,received_at",[conversation.organization_id,conversation.brand_id,conversation.id,updated.last_sequence,snapshot.body,message.contact.permission_id,actionId,message.actor_kind,source])).rows[0];
  if(message.referral){
    await client.query("UPDATE kff.whatsapp_referrals SET state='REFERRED',message_id=$1,sent_at=$2,version=version+1 WHERE action_id=$3 AND state IN ('QUEUED','UNKNOWN','FAILED')",[stored.id,stored.received_at,actionId]);
    await client.query("UPDATE kff.customers SET lead_status=CASE WHEN lead_status IN ('BLOCKED','IGNORED','HANDOFF_COMPLETE') THEN lead_status ELSE 'WHATSAPP_REFERRED' END,version=version+1,updated_at=clock_timestamp() WHERE id=$1",[conversation.customer_id]);
    const connection=(await client.query('SELECT reception_policy FROM kff.facebook_connections WHERE account_id=$1',[snapshot.account_id])).rows[0];
    if(message.actor_kind==='AI'&&receptionPolicy.parse(connection?.reception_policy??{}).stop_after_referral)await client.query("UPDATE kff.conversations SET handling_mode='PAUSED',control_version=control_version+1 WHERE id=$1 AND handling_mode='AI' AND control_version=$2",[conversation.id,message.control_version]);
  }
  await audit(client,{organization_id:conversation.organization_id,brand_id:conversation.brand_id,user_id:message.actor_id,role:'operator'},'conversation.reply_confirmed',conversation.id,{action_id:actionId,message_id:stored.id,actor_kind:message.actor_kind,evidence_kind:action.receipt?.evidence_kind,referral:!!message.referral});
}
export async function referralResult(scope:Scope,id:string,input:z.infer<typeof referralResultInput>){
  requireWrite(scope);const value=referralResultInput.parse(input),hash=digest({id,...value});
  return scoped(scope,async client=>{
    const row=(await client.query('SELECT * FROM kff.whatsapp_referrals WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row,'NOT_FOUND','引流记录不存在',404);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='whatsapp.result_recorded' AND details->>'request_id'=$1",[value.request_id])).rows[0];if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','结果请求内容已变化',409);return old.details.result;}
    requireCondition(row.version===value.expected_version&&row.state==='REFERRED'&&row.message_id,'REFERRAL_NOT_CONFIRMED','只能为已确认发送的引流记录客户结果，请刷新',409);
    const result=(await client.query('UPDATE kff.whatsapp_referrals SET state=$1,confirmed_at=clock_timestamp(),version=version+1 WHERE id=$2 RETURNING id,state,version',[value.result,id])).rows[0];
    if(value.result==='CONFIRMED')await client.query("UPDATE kff.customers SET lead_status='HANDOFF_COMPLETE',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[row.customer_id]);
    await audit(client,scope,'whatsapp.result_recorded',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,result});return result;
  });
}
export async function conversationReception(scope:Scope,id:string){return scoped(scope,async client=>{
  const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(conversation,'NOT_FOUND','会话不存在',404);
  return {destination:await effectiveDestination(client,conversation.account_id)??null,referrals:(await client.query('SELECT r.*,a.state AS action_state,a.error_code,t.snapshot->>\'body\' AS body FROM kff.whatsapp_referrals r JOIN kff.actions a ON a.id=r.action_id JOIN kff.tasks t ON t.id=a.task_id WHERE r.conversation_id=$1 ORDER BY r.created_at DESC LIMIT 50',[id])).rows,
    replies:(await client.query('SELECT a.id,a.state,a.error_code,r.id AS run_id,t.snapshot->>\'body\' AS body,t.snapshot->\'message\'->>\'actor_kind\' AS actor_kind,a.created_at FROM kff.tasks t JOIN kff.actions a ON a.task_id=t.id JOIN kff.runs r ON r.id=a.run_id WHERE t.conversation_id=$1 ORDER BY a.created_at DESC LIMIT 50',[id])).rows,
    jobs:(await client.query("SELECT id,state,attempts,result,error_code,created_at FROM kff.jobs WHERE conversation_id=$1 AND kind='RECEPTION' ORDER BY created_at DESC LIMIT 20",[id])).rows};
});}
