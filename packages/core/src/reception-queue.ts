import type {PoolClient} from 'pg';
import {query,transaction} from '@kff/database';
import {receptionPolicy,type ReceptionPolicy} from '../../contracts/src/lead';
import {digest,requireCondition} from './index';

export interface ReceptionPayload {draft_only?:true;draft_expires_at?:string;trigger_content_hash?:string;conversation_id:string;message_id:string;trigger_sequence:number;control_version:number;connection_version:number;account_id:string;agent_id:string;actor_id:string;organization_id:string;brand_id:string;policy:ReceptionPolicy;stop_epochs:{organization:number;brand:number;account:number;agent:number}}
/**
 * Why a conversation marked for AI handling has no reception job behind it.
 *
 * Selecting AI mode and actually running are different facts. `queueReceptionForConversation`
 * requires an active connection with auto reply, a live account, an available agent and a pending
 * inbound message; when any of those is missing it returns nothing and the mode is still written.
 * Without this the operator sees "AI" and believes reception resumed. Reporting the reason never
 * widens the gate: nothing here turns a switch back on, and the queue keeps its own conditions.
 */
export type ReceptionQueueStatus={reason:ReceptionActivationReason;active:boolean};
/** The joined conversation row the activation gate reads. Every field is aliased in the query. */
interface ReceptionActivationRow {
  handling_mode:string; channel_kind:string; control_version:number; account_id:string; organization_id:string; brand_id:string;
  last_inbound_sequence:number; last_answered_sequence:number; connection_version:number; reception_policy:unknown; actor_id:string;
  connection_state:string; connection_auto_reply:boolean; connection_transport:string;
  account_state:string; account_paused:boolean; brand_paused:boolean; organization_paused:boolean;
  agent_id:string; agent_status:string;
  organization_epoch:number; brand_epoch:number; account_epoch:number; agent_epoch:number;
  message_id?:string; direction?:string; message_kind?:string;  lead_status:string; stage:string;
}
export interface ReceptionStatusInput {
  handling_mode: string; channel_kind: string;
  connection: { transport: string; state: string; auto_reply: boolean } | undefined;
  account: { state: string; outbound_paused: boolean } | undefined;
  brand_paused: boolean; organization_paused: boolean;
  agent_status: string;
  last_inbound_sequence: number; last_answered_sequence: number;
  last_inbound: { direction: string; message_kind: string } | undefined;
  customer: { lead_status: string; stage: string } | undefined;
}
export type ReceptionActivationReason =
  | 'ACTIVE' | 'HANDLING_MODE_NOT_AI' | 'CHANNEL_MISMATCH' | 'CONNECTION_NOT_CONFIGURED'
  | 'CONNECTION_PAUSED' | 'AUTO_REPLY_OFF' | 'ACCOUNT_UNAVAILABLE' | 'OUTBOUND_PAUSED'
  | 'AGENT_UNAVAILABLE' | 'NO_PENDING_INBOUND' | 'CUSTOMER_CLOSED';
export function receptionActivationReason(input: ReceptionStatusInput): { reason: ReceptionActivationReason; active: boolean } {
  const decide = (reason: ReceptionActivationReason): { reason: ReceptionActivationReason; active: boolean } => ({ reason, active: reason === 'ACTIVE' });
  if (input.handling_mode !== 'AI') return decide('HANDLING_MODE_NOT_AI');
  // There is no configured channel to compare against before a connection exists, so that is
  // reported on its own rather than as a mismatch.
  if (!input.connection) return decide('CONNECTION_NOT_CONFIGURED');
  const expected = input.connection.transport === 'BROWSER' ? 'FACEBOOK_BROWSER_MESSENGER' : 'FACEBOOK_MESSENGER';
  if (input.channel_kind !== expected) return decide('CHANNEL_MISMATCH');
  if (input.connection.state !== 'ACTIVE') return decide('CONNECTION_PAUSED');
  if (!input.connection.auto_reply) return decide('AUTO_REPLY_OFF');
  if (!input.account || input.account.state !== 'ACTIVE') return decide('ACCOUNT_UNAVAILABLE');
  if (input.account.outbound_paused || input.brand_paused || input.organization_paused) return decide('OUTBOUND_PAUSED');
  if (['DRAINING', 'REVOKED', 'QUARANTINED'].includes(input.agent_status)) return decide('AGENT_UNAVAILABLE');
  if (!(input.last_inbound_sequence > input.last_answered_sequence)) return decide('NO_PENDING_INBOUND');
  if (!input.last_inbound || input.last_inbound.direction !== 'INBOUND' || input.last_inbound.message_kind !== 'MESSAGE') return decide('NO_PENDING_INBOUND');
  if (!input.customer || ['IGNORED', 'BLOCKED', 'HANDOFF_COMPLETE'].includes(input.customer.lead_status) || input.customer.stage === 'OPTED_OUT') return decide('CUSTOMER_CLOSED');
  return decide('ACTIVE');
}
/** The one description of each reason, so the page, the API and the tests cannot drift apart. */
export const receptionActivationLabels: Record<ReceptionActivationReason, string> = {
  ACTIVE: '已激活：已有待处理的来信，接待任务已入队',
  HANDLING_MODE_NOT_AI: '当前不是 AI 模式',
  CHANNEL_MISMATCH: '会话渠道与已配置的接待连接不一致',
  CONNECTION_NOT_CONFIGURED: '账号还没有配置接待连接',
  CONNECTION_PAUSED: '接待连接已暂停，恢复连接后才会入队',
  AUTO_REPLY_OFF: '账号级自动回复已关闭，AI 模式已选择但不会产生接待任务',
  ACCOUNT_UNAVAILABLE: '账号当前不可用于接待',
  OUTBOUND_PAUSED: '组织、品牌或账号已暂停新动作',
  AGENT_UNAVAILABLE: '执行 Agent 正在停止、撤销或隔离',
  NO_PENDING_INBOUND: '没有待处理的新来信',
  CUSTOMER_CLOSED: '客户已退出、被忽略或已完成交接',
};
/**
 * The conversation's reception state, and why it is not running when it is not.
 *
 * Selecting AI mode and actually running are different facts. `queueReceptionForConversation`
 * requires an active connection with auto reply, a live account, an available agent and a pending
 * inbound message; when any is missing it returns nothing while the mode still reads "AI". This is
 * the one place that gate is described, so a caller can report the real blocker instead of leaving
 * the operator to assume reception resumed. It only reads: nothing here turns a switch back on.
 * Every column is aliased because `state` and `outbound_paused` exist on more than one joined
 * table, so an unqualified read would be ambiguous rather than merely wrong.
 */
export async function inspectReceptionActivation(client:PoolClient,id:string):Promise<{row:ReceptionActivationRow|undefined;status:ReceptionQueueStatus}>{
  const row=(await client.query<ReceptionActivationRow>("SELECT v.handling_mode,v.channel_kind,v.control_version,v.account_id,v.organization_id,v.brand_id,v.last_inbound_sequence,v.last_answered_sequence,f.version AS connection_version,f.state AS connection_state,f.auto_reply AS connection_auto_reply,f.transport AS connection_transport,f.reception_policy,f.created_by AS actor_id,e.agent_id,g.status AS agent_status,g.stop_epoch AS agent_epoch,a.state AS account_state,a.outbound_paused AS account_paused,b.outbound_paused AS brand_paused,o.outbound_paused AS organization_paused,o.stop_epoch AS organization_epoch,b.stop_epoch AS brand_epoch,a.stop_epoch AS account_epoch,m.id AS message_id,m.direction,m.message_kind,c.lead_status,c.stage FROM kff.conversations v JOIN kff.facebook_connections f ON f.account_id=v.account_id JOIN kff.accounts a ON a.id=v.account_id JOIN kff.brands b ON b.id=v.brand_id JOIN kff.organizations o ON o.id=v.organization_id JOIN kff.environments e ON e.id=f.environment_id JOIN kff.agents g ON g.id=e.agent_id LEFT JOIN kff.messages m ON m.conversation_id=v.id AND m.sequence=v.last_inbound_sequence JOIN kff.customers c ON c.id=v.customer_id WHERE v.id=$1",[id])).rows[0];
  if(!row)return {row:undefined,status:{reason:'CONNECTION_NOT_CONFIGURED',active:false}};
  const verdict=receptionActivationReason({
    handling_mode:row.handling_mode,channel_kind:row.channel_kind,
    connection:{transport:row.connection_transport,state:row.connection_state,auto_reply:row.connection_auto_reply},
    account:{state:row.account_state,outbound_paused:row.account_paused},
    brand_paused:Boolean(row.brand_paused),organization_paused:Boolean(row.organization_paused),
    agent_status:row.agent_status,
    last_inbound_sequence:row.last_inbound_sequence,last_answered_sequence:row.last_answered_sequence,
    last_inbound:row.message_id?{direction:row.direction??'',message_kind:row.message_kind??''}:undefined,
    customer:{lead_status:row.lead_status,stage:row.stage},
  });
  return {row,status:{reason:verdict.reason,active:verdict.active&&Boolean(row.message_id)}};
}
/**
 * Queue one conversation for reception. `job_id` is null when this call scheduled nothing, so a
 * caller must decide on `job_id` rather than on the truthiness of the result, and `status` always
 * describes the gate that produced that answer.
 */
export async function queueReceptionForConversation(client:PoolClient,id:string):Promise<{job_id:string|null;status:ReceptionQueueStatus}>{
  const {row,status}=await inspectReceptionActivation(client,id);
  // A null job_id is the signal that nothing was scheduled; the row and the message are both
  // required before a reception job can be built.
  if(!row||!status.active||!row.message_id)return {job_id:null,status};
  const payload:ReceptionPayload={conversation_id:id,message_id:row.message_id,trigger_sequence:row.last_inbound_sequence,control_version:row.control_version,connection_version:row.connection_version,account_id:row.account_id,agent_id:row.agent_id,actor_id:row.actor_id,organization_id:row.organization_id,brand_id:row.brand_id,policy:receptionPolicy.parse(row.reception_policy),stop_epochs:{organization:row.organization_epoch,brand:row.brand_epoch,account:row.account_epoch,agent:row.agent_epoch}};
  // A duplicate job key means this exact message was already scheduled: the conversation is queued
  // for reception, so nothing new is created and no fresh job is reported.
  const result=(await client.query("INSERT INTO kff.jobs(organization_id,brand_id,kind,conversation_id,message_id,job_key,payload) VALUES($1,$2,'RECEPTION',$3,$4,$5,$6) ON CONFLICT(brand_id,job_key) DO NOTHING RETURNING id",[row.organization_id,row.brand_id,id,row.message_id,'reception_'+digest(payload),payload])).rows[0];
  return {job_id:result?.id as string|undefined??null,status};
}
export async function schedulePendingReception(batchSize=100){
  requireCondition(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=100,'INVALID_INPUT','接待扫描批次须为 1–100');
  // Exclude already represented snapshots before LIMIT. Otherwise a full batch of waiting or
  // terminal old jobs could indefinitely hide newer conversations received while an account was paused.
  const rows=await query<{id:string}>(`SELECT v.id FROM kff.conversations v
    JOIN kff.facebook_connections f ON f.account_id=v.account_id JOIN kff.accounts a ON a.id=v.account_id
    JOIN kff.brands b ON b.id=v.brand_id JOIN kff.organizations o ON o.id=v.organization_id
    JOIN kff.environments e ON e.id=f.environment_id JOIN kff.agents g ON g.id=e.agent_id
    JOIN kff.customers c ON c.id=v.customer_id JOIN kff.messages m ON m.conversation_id=v.id AND m.sequence=v.last_inbound_sequence
    WHERE v.handling_mode='AI' AND v.channel_kind=CASE WHEN f.transport='BROWSER' THEN 'FACEBOOK_BROWSER_MESSENGER' ELSE 'FACEBOOK_MESSENGER' END AND f.auto_reply AND f.state='ACTIVE'
      AND v.last_inbound_sequence>v.last_answered_sequence AND m.direction='INBOUND' AND m.message_kind='MESSAGE'
      AND a.state='ACTIVE' AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused
      AND g.status NOT IN ('DRAINING','REVOKED','QUARANTINED') AND c.lead_status NOT IN ('IGNORED','BLOCKED','HANDOFF_COMPLETE') AND c.stage<>'OPTED_OUT'
      AND NOT EXISTS(SELECT 1 FROM kff.jobs j WHERE j.kind='RECEPTION' AND j.conversation_id=v.id
        AND j.payload->>'control_version'=v.control_version::text AND j.payload->>'trigger_sequence'=v.last_inbound_sequence::text
        AND j.payload->>'connection_version'=f.version::text AND j.payload->>'agent_id'=e.agent_id::text
        AND j.payload->'stop_epochs'=jsonb_build_object('organization',o.stop_epoch,'brand',b.stop_epoch,'account',a.stop_epoch,'agent',g.stop_epoch))
    ORDER BY v.last_message_at,v.id LIMIT $1`,[batchSize]);
  let inserted=0;for(const row of rows){const queued=await transaction(client=>queueReceptionForConversation(client,row.id));if(queued.job_id)inserted++;}return inserted;
}
