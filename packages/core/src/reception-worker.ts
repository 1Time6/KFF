import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {scoped,transaction} from '@kff/database';
import {receptionDecision,receptionPolicyInput,type ReceptionDecision} from '../../contracts/src/lead';
import type {Scope} from '@kff/contracts';
import {configuredReceptionModel,enforceReceptionDecision,type ReceptionModel,type ReceptionContext} from '../../adapters/src/reception-model';
import {queueReceptionForConversation,type ReceptionPayload} from './reception-queue';
import {readStopEpochs,queueConversationReply,effectiveDestination} from './lead-reception';
import {digest,requireCondition,AppError} from './index';
import {audit,requireAdmin} from './service';

export interface ReceptionClaim {id:string;lease_token:string;attempts:number;payload:ReceptionPayload}
export async function configureReceptionPolicy(scope:Scope,input:z.infer<typeof receptionPolicyInput>){
  requireAdmin(scope);const value=receptionPolicyInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    const row=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1 FOR UPDATE',[value.account_id])).rows[0];requireCondition(row,'NOT_FOUND','Facebook 接待配置不存在',404);
    const previous=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='reception.policy_configured' AND details->>'request_id'=$1",[value.request_id])).rows[0];if(previous){requireCondition(previous.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','规则请求已有不同内容',409);return previous.details.result;}
    requireCondition(row.version===value.expected_version,'VERSION_CONFLICT','接待规则已变化，请刷新',409);
    const result=(await client.query('UPDATE kff.facebook_connections SET reception_policy=$1,version=version+1 WHERE account_id=$2 RETURNING account_id,version,reception_policy',[value.policy,value.account_id])).rows[0];
    await audit(client,scope,'reception.policy_configured',value.account_id,{request_id:value.request_id,request_hash:hash,result});return result;
  });
}
export async function claimReception():Promise<ReceptionClaim|null>{return transaction(async client=>{
  const job=(await client.query("SELECT j.* FROM kff.jobs j JOIN kff.conversations v ON v.id=j.conversation_id JOIN kff.accounts a ON a.id=v.account_id JOIN kff.facebook_connections f ON f.account_id=a.id JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE j.kind='RECEPTION' AND ((j.state='READY') OR (j.state='LEASED' AND j.lease_expires_at<=clock_timestamp())) AND j.available_at<=clock_timestamp() AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused AND f.state='ACTIVE' ORDER BY j.available_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED")).rows[0];
  if(!job)return null;
  const updated=(await client.query("UPDATE kff.jobs SET state='LEASED',attempts=attempts+1,lease_token=lease_token+1,leased_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 RETURNING id,lease_token,attempts,payload",[job.id])).rows[0];return updated as ReceptionClaim;
});}
export async function receptionContext(claim:ReceptionClaim):Promise<ReceptionContext>{
  const p=claim.payload,scope:Scope={organization_id:p.organization_id,brand_id:p.brand_id,user_id:p.actor_id,role:'operator'};
  return scoped(scope,async client=>{
    const messages=(await client.query<{direction:string;body:string}>("SELECT direction,body FROM kff.messages WHERE conversation_id=$1 AND sequence<=$2 AND (message_kind='MESSAGE' OR direction='EXTERNAL_OUTBOUND') ORDER BY sequence DESC LIMIT 12",[p.conversation_id,p.trigger_sequence])).rows.reverse();
    const counts=(await client.query("SELECT (SELECT count(*)::int FROM kff.messages WHERE conversation_id=$1 AND direction='OUTBOUND' AND actor_kind='AI') AS replies,EXISTS(SELECT 1 FROM kff.whatsapp_referrals WHERE conversation_id=$1 AND sent_at IS NOT NULL) AS referred",[p.conversation_id])).rows[0];
    const destination=await effectiveDestination(client,p.account_id);
    return {history:messages.map(row=>({role:row.direction==='INBOUND'?'user' as const:'assistant' as const,content:row.body})),policy:p.policy,reply_count:counts.replies,referred:counts.referred,has_whatsapp:destination?.state==='ACTIVE'};
  });
}
async function lockCurrentReception(client:import('pg').PoolClient,claim:ReceptionClaim){
  const p=claim.payload;
  // All reception mutations lock connection -> conversation -> job; do not reverse this order at takeover.
  const connection=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[p.account_id])).rows[0];
  const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[p.conversation_id])).rows[0];
  const job=(await client.query('SELECT * FROM kff.jobs WHERE id=$1 FOR UPDATE',[claim.id])).rows[0];
  requireCondition(job?.state==='LEASED'&&job.lease_token===claim.lease_token&&job.lease_expires_at>(await client.query('SELECT clock_timestamp() AS now')).rows[0].now&&digest(job.payload)===digest(p),'RECEPTION_LEASE_STALE','接待准备任务已过期',409);
  const pause=(await client.query('SELECT a.outbound_paused OR b.outbound_paused OR o.outbound_paused AS paused FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE a.id=$1',[p.account_id])).rows[0];
  const current=conversation&&connection&&conversation.control_version===p.control_version&&conversation.last_inbound_sequence===p.trigger_sequence&&conversation.handling_mode==='AI'&&conversation.last_answered_sequence<p.trigger_sequence&&connection.version===p.connection_version&&connection.auto_reply&&connection.state==='ACTIVE'&&!pause?.paused&&digest(await readStopEpochs(client,p.account_id,p.agent_id))===digest(p.stop_epochs);
  return {job,conversation,current};
}
export async function completeReception(claim:ReceptionClaim,input:ReceptionDecision,modelName:string,beforeCommit?:()=>Promise<void>){
  const decision=receptionDecision.parse(input),p=claim.payload,scope:Scope={organization_id:p.organization_id,brand_id:p.brand_id,user_id:p.actor_id,role:'operator'};
  return scoped(scope,async client=>{
    const locked=await lockCurrentReception(client,claim);
    if(!locked.current){await client.query("UPDATE kff.jobs SET state='DONE',result=$1,lease_expires_at=NULL WHERE id=$2",[{status:'STALE',reason:'控制权、来源消息、配置或停止版本已变化'},claim.id]);return {status:'STALE'};}
    const customer=(await client.query('SELECT * FROM kff.customers WHERE id=$1 FOR UPDATE',[locked.conversation.customer_id])).rows[0];
    if(['BLOCKED','IGNORED','HANDOFF_COMPLETE'].includes(customer.lead_status)||customer.stage==='OPTED_OUT'){await client.query("UPDATE kff.jobs SET state='DONE',result=$1,lease_expires_at=NULL WHERE id=$2",[{status:'STOPPED'},claim.id]);return {status:'STOPPED'};}
    const valid=customer.valid_inquiry||decision.valid_inquiry,tags=[...new Set([...customer.tags,...decision.tags])].slice(0,20);
    const leadStatus=decision.action==='STOP'?(decision.intent==='UNSUBSCRIBE'?'BLOCKED':'IGNORED'):['WHATSAPP_REFERRED','HANDOFF_COMPLETE'].includes(customer.lead_status)?customer.lead_status:valid?'QUALIFIED':'ENGAGED';
    await client.query("UPDATE kff.customers SET valid_inquiry=$1,tags=$2,intent_level=$3,intent_category=$4,intent_reason=$5,lead_status=$6,stage=CASE WHEN $7 THEN 'OPTED_OUT' ELSE stage END,version=version+1,updated_at=clock_timestamp() WHERE id=$8",[valid,tags,decision.intent_level,decision.intent,decision.reason,leadStatus,decision.action==='STOP'&&decision.intent==='UNSUBSCRIBE',customer.id]);
    let queued:Awaited<ReturnType<typeof queueConversationReply>>|null=null;
    if(decision.action==='HANDOFF'||decision.action==='STOP'){
      await client.query('UPDATE kff.conversations SET handling_mode=$1,control_version=control_version+1 WHERE id=$2',[decision.action==='HANDOFF'?'HUMAN':'PAUSED',p.conversation_id]);
      if(decision.action==='STOP'&&decision.intent==='UNSUBSCRIBE')await client.query('UPDATE kff.contact_targets SET opted_out=true,opted_out_at=clock_timestamp(),version=version+1 WHERE id IN (SELECT contact_target_id FROM kff.customer_identities WHERE customer_id=$1) AND NOT opted_out',[customer.id]);
    }else queued=await queueConversationReply(client,scope,p.conversation_id,{request_id:claim.id,request_hash:digest({job_id:claim.id,decision}),body:decision.reply,refer_whatsapp:decision.action==='REFER_WHATSAPP',actor_kind:'AI'});
    const result={status:'DECIDED',model:modelName,decision,queued};
    await client.query("INSERT INTO kff.customer_events(organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'AI_DECISION',$4,$5,$6,$7)",[p.organization_id,p.brand_id,customer.id,p.actor_id,{job_id:claim.id,account_id:p.account_id,message_id:p.message_id,conversation_id:p.conversation_id,...result},randomUUID(),digest(result)]);
    await client.query("UPDATE kff.jobs SET state='DONE',result=$1,error_code=NULL,lease_expires_at=NULL WHERE id=$2",[result,claim.id]);
    await audit(client,scope,'reception.decided',p.conversation_id,{job_id:claim.id,model:modelName,action:decision.action,intent:decision.intent,confidence:decision.confidence,account_id:p.account_id});
    if(beforeCommit)await beforeCommit();return result;
  });
}
export async function failReception(claim:ReceptionClaim,code:string){const p=claim.payload;return scoped({organization_id:p.organization_id,brand_id:p.brand_id,user_id:p.actor_id,role:'operator'},async client=>{
  const {current,conversation}=await lockCurrentReception(client,claim),p=claim.payload;
  if(!current){await client.query("UPDATE kff.jobs SET state='DONE',result=$1,error_code=$2,lease_expires_at=NULL WHERE id=$3",[{status:'STALE'},code,claim.id]);return;}
  if(['RATE_LIMITED','MESSAGE_IN_FLIGHT'].includes(code)){await client.query("UPDATE kff.jobs SET state='READY',attempts=GREATEST(0,attempts-1),error_code=$1,available_at=clock_timestamp()+interval '30 seconds',lease_expires_at=NULL,result=$2 WHERE id=$3",[code,{status:'WAIT'},claim.id]);return;}
  const final=claim.attempts>=3;
  await client.query("UPDATE kff.jobs SET state=$1,error_code=$2,available_at=clock_timestamp()+make_interval(secs=>$3),lease_expires_at=NULL,result=$4 WHERE id=$5",[final?'DEAD':'READY',code,Math.min(60,2**claim.attempts),{status:final?'HANDOFF':'RETRY',attempt:claim.attempts},claim.id]);
  if(final){await client.query("UPDATE kff.conversations SET handling_mode='HUMAN',control_version=control_version+1 WHERE id=$1",[conversation.id]);await audit(client,{organization_id:p.organization_id,brand_id:p.brand_id,user_id:p.actor_id,role:'operator'},'reception.failed_handoff',conversation.id,{job_id:claim.id,reason:code,attempts:claim.attempts});}
});}
export async function processReceptionOne(model?:ReceptionModel){
  const claim=await claimReception();if(!claim)return false;
  try{const context=await receptionContext(claim),provider=model??configuredReceptionModel(claim.payload.policy.provider);const decision=enforceReceptionDecision(await provider.decide(context),context);await completeReception(claim,decision,provider.name);}
  catch(error){try{await failReception(claim,error instanceof AppError?error.code:'AI_PROVIDER_ERROR');}catch(failure){if(!(failure instanceof AppError&&failure.code==='RECEPTION_LEASE_STALE'))throw failure;}}
  return true;
}
export async function retryReception(scope:Scope,conversationId:string,requestId:string,expectedVersion:number){
  requireCondition(scope.role!=='viewer','FORBIDDEN_SCOPE','当前角色不能恢复接待',403);
  return scoped(scope,async client=>{
    const account=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[conversationId])).rows[0];requireCondition(account,'NOT_FOUND','会话不存在',404);
    await client.query('SELECT account_id FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[account.account_id]);
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[conversationId])).rows[0];
    const previous=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='reception.retried' AND details->>'request_id'=$1",[requestId])).rows[0];
    if(previous){requireCondition(previous.details.conversation_id===conversationId&&previous.details.expected_version===expectedVersion,'IDEMPOTENCY_CONFLICT','恢复请求内容已变化',409);return previous.details.result;}
    requireCondition(conversation.control_version===expectedVersion,'VERSION_CONFLICT','会话状态已变化，请刷新',409);
    const unsafe=await client.query("SELECT a.id FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 AND (a.state IN ('SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME') OR EXISTS(SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id AND (c.state IN ('READY','CLAIMED') OR c.quiesced_at IS NULL))) LIMIT 1",[conversationId]);
    requireCondition(!unsafe.rowCount,'GUARDIAN_UNCONFIRMED','仍有在途、未知或未关闭的旧执行，请先核验',409);
    await client.query("UPDATE kff.conversations SET handling_mode='AI',control_version=control_version+1 WHERE id=$1",[conversationId]);
    const job=await queueReceptionForConversation(client,conversationId);requireCondition(job,'RECEPTION_UNAVAILABLE','没有符合规则且尚未回答的私信',409);
    const result={job_id:job,control_version:conversation.control_version+1};await audit(client,scope,'reception.retried',conversationId,{request_id:requestId,conversation_id:conversationId,expected_version:expectedVersion,result});return result;
  });
}
