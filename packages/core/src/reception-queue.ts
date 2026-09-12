import type {PoolClient} from 'pg';
import {query,transaction} from '@kff/database';
import {receptionPolicy,type ReceptionPolicy} from '../../contracts/src/lead';
import {digest,requireCondition} from './index';

export interface ReceptionPayload {conversation_id:string;message_id:string;trigger_sequence:number;control_version:number;connection_version:number;account_id:string;agent_id:string;actor_id:string;organization_id:string;brand_id:string;policy:ReceptionPolicy;stop_epochs:{organization:number;brand:number;account:number;agent:number}}
export async function queueReceptionForConversation(client:PoolClient,id:string){
  const row=(await client.query("SELECT v.*,f.version AS connection_version,f.reception_policy,f.created_by AS actor_id,e.agent_id,o.stop_epoch AS organization_epoch,b.stop_epoch AS brand_epoch,a.stop_epoch AS account_epoch,g.stop_epoch AS agent_epoch,m.id AS message_id FROM kff.conversations v JOIN kff.facebook_connections f ON f.account_id=v.account_id JOIN kff.accounts a ON a.id=v.account_id JOIN kff.brands b ON b.id=v.brand_id JOIN kff.organizations o ON o.id=v.organization_id JOIN kff.environments e ON e.id=f.environment_id JOIN kff.agents g ON g.id=e.agent_id JOIN kff.messages m ON m.conversation_id=v.id AND m.sequence=v.last_inbound_sequence JOIN kff.customers c ON c.id=v.customer_id WHERE v.id=$1 AND v.handling_mode='AI' AND v.channel_kind='FACEBOOK_MESSENGER' AND f.state='ACTIVE' AND f.auto_reply AND a.state='ACTIVE' AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused AND g.status NOT IN ('DRAINING','REVOKED','QUARANTINED') AND v.last_inbound_sequence>v.last_answered_sequence AND m.direction='INBOUND' AND m.message_kind='MESSAGE' AND c.lead_status NOT IN ('IGNORED','BLOCKED','HANDOFF_COMPLETE') AND c.stage<>'OPTED_OUT'",[id])).rows[0];
  if(!row)return null;
  const payload:ReceptionPayload={conversation_id:id,message_id:row.message_id,trigger_sequence:row.last_inbound_sequence,control_version:row.control_version,connection_version:row.connection_version,account_id:row.account_id,agent_id:row.agent_id,actor_id:row.actor_id,organization_id:row.organization_id,brand_id:row.brand_id,policy:receptionPolicy.parse(row.reception_policy),stop_epochs:{organization:row.organization_epoch,brand:row.brand_epoch,account:row.account_epoch,agent:row.agent_epoch}};
  const result=(await client.query("INSERT INTO kff.jobs(organization_id,brand_id,kind,conversation_id,message_id,job_key,payload) VALUES($1,$2,'RECEPTION',$3,$4,$5,$6) ON CONFLICT(brand_id,job_key) DO NOTHING RETURNING id",[row.organization_id,row.brand_id,id,row.message_id,'reception_'+digest(payload),payload])).rows[0];return result?.id as string|undefined;
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
    WHERE v.handling_mode='AI' AND v.channel_kind='FACEBOOK_MESSENGER' AND f.auto_reply AND f.state='ACTIVE'
      AND v.last_inbound_sequence>v.last_answered_sequence AND m.direction='INBOUND' AND m.message_kind='MESSAGE'
      AND a.state='ACTIVE' AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused
      AND g.status NOT IN ('DRAINING','REVOKED','QUARANTINED') AND c.lead_status NOT IN ('IGNORED','BLOCKED','HANDOFF_COMPLETE') AND c.stage<>'OPTED_OUT'
      AND NOT EXISTS(SELECT 1 FROM kff.jobs j WHERE j.kind='RECEPTION' AND j.conversation_id=v.id
        AND j.payload->>'control_version'=v.control_version::text AND j.payload->>'trigger_sequence'=v.last_inbound_sequence::text
        AND j.payload->>'connection_version'=f.version::text AND j.payload->>'agent_id'=e.agent_id::text
        AND j.payload->'stop_epochs'=jsonb_build_object('organization',o.stop_epoch,'brand',b.stop_epoch,'account',a.stop_epoch,'agent',g.stop_epoch))
    ORDER BY v.last_message_at,v.id LIMIT $1`,[batchSize]);
  let inserted=0;for(const row of rows){if(await transaction(client=>queueReceptionForConversation(client,row.id)))inserted++;}return inserted;
}
