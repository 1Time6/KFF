import type {PoolClient} from 'pg';
import {scoped} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {receptionDraftInput,receptionDraftReference,receptionPolicy} from '../../contracts/src/lead';
import {configuredReceptionModel} from '../../adapters/src/reception-model';
import {digest,requireCondition} from './index';
import {audit,requireWrite} from './service';
import {readStopEpochs} from './lead-reception';
import type {ReceptionPayload} from './reception-queue';

export function receptionDraftProviderStatus(provider: 'LOCAL_RULES'|'OPENAI_COMPATIBLE'){
  try{configuredReceptionModel(provider);return {provider,configured:true};}
  catch{return {provider,configured:false};}
}

// Reuses the reception queue but never creates an execution task or changes customer state.
export async function requestReceptionDraft(scope:Scope,id:string,input:unknown){
  requireWrite(scope);const value=receptionDraftInput.parse(input),hash=digest({id,...value});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reception-draft/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='reception.draft_requested' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','此草稿请求已有不同内容',409);return old.details.result;}
    const owner=(await client.query('SELECT account_id FROM kff.conversations WHERE id=$1',[id])).rows[0];requireCondition(owner,'NOT_FOUND','会话不存在',404);
    const connection=(await client.query('SELECT * FROM kff.facebook_connections WHERE account_id=$1 FOR SHARE',[owner.account_id])).rows[0];
    const conversation=(await client.query('SELECT * FROM kff.conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    requireCondition(conversation.control_version===value.expected_version,'VERSION_CONFLICT','会话已变化，请刷新',409);
    requireCondition(conversation.handling_mode==='HUMAN'&&connection?.state==='ACTIVE'&&conversation.last_inbound_sequence>conversation.last_answered_sequence&&conversation.channel_kind===(connection.transport==='BROWSER'?'FACEBOOK_BROWSER_MESSENGER':'FACEBOOK_MESSENGER'),'DRAFT_UNAVAILABLE','请先人工接管，并选择尚未回答的最新来信',409);
    const row=(await client.query("SELECT e.agent_id,a.state,a.outbound_paused OR b.outbound_paused OR o.outbound_paused AS paused,g.status AS agent_status,c.lead_status,c.stage,m.id AS message_id,m.body FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id JOIN kff.environments e ON e.id=$2 AND e.account_id=a.id JOIN kff.agents g ON g.id=e.agent_id JOIN kff.customers c ON c.id=$3 JOIN kff.messages m ON m.conversation_id=$4 AND m.sequence=$5 AND m.direction='INBOUND' AND m.message_kind='MESSAGE' AND m.source->>'has_attachment' IS DISTINCT FROM 'true' WHERE a.id=$1",[owner.account_id,connection.environment_id,conversation.customer_id,id,conversation.last_inbound_sequence])).rows[0];
    requireCondition(row&&row.state==='ACTIVE'&&!row.paused&&!['REVOKED','DRAINING','QUARANTINED'].includes(row.agent_status)&&!['IGNORED','BLOCKED','HANDOFF_COMPLETE'].includes(row.lead_status)&&row.stage!=='OPTED_OUT','DRAFT_UNAVAILABLE','账号、客户或当前来信不支持生成建议',409);
    const policy=receptionPolicy.parse(connection.reception_policy);configuredReceptionModel(policy.provider);
    const payload:ReceptionPayload={draft_only:true,draft_expires_at:new Date(Date.now()+20*60000).toISOString(),trigger_content_hash:digest(row.body),conversation_id:id,message_id:row.message_id,trigger_sequence:conversation.last_inbound_sequence,control_version:conversation.control_version,connection_version:connection.version,account_id:owner.account_id,agent_id:row.agent_id,actor_id:scope.user_id,organization_id:scope.organization_id,brand_id:scope.brand_id,policy,stop_epochs:await readStopEpochs(client,owner.account_id,row.agent_id)};
    const job=(await client.query("INSERT INTO kff.jobs(organization_id,brand_id,kind,conversation_id,message_id,job_key,payload) VALUES($1,$2,'RECEPTION',$3,$4,$5,$6) RETURNING id",[scope.organization_id,scope.brand_id,id,row.message_id,'reception_draft_'+value.request_id,payload])).rows[0];
    const result={job_id:job.id,status:'DRAFT_QUEUED',expires_at:payload.draft_expires_at};
    await audit(client,scope,'reception.draft_requested',id,{request_id:value.request_id,request_hash:hash,result});return result;
  });
}

export async function validateReceptionDraft(client:PoolClient,id:string,conversation:{id:string;account_id:string;control_version:number;last_inbound_sequence:number;last_answered_sequence:number;handling_mode:string}){
  const job=(await client.query("SELECT * FROM kff.jobs WHERE id=$1 AND conversation_id=$2 AND kind='RECEPTION' FOR SHARE",[id,conversation.id])).rows[0];
  requireCondition(job?.state==='DONE'&&job.result?.status==='DRAFT_READY'&&job.payload.draft_only===true,'DRAFT_STALE','此建议不可使用，请重新生成',409);
  const p=job.payload as ReceptionPayload;
  const connection=(await client.query('SELECT version,state FROM kff.facebook_connections WHERE account_id=$1',[conversation.account_id])).rows[0];
  const trigger=(await client.query('SELECT body FROM kff.messages WHERE id=$1 AND conversation_id=$2 AND sequence=$3',[p.message_id,conversation.id,conversation.last_inbound_sequence])).rows[0];
  requireCondition(p.account_id===conversation.account_id&&p.control_version===conversation.control_version&&p.trigger_sequence===conversation.last_inbound_sequence&&conversation.last_answered_sequence<p.trigger_sequence&&conversation.handling_mode==='HUMAN'&&connection?.version===p.connection_version&&connection.state==='ACTIVE'&&trigger&&digest(trigger.body)===p.trigger_content_hash&&digest(await readStopEpochs(client,p.account_id,p.agent_id))===digest(p.stop_epochs)&&Date.parse(p.draft_expires_at??'')>Date.now(),'DRAFT_STALE','来信、接管、配置或有效期已变化，请重新生成建议',409);
  requireCondition(['REPLY','ASK_QUESTION','REFER_WHATSAPP'].includes(job.result.decision?.action),'DRAFT_NOT_REPLY','此建议要求人工处理或停止接待，不能直接采用为回复',409);
  return receptionDraftReference.parse({job_id:id,result_hash:digest(job.result),model:job.result.model,generated_at:job.result.generated_at,expires_at:p.draft_expires_at});
}
