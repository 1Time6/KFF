import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {query,scoped} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {contactPolicy} from '../../contracts/src/contact';
import {facebookConnectionInput,facebookFixtureInput,facebookEvent,type FacebookEvent,type FacebookConnection} from '../../contracts/src/lead';
import {normalizeFacebookEvents,verifyFacebookSignature} from '../../adapters/src/facebook-events';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite} from './service';
import {ensureMessengerCapability} from './lead-reception';
import {queueReceptionForConversation} from './reception-queue';
import {explicitContactExit} from '../../adapters/src/reception-model';

export async function facebookWorkspace(scope:Scope){return scoped(scope,async client=>({connections:(await client.query<FacebookConnection>('SELECT f.*,a.display_name FROM kff.facebook_connections f JOIN kff.accounts a ON a.id=f.account_id ORDER BY f.created_at,f.account_id')).rows,real_platform_status:'BLOCKED_REAL_PLATFORM' as const}));}
export async function configureFacebook(scope:Scope,input:z.infer<typeof facebookConnectionInput>){
  requireAdmin(scope);const value=facebookConnectionInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['facebook-config/'+value.account_id]);
    const previous=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='facebook.configured' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(previous){requireCondition(previous.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求已用于不同配置',409);return previous.details.result;}
    const account=(await client.query("SELECT a.* FROM kff.accounts a JOIN kff.environments e ON e.account_id=a.id WHERE a.id=$1 AND e.id=$2 AND a.platform='facebook' AND a.account_type='page'",[value.account_id,value.environment_id])).rows[0];
    requireCondition(account,'FORBIDDEN_SCOPE','Facebook 账号与 Agent 环境必须属于本品牌并相互匹配',403);
    await ensureMessengerCapability(client,scope,account);
    const old=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1 FOR UPDATE',[value.account_id])).rows[0];
    requireCondition((old?.version??0)===value.expected_version,'VERSION_CONFLICT','接待配置已变化，请刷新',409);
    const result=old?(await client.query('UPDATE kff.facebook_connections SET environment_id=$1,state=$2,auto_reply=$3,reply_window_hours=$4,policy_ref=$5,version=version+1 WHERE account_id=$6 RETURNING *',[value.environment_id,value.state,value.auto_reply,value.reply_window_hours,value.policy_ref,value.account_id])).rows[0]
      :(await client.query('INSERT INTO kff.facebook_connections(account_id,organization_id,brand_id,environment_id,page_id,is_synthetic,state,auto_reply,reply_window_hours,policy_ref,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[account.id,scope.organization_id,scope.brand_id,value.environment_id,account.external_id,account.is_synthetic,value.state,value.auto_reply,value.reply_window_hours,value.policy_ref,scope.user_id])).rows[0];
    await audit(client,scope,'facebook.configured',account.id,{request_id:value.request_id,request_hash:hash,result});return result;
  });
}
export async function createFacebookFixture(scope:Scope,input:z.infer<typeof facebookFixtureInput>){
  requireAdmin(scope);const value=facebookFixtureInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['facebook-fixture/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='facebook.fixture_created' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求已用于不同合成账号',409);return old.details.result as {account_id:string;environment_id:string};}
    requireCondition((await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status<>'REVOKED'",[value.agent_id])).rowCount,'FORBIDDEN_SCOPE','Agent 不属于当前品牌或已撤销',403);
    const account=(await client.query("INSERT INTO kff.accounts(organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,'facebook','page',$4,'ACTIVE',true) RETURNING id",[scope.organization_id,scope.brand_id,value.name,value.page_id])).rows[0];
    const environment=(await client.query('INSERT INTO kff.environments(organization_id,brand_id,name,account_id,agent_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[scope.organization_id,scope.brand_id,value.name+' · 本地验证',account.id,value.agent_id])).rows[0];
    const result={account_id:account.id as string,environment_id:environment.id as string};
    await audit(client,scope,'facebook.fixture_created',account.id,{request_id:value.request_id,request_hash:hash,result,is_synthetic:true});return result;
  });
}
export async function receiveFacebookEvent(scope:Scope,accountId:string,input:FacebookEvent,beforeCommit?:()=>Promise<void>){
  const value=facebookEvent.parse(input),hash=digest(value);
  requireCondition(Date.parse(value.occurred_at)<=Date.now()+300000,'INVALID_INPUT','互动时间不能来自未来');
  return scoped(scope,async client=>{
    const connection=(await client.query('SELECT f.*,a.outbound_paused,a.state AS account_state FROM kff.facebook_connections f JOIN kff.accounts a ON a.id=f.account_id WHERE f.account_id=$1 FOR SHARE OF f',[accountId])).rows[0];
    requireCondition(connection&&connection.page_id===value.page_id,'ACCOUNT_MISMATCH','事件与当前 Facebook 账号不匹配',403);
    const key=accountId+'/'+value.event_id;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['facebook-event/'+key]);
    // Serialize identity creation and per-conversation sequence. Duplicate requests also take this lock.
    const channel=value.kind==='COMMENT'?'facebook_comment':value.kind==='INTERACTION'?'facebook_interaction':'facebook_messenger';
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[accountId+'/'+channel+'/'+value.sender_id]);
    const old=(await client.query("SELECT id,payload_hash FROM kff.inbound_events WHERE source_kind='facebook' AND source_key=$1",[key])).rows[0];
    if(old){requireCondition(old.payload_hash===hash,'IDEMPOTENCY_CONFLICT','同一 Facebook 事件已保存不同内容',409);const message=(await client.query('SELECT id,conversation_id FROM kff.messages WHERE inbound_event_id=$1',[old.id])).rows[0];return {event_id:old.id,message_id:message?.id,conversation_id:message?.conversation_id,duplicate:true};}
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['facebook-ingress/'+accountId]);
    const limit=Number(process.env.KFF_FACEBOOK_EVENTS_PER_MINUTE??1000);
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=10000,'FACEBOOK_CONFIGURATION_INVALID','Facebook 收件限额配置无效',503);
    const recent=(await client.query("SELECT count(*)::int AS n FROM kff.inbound_events WHERE source_kind='facebook' AND split_part(source_key,'/',1)=$1 AND received_at>clock_timestamp()-interval '1 minute'",[accountId])).rows[0].n;
    requireCondition(recent<limit,'RATE_LIMITED','此 Facebook 账号的收件速率已达上限，请稍后重试',429);
    const time=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
    const eventId=randomUUID();
    await client.query("INSERT INTO kff.inbound_events(id,organization_id,brand_id,source_kind,source_key,payload_hash,source_details) VALUES($1,$2,$3,'facebook',$4,$5,$6)",[eventId,scope.organization_id,scope.brand_id,key,hash,value]);
    // Our own signed echo is transport evidence, not a new human message. Never lock the action here:
    // submission/report transactions own action -> conversation, while ingress owns connection -> conversation.
    if(value.kind==='ECHO'){
      const own=(await client.query("SELECT t.conversation_id,a.id FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.account_id=$1 AND t.snapshot->>'body'=$2 AND t.snapshot->'message'->'contact'->>'remote_id'=$3 AND a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME','VERIFIED_SUCCEEDED') AND ((a.id=$4::uuid) OR (a.receipt->>'remote_id'=$5)) LIMIT 1",[accountId,value.body,value.sender_id,value.correlation_id??null,value.event_id])).rows[0];
      if(own){await audit(client,scope,'facebook.own_echo_stored',eventId,{account_id:accountId,action_id:own.id,conversation_id:own.conversation_id});if(beforeCommit)await beforeCommit();return {event_id:eventId,message_id:undefined,conversation_id:own.conversation_id as string,duplicate:false};}
    }
    let identity=(await client.query('SELECT * FROM kff.customer_identities WHERE account_id=$1 AND channel=$2 AND remote_id=$3',[accountId,channel,value.sender_id])).rows[0];
    if(!identity){
      const customer=(await client.query('INSERT INTO kff.customers(organization_id,brand_id,display_name,first_inquiry_event_id,first_interaction_at,last_interaction_at,acquisition_source) VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING id',[scope.organization_id,scope.brand_id,value.display_name,eventId,value.occurred_at,{...value.source,account_id:accountId}])).rows[0];
      const target=(await client.query('INSERT INTO kff.contact_targets(organization_id,brand_id,account_id,channel,remote_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(brand_id,account_id,channel,remote_id) DO UPDATE SET remote_id=EXCLUDED.remote_id RETURNING id',[scope.organization_id,scope.brand_id,accountId,channel,value.sender_id])).rows[0];
      identity=(await client.query('INSERT INTO kff.customer_identities(organization_id,brand_id,customer_id,account_id,channel,remote_id,contact_target_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[scope.organization_id,scope.brand_id,customer.id,accountId,channel,value.sender_id,target.id])).rows[0];
      const automatic=connection.auto_reply&&connection.state==='ACTIVE'&&value.kind==='MESSAGE'&&!value.has_attachment;
      await client.query('INSERT INTO kff.conversations(organization_id,brand_id,customer_id,identity_id,account_id,channel_id,channel_kind,handling_mode) VALUES($1,$2,$3,$4,$5,NULL,$6,$7)',[scope.organization_id,scope.brand_id,customer.id,identity.id,accountId,channel.toUpperCase(),automatic?'AI':'HUMAN']);
    }
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE identity_id=$1 FOR UPDATE',[identity.id])).rows[0];
    await client.query('UPDATE kff.customers SET version=version+1,updated_at=$1,first_interaction_at=LEAST(first_interaction_at,$2::timestamptz),last_interaction_at=GREATEST(last_interaction_at,$2::timestamptz) WHERE id=$3',[time,value.occurred_at,identity.customer_id]);
    let permissionId:string|null=null,windowEnd:string|null=null;
    if(value.kind==='MESSAGE'){
      const target=(await client.query('SELECT * FROM kff.contact_targets WHERE id=$1 FOR UPDATE',[identity.contact_target_id])).rows[0];
      windowEnd=new Date(Date.parse(value.occurred_at)+connection.reply_window_hours*3600000).toISOString();
      const policy=contactPolicy.parse({basis_type:'inbound_inquiry',purpose:'customer_service',source_type:'platform_event',source_ref:eventId,source_observed_at:value.occurred_at,source_use_status:'CONFIRMED',starts_at:value.occurred_at,expires_at:windowEnd,policy_ref:connection.policy_ref,window_rule:'EXPLICIT_END',window_expires_at:windowEnd,evidence_note:'Facebook 主页收到客户主动私信，仅建立配置窗口内的客户服务依据；评论及互动不授予私信资格。'});
      permissionId=(await client.query('INSERT INTO kff.contact_permissions(organization_id,brand_id,target_id,target_version,purpose,policy,policy_hash,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[scope.organization_id,scope.brand_id,target.id,target.version,'customer_service',policy,digest(policy),randomUUID(),hash])).rows[0].id;
    }
    const forcedHuman=value.kind==='ECHO'||value.has_attachment;
    const updated=(await client.query("UPDATE kff.conversations SET last_sequence=last_sequence+1,last_message_at=$1,reply_window_expires_at=GREATEST(reply_window_expires_at,$2::timestamptz),last_inbound_sequence=CASE WHEN $3 THEN last_inbound_sequence ELSE last_sequence+1 END,handling_mode=CASE WHEN $4 THEN 'HUMAN' ELSE handling_mode END,control_version=control_version+CASE WHEN $4 THEN 1 ELSE 0 END WHERE id=$5 RETURNING *",[time,windowEnd,value.kind==='ECHO',forcedHuman,conversation.id])).rows[0];
    // An explicit contact exit applies at ingestion, without waiting for an AI provider or Worker.
    if(value.kind==='MESSAGE'&&explicitContactExit(value.body)){
      await client.query("UPDATE kff.customers SET lead_status='BLOCKED',stage='OPTED_OUT',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[identity.customer_id]);
      await client.query('UPDATE kff.contact_targets SET opted_out=true,opted_out_at=clock_timestamp(),version=version+1 WHERE id=$1 AND NOT opted_out',[identity.contact_target_id]);
      await client.query("UPDATE kff.conversations SET handling_mode='PAUSED',control_version=control_version+1 WHERE id=$1",[conversation.id]);
      await audit(client,scope,'contact.opted_out',identity.contact_target_id,{customer_id:identity.customer_id,account_id:accountId,reason:'客户在 Facebook 私信中明确要求停止联系',source_event_id:eventId});
    }
    if(forcedHuman)await audit(client,scope,'conversation.native_takeover',conversation.id,{account_id:accountId,reason:value.kind==='ECHO'?'Facebook 原生人工回复':'附件需要人工查看',previous_mode:conversation.handling_mode});
    if(value.kind==='ECHO')await client.query("UPDATE kff.conversations v SET last_answered_sequence=GREATEST(v.last_answered_sequence,v.last_inbound_sequence) WHERE v.id=$1 AND EXISTS(SELECT 1 FROM kff.messages m WHERE m.conversation_id=v.id AND m.sequence=v.last_inbound_sequence AND m.client_sent_at<=$2::timestamptz)",[conversation.id,value.occurred_at]);
    const message=(await client.query('INSERT INTO kff.messages(organization_id,brand_id,conversation_id,inbound_event_id,sequence,direction,body,received_at,client_sent_at,contact_permission_id,client_display_name,message_kind,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',[scope.organization_id,scope.brand_id,conversation.id,eventId,updated.last_sequence,value.kind==='ECHO'?'EXTERNAL_OUTBOUND':'INBOUND',value.body,time,value.occurred_at,permissionId,value.display_name,value.kind,value.source])).rows[0];
    await client.query("INSERT INTO kff.customer_events(organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'INQUIRY',$4,$5,$6,$7)",[scope.organization_id,scope.brand_id,identity.customer_id,scope.user_id,{actor_kind:'facebook',account_id:accountId,event_id:eventId,message_id:message.id,conversation_id:conversation.id,kind:value.kind,source:value.source},randomUUID(),hash]);
    await audit(client,scope,'facebook.event_stored',eventId,{account_id:accountId,customer_id:identity.customer_id,conversation_id:conversation.id,message_id:message.id,kind:value.kind,is_synthetic:connection.is_synthetic});
    if(value.kind==='MESSAGE'&&!value.has_attachment)await queueReceptionForConversation(client,conversation.id);
    if(beforeCommit)await beforeCommit();
    return {event_id:eventId,message_id:message.id as string,conversation_id:conversation.id as string,customer_id:identity.customer_id as string,duplicate:false};
  });
}
export async function injectFacebookFixture(scope:Scope,accountId:string,input:FacebookEvent){
  requireWrite(scope);
  const allowed=await scoped(scope,async client=>(await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 AND is_synthetic',[accountId])).rowCount);
  requireCondition(allowed,'FORBIDDEN_SCOPE','只允许向本品牌合成账号注入测试事件',403);return receiveFacebookEvent(scope,accountId,input);
}
export async function receiveFacebookWebhook(bytes:Buffer,signature:string|null){
  requireCondition(bytes.length<=524288,'INVALID_INPUT','Facebook 回调超过限制',413);
  verifyFacebookSignature(bytes,signature,process.env.KFF_FACEBOOK_APP_SECRET);
  let raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));}catch{requireCondition(false,'INVALID_INPUT','回调 JSON 无效');}
  const normalized=normalizeFacebookEvents(raw);let stored=0,duplicates=0,unknownPages=0;
  for(const event of normalized.events){
    // A signed Page ID resolves one server-owned scope; request fields can never select brand or actor.
    const connection=(await query<{account_id:string;organization_id:string;brand_id:string;created_by:string}>('SELECT account_id,organization_id,brand_id,created_by FROM kff.facebook_connections WHERE page_id=$1 AND NOT is_synthetic',[event.page_id]))[0];
    if(!connection){unknownPages++;continue;}
    const result=await receiveFacebookEvent({...connection,user_id:connection.created_by,role:'operator'},connection.account_id,event);
    if(result.duplicate)duplicates++;else stored++;
  }
  return {accepted:true,stored,duplicates,ignored:{...normalized.ignored,UNKNOWN_PAGE:unknownPages},real_platform_status:'BLOCKED_REAL_PLATFORM' as const};
}
