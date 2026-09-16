import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {scoped,projectRoot} from '@kff/database';
import {browserEnvironmentSnapshot} from '../../contracts/src/environment';
import {browserMessageContext} from '../../contracts/src/browser-inbox';
import {adapterImplementationDigest} from './artifacts';
import {taskSnapshotSchema,type Scope,type TaskSnapshot,type Capability} from '@kff/contracts';
import {whatsappDestinationInput,conversationControlInput,replyInput,referralResultInput,receptionPolicy,browserConsentInput,receptionDraftReference,type WhatsappDestination} from '../../contracts/src/lead';
import {contactSelectionSchema,contactPolicy} from '../../contracts/src/contact';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite,enqueueTaskInTransaction} from './service';
import {assertContactBasisAtSubmission,grantContactPermission} from './contacts';
import {chooseTemplateVersion,ensureBundledTemplates} from './templates';
import {queueReceptionForConversation,receptionActivationLabels,type ReceptionActivationReason} from './reception-queue';
import {receptionDraftProviderStatus,validateReceptionDraft} from './reception-drafts';

export async function ensureMessengerCapability(client:PoolClient,scope:Scope,account:{id:string;is_synthetic:boolean},transport: string = 'API'){
  const browser=transport==='BROWSER';
  if(browser&&!account.is_synthetic){await client.query("INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,'facebook.messenger.reply.browser','facebook-browser-messenger-v1','UNASSESSED','DISABLED',false,'指定已收件会话的人工回复；需当前实现证据、明确同意及单次许可') ON CONFLICT DO NOTHING",[scope.organization_id,scope.brand_id,account.id]);await ensureBundledTemplates(client,scope);return;}
  await client.query("INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",[scope.organization_id,scope.brand_id,account.id,browser?'kff.fixture.messenger.reply.browser':account.is_synthetic?'kff.fixture.messenger.reply.api':'facebook.messenger.reply.api',browser?'fixture-browser-messenger-v1':account.is_synthetic?'fixture-messenger-v1':'facebook-messenger-v1',account.is_synthetic?'IMPLEMENTED_TEST_ONLY':'UNASSESSED',account.is_synthetic?'TEST_ONLY':'DISABLED',account.is_synthetic,account.is_synthetic?'本地合成 Messenger 接待；不访问真实平台':'Facebook 私信接待；真实凭据、权限及验证待完成']);
  await ensureBundledTemplates(client,scope);
}
export async function whatsappWorkspace(scope:Scope){return scoped(scope,async client=>({destinations:(await client.query<WhatsappDestination>('SELECT * FROM kff.whatsapp_destinations ORDER BY account_id NULLS FIRST,id')).rows}));}
export async function recordBrowserConsent(scope:Scope,id:string,input:unknown){
  requireAdmin(scope);const value=browserConsentInput.parse(input);
  requireCondition(Date.parse(value.consented_at)<=Date.now()&&Date.parse(value.expires_at)>Date.now(),'CONTACT_BASIS_EXPIRED','同意时间尚未发生或本次期限已过',409);
  const source=await scoped(scope,async client=>{
    const row=(await client.query("SELECT v.control_version,i.contact_target_id,m.id AS message_id,x.opted_out FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id JOIN kff.contact_targets x ON x.id=i.contact_target_id JOIN kff.accounts a ON a.id=v.account_id JOIN kff.facebook_connections f ON f.account_id=a.id JOIN kff.messages m ON m.conversation_id=v.id AND m.sequence=v.last_inbound_sequence AND m.direction='INBOUND' WHERE v.id=$1 AND v.channel_kind='FACEBOOK_BROWSER_MESSENGER' AND NOT a.is_synthetic AND a.account_type='profile' AND f.transport='BROWSER'",[id])).rows[0];
    requireCondition(row,'SOURCE_NOT_CONFIGURED','需先配置此真实浏览器会话的人工接待',409);requireCondition(row.control_version===value.expected_version,'VERSION_CONFLICT','会话已变化，请刷新',409);requireCondition(!row.opted_out,'CONTACT_OPTED_OUT','客户已退出，不能使用此入口恢复联系',409);return row;
  });
  return grantContactPermission(scope,{request_id:value.request_id,target_id:source.contact_target_id,resume_opt_out:false,policy:{basis_type:'explicit_consent',purpose:'customer_service',source_type:'manual_record',source_ref:'facebook-browser-inbound:'+source.message_id,source_observed_at:value.consented_at,source_use_status:'CONFIRMED',starts_at:value.consented_at,expires_at:value.expires_at,policy_ref:'kff.facebook-browser.explicit-consent.v1',window_rule:'EXPLICIT_END',window_expires_at:value.expires_at,evidence_note:value.evidence_note}});
}
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
  requireCondition(conversation&&conversation.channel_kind===(message.browser?'FACEBOOK_BROWSER_MESSENGER':'FACEBOOK_MESSENGER')&&(connection.transport==='BROWSER')===Boolean(message.browser)&&conversation.control_version===message.control_version&&conversation.handling_mode===message.actor_kind,'CONVERSATION_STALE','会话处理权已变化，旧任务失效',409);
  requireCondition(conversation.last_inbound_sequence===message.trigger_sequence,'INBOUND_SUPERSEDED','新消息已到达，停止旧回复',409);
  if(message.draft){
    const ref=message.draft,job=(await client.query("SELECT payload,result,state FROM kff.jobs WHERE id=$1 AND conversation_id=$2 AND kind='RECEPTION' FOR SHARE",[ref.job_id,conversation.id])).rows[0];
    requireCondition(message.actor_kind==='HUMAN'&&job?.state==='DONE'&&job.result?.status==='DRAFT_READY'&&job.payload.draft_only===true&&job.payload.account_id===snapshot.account_id&&job.payload.control_version+1===message.control_version&&job.payload.message_id===message.trigger_message_id&&job.payload.trigger_sequence===message.trigger_sequence&&job.payload.connection_version===message.connection_version&&digest(job.payload.stop_epochs)===digest(message.stop_epochs)&&digest(job.result)===ref.result_hash&&job.result.model===ref.model&&job.result.generated_at===ref.generated_at&&job.payload.draft_expires_at===ref.expires_at&&Date.parse(ref.expires_at)>Math.max(Date.now(),Date.parse(snapshot.not_before??'' )||0),'DRAFT_STALE','所采用的建议已失效，请重新生成并审核',409);
  }
  requireCondition(!['BLOCKED','IGNORED','HANDOFF_COMPLETE'].includes(conversation.lead_status)&&conversation.stage!=='OPTED_OUT','LEAD_STOPPED','客户已停止自动接待',409);
  requireCondition(message.actor_kind!=='AI'||(connection.auto_reply&&conversation.last_answered_sequence<message.trigger_sequence),'ALREADY_ANSWERED','此咨询已被回复或自动接待已暂停',409);
  requireCondition(digest(await readStopEpochs(client,snapshot.account_id,snapshot.agent_id))===digest(message.stop_epochs),'STOP_EPOCH_STALE','停止状态曾发生变化，旧任务失效',409);
  const active=await client.query("SELECT a.id FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND a.id IS DISTINCT FROM $2::uuid AND a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME') LIMIT 1",[conversation.id,actionId??null]);
  requireCondition(!active.rowCount,'MESSAGE_IN_FLIGHT','此会话仍有发送在途或结果未知，需先核验原消息',409);
  const trigger=(await client.query("SELECT m.id,m.body,m.source FROM kff.messages m WHERE m.id=$1 AND m.conversation_id=$2 AND m.sequence=$3 AND m.direction='INBOUND' AND m.message_kind='MESSAGE'",[message.trigger_message_id,conversation.id,message.trigger_sequence])).rows[0];
  requireCondition(trigger,'MESSAGE_IDENTITY_MISMATCH','触发消息不属于当前会话',409);
  if(snapshot.capability_key==='facebook.messenger.reply.browser'){
    requireCondition(snapshot.mode==='CONTROLLED_PILOT'&&message.actor_kind==='HUMAN'&&!connection.auto_reply&&connection.policy_ref==='kff.facebook-browser.explicit-consent.v1'&&trigger.source?.peer_id===message.browser?.peer_id&&trigger.source?.source_id===message.browser?.trigger_remote_message_id&&digest(trigger.body)===message.browser?.trigger_content_hash,'RECEPTION_CONFIG_STALE','真实回复只接受已核对来信和人工试验配置',409);
    const recorded=(await client.query('SELECT policy FROM kff.contact_permissions WHERE id=$1 AND target_id=$2',[message.contact.permission_id,message.contact.target_id])).rows[0];
    const policy=contactPolicy.parse(recorded?.policy);
    requireCondition(policy.basis_type==='explicit_consent'&&policy.purpose==='customer_service'&&policy.source_type==='manual_record'&&policy.policy_ref==='kff.facebook-browser.explicit-consent.v1'&&policy.source_ref==='facebook-browser-inbound:'+trigger.id&&policy.window_rule==='EXPLICIT_END'&&Date.parse(policy.expires_at)-Date.parse(policy.starts_at)<=3600000,'CONTACT_NEW_CONSENT_REQUIRED','真实浏览器回复需要关联此条来信、最长一小时的明确同意记录',409);
  }
  requireCondition(message.contact.account_id===snapshot.account_id&&message.contact.channel===(message.browser?'facebook_browser_messenger':'facebook_messenger'),'FORBIDDEN_SCOPE','接待依据与当前账号不匹配',403);
  await assertContactBasisAtSubmission(client,message.contact);
  if(message.referral){
    const destination=await effectiveDestination(client,snapshot.account_id);
    requireCondition(destination?.state==='ACTIVE'&&destination.id===message.referral.destination_id&&destination.version===message.referral.destination_version&&destination.phone===message.referral.phone,'WHATSAPP_CHANGED','WhatsApp 已暂停或配置变化，停止旧引流',409);
    const correction=message.referral.corrects_referral_id;
    if(correction){
      const original=(await client.query("SELECT r.state,r.destination_snapshot,a.state AS action_state,(SELECT count(*)::int FROM kff.agent_commands c WHERE c.action_id=a.id) AS commands,NOT EXISTS(SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id AND (c.quiesced_at IS NULL OR (c.claimed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM kff.audit_events e WHERE e.object_id=c.id AND e.event_type='guardian.quiesced')))) AS closed FROM kff.whatsapp_referrals r JOIN kff.actions a ON a.id=r.action_id WHERE r.id=$1 AND r.conversation_id=$2 AND r.account_id=$3 FOR SHARE OF r",[correction,conversation.id,snapshot.account_id])).rows[0];
      requireCondition(message.actor_kind==='HUMAN'&&original?.state==='REFERRED'&&original.action_state==='VERIFIED_SUCCEEDED'&&original.commands>0&&original.closed&&original.destination_snapshot.phone!==destination.phone,'REFERRAL_CORRECTION_INVALID','只能明确更正本会话已确认发送并关闭、尚未确认实收且号码不同的原邀请',409);
      requireCondition(!(await client.query("SELECT 1 FROM kff.audit_events WHERE object_id=$1 AND event_type='whatsapp.invitation_corrected' LIMIT 1",[correction])).rowCount,'REFERRAL_SUPERSEDED','原邀请已更正，不能再次使用同一更正依据',409);
    }
    const previous=await client.query("SELECT r.id FROM kff.whatsapp_referrals r JOIN kff.actions a ON a.id=r.action_id JOIN kff.tasks t ON t.id=a.task_id WHERE r.conversation_id=$1 AND r.action_id IS DISTINCT FROM $2::uuid AND r.id IS DISTINCT FROM $5::uuid AND (a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME') OR (a.state IN ('QUEUED','PREPARING') AND (t.snapshot->'message'->>'control_version')::int=$4) OR (r.sent_at>clock_timestamp()-make_interval(hours=>$3) AND r.state IN ('REFERRED','CONFIRMED','DECLINED'))) LIMIT 1",[conversation.id,actionId??null,destination.cooldown_hours,message.control_version,correction??null]);
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
    if(value.mode==='AI'){const connection=(await client.query('SELECT transport,is_synthetic FROM kff.facebook_connections WHERE account_id=$1',[conversation.account_id])).rows[0];requireCondition(connection?.transport!=='BROWSER'||connection.is_synthetic,'SOURCE_NOT_CONFIGURED','真实浏览器回复当前需要逐条人工批准',409);requireCondition(conversation.channel_kind==='FACEBOOK_MESSENGER'&&connection?.transport!=='BROWSER'||conversation.channel_kind==='FACEBOOK_BROWSER_MESSENGER'&&connection?.transport==='BROWSER','RECEPTION_UNAVAILABLE','当前会话尚未配置对应的接待渠道',409);}
    const result=(await client.query('UPDATE kff.conversations SET handling_mode=$1,control_version=control_version+1 WHERE id=$2 RETURNING id,handling_mode,control_version',[value.mode,id])).rows[0];
    // Choosing AI mode and actually running reception are different facts. The queue inspects the
    // real gate and reports the blocker (paused connection, auto reply off, nothing pending, ...),
    // which is returned and audited so the operator is not left believing reception resumed.
    // Reading the reason never turns an account switch back on.
    let reception_status:{active:boolean;reason:ReceptionActivationReason;label:string;job_id:string|null}|null=null;
    if(value.mode==='AI'){
      const queued=await queueReceptionForConversation(client,id);
      // `active` is what actually happened: a job is behind this conversation. The mode alone is
      // never reported as running reception.
      reception_status={active:Boolean(queued.job_id),reason:queued.status.reason,label:receptionActivationLabels[queued.status.reason],job_id:queued.job_id};
    }
    const count=(await client.query("SELECT count(*)::int AS in_flight FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME')",[id])).rows[0];
    await audit(client,scope,'conversation.controlled',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,previous_mode:conversation.handling_mode,reception_status,result:{...result,...count}});return {...result,...count,reception_status};
  });
}
type ReplyOptions={request_id:string;request_hash:string;body:string;refer_whatsapp:boolean;corrects_referral_id?:string;actor_kind:'AI'|'HUMAN';draft?:z.infer<typeof receptionDraftReference>;fixture_scenario?:z.infer<typeof replyInput>['fixture_scenario'];prepare_only?:boolean;delay_minutes?:number;contact_permission_id?:string};
export function queueConversationReply(client:PoolClient,scope:Scope,id:string,options:ReplyOptions&{prepare_only:true}):Promise<{task_id:string;status:'AWAITING_PILOT_PERMIT'}>;
export function queueConversationReply(client:PoolClient,scope:Scope,id:string,options:ReplyOptions&{prepare_only?:false}):Promise<{task_id:string;run_id:string;action_id:string;control_version:number}>;
export async function queueConversationReply(client:PoolClient,scope:Scope,conversationId:string,options:ReplyOptions){
  const ownership=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[conversationId])).rows[0];requireCondition(ownership,'NOT_FOUND','会话不存在',404);
  await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[ownership.account_id]);
  const conversation=(await client.query('SELECT v.*,i.remote_id,i.contact_target_id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.id=$1 FOR UPDATE OF v',[conversationId])).rows[0];
  requireCondition(conversation,'NOT_FOUND','会话不存在',404);
  const account=(await client.query('SELECT * FROM kff.accounts WHERE id=$1',[conversation.account_id])).rows[0];
  const connection=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1',[account.id])).rows[0];
  requireCondition(connection&&conversation.channel_kind===(connection.transport==='BROWSER'?'FACEBOOK_BROWSER_MESSENGER':'FACEBOOK_MESSENGER'),'RECEPTION_UNAVAILABLE','当前会话尚未配置对应的 Facebook 接待渠道',409);
  const browser=connection.transport==='BROWSER';
  requireCondition(browser||['normal','slow','lost_after_submit'].includes(options.fixture_scenario??'normal'),'INVALID_INPUT','此合成场景需要浏览器接待渠道');
  const realBrowser=browser&&!account.is_synthetic;
  requireCondition(!realBrowser||options.prepare_only&&options.actor_kind==='HUMAN'&&options.contact_permission_id&&account.account_type==='profile','CONTACT_BASIS_MISSING','真实浏览器回复须以明确同意记录准备单次人工试验',409);
  requireCondition(realBrowser||!options.contact_permission_id,'INVALID_INPUT','此渠道不能替换原来信服务依据');
  const environment=(await client.query('SELECT e.*,g.status AS agent_status FROM kff.environments e JOIN kff.agents g ON g.id=e.agent_id WHERE e.id=$1 AND e.account_id=$2',[connection.environment_id,account.id])).rows[0];
  requireCondition(environment&&!['REVOKED','DRAINING','QUARANTINED'].includes(environment.agent_status),'AGENT_UNAVAILABLE','绑定的 Agent 暂不能接单',409);
  const trigger=(await client.query("SELECT * FROM kff.messages WHERE conversation_id=$1 AND sequence=$2 AND direction='INBOUND' AND message_kind='MESSAGE'",[conversation.id,conversation.last_inbound_sequence])).rows[0];
  requireCondition(trigger&&(realBrowser?options.contact_permission_id:trigger.contact_permission_id),'CONTACT_BASIS_MISSING','缺少客户主动私信或明确同意的有效联系依据',409);
  const permission=(await client.query('SELECT * FROM kff.contact_permissions WHERE id=$1 AND target_id=$2',[realBrowser?options.contact_permission_id:trigger.contact_permission_id,conversation.contact_target_id])).rows[0];
  requireCondition(permission,'CONTACT_BASIS_MISSING','联系依据不属于此会话',409);
  const contact=contactSelectionSchema.parse({target_id:conversation.contact_target_id,permission_id:permission.id,purpose:'customer_service',account_id:account.id,channel:browser?'facebook_browser_messenger':'facebook_messenger',remote_id:conversation.remote_id,target_version:permission.target_version,policy_hash:permission.policy_hash});
  let referral:NonNullable<TaskSnapshot['message']>['referral']=null,body=options.body;
  requireCondition(!options.corrects_referral_id||options.refer_whatsapp&&options.actor_kind==='HUMAN','REFERRAL_CORRECTION_INVALID','更正邀请需要人工明确指定原 WhatsApp 移交',409);
  if(options.refer_whatsapp){const destination=await effectiveDestination(client,account.id);requireCondition(destination?.state==='ACTIVE','WHATSAPP_UNAVAILABLE','尚未配置可用的 WhatsApp',409);referral={destination_id:destination.id,destination_version:destination.version,phone:destination.phone,template:destination.template,cooldown_hours:destination.cooldown_hours,...(options.corrects_referral_id?{corrects_referral_id:options.corrects_referral_id}:{})};body=destination.template.replaceAll('{whatsapp_url}','https://wa.me/'+destination.phone).replaceAll('{whatsapp_number}',destination.phone);if(options.corrects_referral_id)body='号码更正：上一条邀请中的号码有误。'+body;}
  requireCondition(body.trim().length>0&&body.length<=2000,'INVALID_INPUT','回复内容须为 1–2000 字符');
  const capability=(await client.query<Capability>('SELECT * FROM kff.capabilities WHERE account_id=$1 AND capability_key=$2 ORDER BY revision DESC LIMIT 1',[account.id,realBrowser?'facebook.messenger.reply.browser':browser?'kff.fixture.messenger.reply.browser':account.is_synthetic?'kff.fixture.messenger.reply.api':'facebook.messenger.reply.api'])).rows[0];
  requireCondition(capability,'CAPABILITY_BLOCKED','私信能力尚未配置',409);
  const template=await chooseTemplateVersion(client,capability.capability_key,capability.adapter_version);
  const last=(await client.query("SELECT CASE WHEN m.direction='OUTBOUND' THEN a.receipt->>'remote_id' ELSE m.source->>'source_id' END AS remote_id FROM kff.messages m LEFT JOIN kff.actions a ON a.id=m.action_id WHERE m.conversation_id=$1 ORDER BY m.sequence DESC LIMIT 1",[conversation.id])).rows[0];
  const browserContext=browser?browserMessageContext.parse({thread_id:conversation.remote_id,peer_id:trigger.source?.peer_id,trigger_remote_message_id:trigger.source?.source_id,last_seen_message_id:last?.remote_id,source_url:trigger.source?.source_url,...(realBrowser?{display_name:trigger.client_display_name,trigger_content_hash:digest(trigger.body)}:{})}):undefined;
  const browserEnvironment=browser?browserEnvironmentSnapshot.parse({environment_id:environment.id,account_id:account.id,agent_id:environment.agent_id,organization_id:scope.organization_id,brand_id:scope.brand_id,profile_key:environment.profile_key,configuration_version:environment.configuration_version,configuration:environment.browser_configuration,...(account.account_type==='profile'?{account_type:'profile'}:{}),platform:account.platform,is_synthetic:account.is_synthetic}):undefined;
  const snapshot=taskSnapshotSchema.parse({browser_environment:browserEnvironment,account_id:account.id,external_account_id:account.external_id,account_version:account.version,credential_ref:account.credential_ref,environment_id:environment.id,environment_version:environment.configuration_version??1,profile_key:environment.profile_key,agent_id:environment.agent_id,capability_id:capability.id,capability_key:capability.capability_key,capability_revision:capability.revision,adapter_version:capability.adapter_version,implementation_digest:account.is_synthetic?null:adapterImplementationDigest(projectRoot,'facebook'),platform_api_version:account.is_synthetic||browser?null:process.env.KFF_FACEBOOK_GRAPH_VERSION??null,body,content_hash:digest(body),not_before:new Date(Date.now()+(options.delay_minutes??0)*60000).toISOString(),mode:account.is_synthetic?'TEST_ONLY':options.prepare_only?'CONTROLLED_PILOT':'PRODUCTION',template,fixture_scenario:account.is_synthetic?options.fixture_scenario??'normal':'normal',is_synthetic:account.is_synthetic,message:{browser:browserContext,draft:options.draft,conversation_id:conversation.id,trigger_message_id:trigger.id,trigger_sequence:trigger.sequence,control_version:conversation.control_version,actor_kind:options.actor_kind,actor_id:scope.user_id,connection_version:connection.version,contact,stop_epochs:await readStopEpochs(client,account.id,environment.agent_id),referral}});
  await messageSubmissionGate(client,snapshot);
  const content=(await client.query('INSERT INTO kff.content_versions(organization_id,brand_id,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[scope.organization_id,scope.brand_id,body,snapshot.content_hash,scope.user_id])).rows[0];
  const task=(await client.query("INSERT INTO kff.tasks(organization_id,brand_id,title,account_id,environment_id,capability_id,content_version_id,snapshot,snapshot_hash,idempotency_key,request_hash,created_by,status,conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'APPROVED',$13) RETURNING id",[scope.organization_id,scope.brand_id,(options.actor_kind==='AI'?'AI':'人工')+(referral?' WhatsApp 引流':' 私信回复'),account.id,environment.id,capability.id,content.id,snapshot,digest(snapshot),'reply_'+options.request_id,options.request_hash,scope.user_id,conversationId])).rows[0];
  await client.query("INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,'APPROVED',$5)",[scope.organization_id,scope.brand_id,task.id,digest(snapshot),scope.user_id]);
  if(options.prepare_only){requireCondition(!account.is_synthetic,'FORBIDDEN_SCOPE','本入口仅准备真实私信试验');return {task_id:task.id as string,status:'AWAITING_PILOT_PERMIT' as const};}
  const run=await enqueueTaskInTransaction(client,scope,task.id);
  const action=(await client.query('SELECT id FROM kff.actions WHERE run_id=$1',[run.id])).rows[0];
  if(options.delay_minutes)await client.query('UPDATE kff.jobs SET available_at=clock_timestamp()+make_interval(mins=>$1) WHERE action_id=$2',[options.delay_minutes,action.id]);
  if(referral)await client.query('INSERT INTO kff.whatsapp_referrals(organization_id,brand_id,account_id,customer_id,conversation_id,action_id,destination_id,destination_snapshot,actor_kind,actor_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[scope.organization_id,scope.brand_id,account.id,conversation.customer_id,conversation.id,action.id,referral.destination_id,referral,options.actor_kind,scope.user_id,trigger.source??{}]);
  await audit(client,scope,'conversation.reply_queued',conversationId,{action_id:action.id,run_id:run.id,actor_kind:options.actor_kind,control_version:conversation.control_version,referral:!!referral});
  return {task_id:task.id as string,run_id:run.id,action_id:action.id as string,control_version:Number(conversation.control_version)};
}
export async function sendConversationReply(scope:Scope,id:string,input:z.input<typeof replyInput>,beforeCommit?:()=>Promise<void>){
  requireWrite(scope);const value=replyInput.parse(input),hash=digest({id,...value});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reply/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query('SELECT t.id,t.request_hash,r.id AS run_id,a.id AS action_id,t.snapshot FROM kff.tasks t JOIN kff.runs r ON r.task_id=t.id JOIN kff.actions a ON a.run_id=r.id WHERE t.idempotency_key=$1',['reply_'+value.request_id])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','此回复请求已有不同内容',409);return {task_id:old.id,run_id:old.run_id,action_id:old.action_id,control_version:old.snapshot.message.control_version};}
    const ownership=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(ownership,'NOT_FOUND','会话不存在',404);
    await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[ownership.account_id]);
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(conversation,'NOT_FOUND','会话不存在',404);
    requireCondition(conversation.control_version===value.expected_version,'VERSION_CONFLICT','会话处理权已变化，请刷新',409);
    const draft=value.draft_job_id?await validateReceptionDraft(client,value.draft_job_id,conversation):undefined;
    // Only change the control version, never take run/action locks while holding this conversation lock.
    await client.query("UPDATE kff.conversations SET handling_mode='HUMAN',control_version=control_version+1 WHERE id=$1",[id]);
    const result=await queueConversationReply(client,scope,id,{request_id:value.request_id,request_hash:hash,body:value.body,refer_whatsapp:value.refer_whatsapp,corrects_referral_id:value.corrects_referral_id,actor_kind:'HUMAN',draft,fixture_scenario:value.fixture_scenario,delay_minutes:value.delay_minutes});
    await audit(client,scope,'conversation.manual_takeover',id,{previous_mode:conversation.handling_mode,action_id:result.action_id});if(beforeCommit)await beforeCommit();return result;
  });
}
// Called inside the existing report/recovery/reconciliation transaction, including after a restart.
export async function prepareMessengerPilot(scope:Scope,id:string,input:unknown){
  requireAdmin(scope);const v=replyInput.parse(input),hash=digest({id,pilot:true,...v});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reply/'+scope.brand_id+'/'+v.request_id]);
    const old=(await client.query("SELECT id,request_hash FROM kff.tasks WHERE idempotency_key=$1",['reply_'+v.request_id])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','同一请求已有不同内容',409);return {task_id:old.id,status:'AWAITING_PILOT_PERMIT'};}
    const ownership=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(ownership,'NOT_FOUND','会话不存在',404);
    await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[ownership.account_id]);
    const c=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    requireCondition(c?.control_version===v.expected_version,'VERSION_CONFLICT','会话已变化，请刷新',409);
    const draft=v.draft_job_id?await validateReceptionDraft(client,v.draft_job_id,c):undefined;
    await client.query("UPDATE kff.conversations SET handling_mode='HUMAN',control_version=control_version+1 WHERE id=$1",[id]);
    const result=await queueConversationReply(client,scope,id,{request_id:v.request_id,request_hash:hash,body:v.body,refer_whatsapp:v.refer_whatsapp,corrects_referral_id:v.corrects_referral_id,actor_kind:'HUMAN',draft,prepare_only:true,delay_minutes:v.delay_minutes,contact_permission_id:v.contact_permission_id});
    await audit(client,scope,'conversation.pilot_prepared',id,{task_id:result.task_id});return result;
  });
}
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
    const referral=(await client.query("UPDATE kff.whatsapp_referrals SET state='REFERRED',message_id=$1,sent_at=$2,version=version+1 WHERE action_id=$3 AND state IN ('QUEUED','UNKNOWN','FAILED') RETURNING id",[stored.id,stored.received_at,actionId])).rows[0];
    if(referral&&message.referral.corrects_referral_id)await audit(client,{organization_id:conversation.organization_id,brand_id:conversation.brand_id,user_id:message.actor_id,role:'operator'},'whatsapp.invitation_corrected',message.referral.corrects_referral_id,{corrected_by_referral_id:referral.id,correcting_action_id:actionId,conversation_id:conversation.id,phone:message.referral.phone});
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
    requireCondition(!(await client.query("SELECT 1 FROM kff.audit_events WHERE object_id=$1 AND event_type='whatsapp.invitation_corrected' LIMIT 1",[id])).rowCount,'REFERRAL_SUPERSEDED','此邀请号码已更正，请核对新的邀请记录',409);
    const result=(await client.query('UPDATE kff.whatsapp_referrals SET state=$1,confirmed_at=clock_timestamp(),version=version+1 WHERE id=$2 RETURNING id,state,version',[value.result,id])).rows[0];
    if(value.result==='CONFIRMED')await client.query("UPDATE kff.customers SET lead_status='HANDOFF_COMPLETE',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[row.customer_id]);
    await audit(client,scope,'whatsapp.result_recorded',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,result});return result;
  });
}
interface PublicConversationInteraction {
  task_id:string;action_id:string;run_id:string;lead_id:string;peer_id:string;
  source_body:string;source_url:string;reply_body:string;reply_url:string;verified_at:string;first_inbox_at:string;
}
/** Historical same-profile records only: no customer merge, causal attribution or permission change. */
async function publicConversationInteractions(client:PoolClient,conversationId:string,accountId:string) {
  return (await client.query<PublicConversationInteraction>(`
    WITH sender AS (
      SELECT min(m.source->>'peer_id') AS peer_id,count(DISTINCT m.source->>'peer_id') AS identities,
             min(m.received_at) AS first_inbox_at
      FROM kff.messages m JOIN kff.inbound_events e ON e.id=m.inbound_event_id
      JOIN kff.conversations v ON v.id=m.conversation_id JOIN kff.accounts ac ON ac.id=v.account_id
      WHERE v.id=$1 AND v.account_id=$2 AND v.channel_kind='FACEBOOK_BROWSER_MESSENGER' AND NOT ac.is_synthetic
        AND m.direction='INBOUND' AND m.message_kind='MESSAGE' AND e.source_kind='facebook_browser'
        AND m.source->>'transport'='BROWSER' AND e.source_details ? 'browser_evidence'
    )
    SELECT t.id AS task_id,a.id AS action_id,a.run_id,l.lead_id,s.peer_id,s.first_inbox_at,
           t.snapshot->'outreach'->'browser'->>'source_body' AS source_body,
           t.snapshot->'outreach'->'browser'->>'comment_url' AS source_url,
           t.snapshot->>'body' AS reply_body,a.receipt->>'source_url' AS reply_url,
           a.receipt->>'observed_at' AS verified_at
    FROM sender s JOIN kff.acquisition_action_links l ON l.account_id=$2 AND l.author_id=s.peer_id
    JOIN kff.tasks t ON t.id=l.task_id AND t.account_id=l.account_id
    JOIN kff.actions a ON a.task_id=t.id JOIN kff.accounts ac ON ac.id=t.account_id
    WHERE s.identities=1 AND s.peer_id ~ '^[0-9]{1,128}$' AND l.platform='facebook' AND l.action_kind='COMMENT_REPLY'
      AND t.snapshot->>'capability_key'='facebook.comment.reply.browser' AND t.snapshot->'outreach'->>'author_id'=s.peer_id
      AND a.state='VERIFIED_SUCCEEDED' AND a.receipt->>'evidence_kind'='browser_comment'
      AND a.receipt->>'recipient_id'=s.peer_id AND a.receipt->>'actual_account_id'=ac.external_id
      AND EXISTS(SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id AND c.quiesced_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id AND c.quiesced_at IS NULL)
    ORDER BY a.created_at DESC,a.id DESC LIMIT 20`,[conversationId,accountId])).rows;
}
export async function conversationReception(scope:Scope,id:string){return scoped(scope,async client=>{
  const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(conversation,'NOT_FOUND','会话不存在',404);
  const connection=(await client.query('SELECT reception_policy FROM kff.facebook_connections WHERE account_id=$1',[conversation.account_id])).rows[0];
  const jobs=(await client.query("SELECT id,state,attempts,result,error_code,created_at,COALESCE(payload->>'draft_only'='true',false) AS draft_only FROM kff.jobs WHERE conversation_id=$1 AND kind='RECEPTION' ORDER BY created_at DESC LIMIT 20",[id])).rows;
  for(const job of jobs){job.draft_usable=false;if(job.draft_only&&job.result?.status==='DRAFT_READY'){try{await validateReceptionDraft(client,job.id,conversation);job.draft_usable=true;}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&['DRAFT_STALE','DRAFT_NOT_REPLY'].includes(String(error.code))))throw error;}}}
  return {drafting:{...receptionDraftProviderStatus(receptionPolicy.parse(connection?.reception_policy??{}).provider),unanswered:conversation.last_inbound_sequence>conversation.last_answered_sequence},destination:await effectiveDestination(client,conversation.account_id)??null,referrals:(await client.query('SELECT r.*,a.state AS action_state,a.error_code,t.snapshot->>\'body\' AS body FROM kff.whatsapp_referrals r JOIN kff.actions a ON a.id=r.action_id JOIN kff.tasks t ON t.id=a.task_id WHERE r.conversation_id=$1 ORDER BY r.created_at DESC LIMIT 50',[id])).rows,
    manual_permissions:(await client.query<{id:string;evidence_note:string;expires_at:string}>("SELECT p.id,p.policy->>'evidence_note' evidence_note,p.policy->>'expires_at' expires_at FROM kff.contact_permissions p JOIN kff.contact_targets x ON x.id=p.target_id JOIN kff.customer_identities i ON i.contact_target_id=x.id JOIN kff.messages m ON m.conversation_id=$1 AND m.sequence=$2 AND m.direction='INBOUND' WHERE i.id=$3 AND NOT x.opted_out AND p.target_version=x.version AND p.revoked_at IS NULL AND p.policy->>'policy_ref'='kff.facebook-browser.explicit-consent.v1' AND p.policy->>'source_ref'='facebook-browser-inbound:'||m.id::text AND (p.policy->>'expires_at')::timestamptz>clock_timestamp() ORDER BY p.created_at DESC LIMIT 20",[id,conversation.last_inbound_sequence,conversation.identity_id])).rows,
    replies:(await client.query('SELECT a.id,a.state,a.error_code,r.id AS run_id,t.snapshot->>\'body\' AS body,t.snapshot->\'message\'->>\'actor_kind\' AS actor_kind,a.created_at FROM kff.tasks t JOIN kff.actions a ON a.task_id=t.id JOIN kff.runs r ON r.id=a.run_id WHERE t.conversation_id=$1 ORDER BY a.created_at DESC LIMIT 50',[id])).rows,
    public_interactions:await publicConversationInteractions(client,id,conversation.account_id),jobs};
});}
