import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {PoolClient} from 'pg';
import {scoped,transaction} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {schedulePreviewInput,scheduleSaveInput,scheduleRevisionInput,scheduleControlInput} from '../../contracts/src/schedule';
import {compileSchedule,evaluateSchedule,timezoneDataVersion,type ScheduleDefinition} from './schedule-rules';
import {digest,requireCondition} from './index';
import {audit,requireWrite} from './service';

export interface ScheduleRecord {id:string;title:string;state:'ACTIVE'|'PAUSED'|'STOPPED'|'COMPLETED';version:number;current_version_id:string;next_slot_index:number;next_due_at:string|null;last_release_at:string|null;pause_reason:string|null;created_at:string}
export interface ScheduleVersion {id:string;schedule_id:string;version_number:number;definition:ScheduleDefinition;definition_hash:string;title:string;created_at:string}
export interface SchedulePreview {id:string;definition:ScheduleDefinition;definition_hash:string;evaluated_at:string;expires_at:string;simulation:ReturnType<typeof evaluateSchedule>}
async function readSchedule(client:PoolClient,id:string,lock=false){const row=(await client.query<ScheduleRecord>('SELECT * FROM kff.schedules WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];requireCondition(row,'NOT_FOUND','计划不存在',404);return row;}
export async function previewSchedule(scope:Scope,input:z.infer<typeof schedulePreviewInput>):Promise<SchedulePreview>{
  requireWrite(scope);const value=schedulePreviewInput.parse(input);const hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['schedule-preview/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query<SchedulePreview&{request_hash:string;expired:boolean}>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.schedule_previews WHERE request_id=$1',[value.request_id])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','预览请求已经对应不同规则',409);requireCondition(!old.expired,'PREVIEW_EXPIRED','计划预览已到期',410);return {...old,simulation:evaluateSchedule(old.definition,0,new Date(old.evaluated_at).toISOString())};}
    const definition=compileSchedule(value.rule);requireCondition(definition.slots.length>0,'INVALID_INPUT','此日期范围没有符合规则的时点');
    const evaluated=value.evaluate_at??(await client.query('SELECT clock_timestamp() AS instant')).rows[0].instant.toISOString();
    const preview=(await client.query<SchedulePreview>('INSERT INTO kff.schedule_previews(organization_id,brand_id,request_id,request_hash,definition,definition_hash,evaluated_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,definition,definition_hash,evaluated_at,expires_at',[scope.organization_id,scope.brand_id,value.request_id,hash,definition,digest(definition),evaluated,scope.user_id])).rows[0];
    return {...preview,simulation:evaluateSchedule(definition,0,evaluated)};
  });
}
type SaveInput=z.infer<typeof scheduleSaveInput>|z.infer<typeof scheduleRevisionInput>;
export async function saveSchedule(scope:Scope,input:SaveInput,scheduleId?:string):Promise<ScheduleRecord>{
  requireWrite(scope);const value=scheduleId?scheduleRevisionInput.parse(input):scheduleSaveInput.parse(input);const hash=digest({...value,schedule_id:scheduleId??null});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['schedule-request/'+scope.brand_id+'/'+value.request_id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['schedule-version-preview/'+scope.brand_id+'/'+value.preview_id]);
    const old=(await client.query<ScheduleVersion&{request_id:string;request_hash:string;preview_id:string}>('SELECT * FROM kff.schedule_versions WHERE request_id=$1 OR preview_id=$2 ORDER BY (request_id=$1) DESC LIMIT 1',[value.request_id,value.preview_id])).rows[0];
    if(old){requireCondition(old.preview_id===value.preview_id&&old.definition_hash===value.preview_hash&&old.title===value.title&&(!scheduleId||old.schedule_id===scheduleId)&&(old.request_id!==value.request_id||old.request_hash===hash),'IDEMPOTENCY_CONFLICT','此请求或预览已对应不同计划版本',409);return readSchedule(client,old.schedule_id);}
    const preview=(await client.query<SchedulePreview&{expired:boolean}>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.schedule_previews WHERE id=$1',[value.preview_id])).rows[0];
    requireCondition(preview,'NOT_FOUND','计划预览不存在',404);requireCondition(!preview.expired,'PREVIEW_EXPIRED','计划预览已到期',410);requireCondition(preview.definition_hash===value.preview_hash&&digest(preview.definition)===value.preview_hash,'PREVIEW_MISMATCH','计划预览摘要不一致',409);
    requireCondition(preview.definition.timezone_data===timezoneDataVersion(),'TIMEZONE_DATA_CHANGED','时区数据已改变，请重新预览',409);
    let schedule:ScheduleRecord;let versionNumber=1;
    if(scheduleId){schedule=await readSchedule(client,scheduleId,true);requireCondition('expected_version' in value&&schedule.version===value.expected_version,'VERSION_CONFLICT','计划状态已改变',409);requireCondition(schedule.state==='PAUSED','SCHEDULE_NOT_PAUSED','调整规则前需暂停计划',409);
      versionNumber=(await client.query('SELECT max(version_number)+1 AS number FROM kff.schedule_versions WHERE schedule_id=$1',[scheduleId])).rows[0].number;
      await client.query("UPDATE kff.schedule_occurrences SET state='CANCELED',cancellation_reason='RULE_VERSION_SUPERSEDED' WHERE schedule_id=$1 AND state='READY_FOR_TASK'",[scheduleId]);
    }else schedule=(await client.query<ScheduleRecord>('INSERT INTO kff.schedules(organization_id,brand_id,title,created_by) VALUES($1,$2,$3,$4) RETURNING *',[scope.organization_id,scope.brand_id,value.title,scope.user_id])).rows[0];
    const versionId=randomUUID();await client.query('INSERT INTO kff.schedule_versions(id,organization_id,brand_id,schedule_id,preview_id,request_id,request_hash,title,version_number,definition,definition_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[versionId,scope.organization_id,scope.brand_id,schedule.id,value.preview_id,value.request_id,hash,value.title,versionNumber,preview.definition,preview.definition_hash,scope.user_id]);
    const result=(await client.query<ScheduleRecord>("UPDATE kff.schedules SET title=$2,current_version_id=$3,state='PAUSED',version=version+$4,next_slot_index=0,next_due_at=$5,last_release_at=NULL,pause_reason=NULL WHERE id=$1 RETURNING *",[schedule.id,value.title,versionId,scheduleId?1:0,preview.definition.slots[0]?.sort_at??null])).rows[0];
    await audit(client,scope,scheduleId?'schedule.revised':'schedule.created',schedule.id,{version_id:versionId,version_number:versionNumber,definition_hash:preview.definition_hash,reason:'reason' in value?value.reason:null});return result;
  });
}
export async function scheduleList(scope:Scope){return scoped(scope,async client=>(await client.query<ScheduleRecord&{timezone:string;version_number:number}>("SELECT s.*,v.definition->'rule'->>'timezone' AS timezone,v.version_number FROM kff.schedules s JOIN kff.schedule_versions v ON v.id=s.current_version_id ORDER BY s.created_at DESC,s.id LIMIT 100")).rows);}
export async function scheduleDetail(scope:Scope,id:string){return scoped(scope,async client=>{
  const schedule=await readSchedule(client,id);const versions=(await client.query<ScheduleVersion>('SELECT id,schedule_id,version_number,title,definition,definition_hash,created_at FROM kff.schedule_versions WHERE schedule_id=$1 ORDER BY version_number DESC',[id])).rows;
  const occurrences=(await client.query("SELECT id,version_id,slot_index,slot_key,slot,scheduled_at,available_at,state,reason,cancellation_reason,created_at FROM kff.schedule_occurrences WHERE schedule_id=$1 ORDER BY created_at DESC,slot_index DESC LIMIT 1000",[id])).rows;
  const counts=(await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='READY_FOR_TASK')::int AS ready,count(*) FILTER(WHERE state='SKIPPED')::int AS skipped,count(*) FILTER(WHERE state='CANCELED')::int AS canceled FROM kff.schedule_occurrences WHERE schedule_id=$1",[id])).rows[0];
  return {schedule,versions,occurrences,counts,execution_authorized:false};
});}
export async function controlSchedule(scope:Scope,id:string,input:z.infer<typeof scheduleControlInput>){
  requireWrite(scope);const value=scheduleControlInput.parse(input);
  return scoped(scope,async client=>{
    const schedule=await readSchedule(client,id,true);const old=(await client.query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='schedule.controlled' AND details->>'request_id'=$2",[id,value.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===digest(value),'IDEMPOTENCY_CONFLICT','控制请求已对应不同操作',409);return old.details.result;}
    requireCondition(schedule.version===value.expected_version,'VERSION_CONFLICT','计划状态已改变，请刷新',409);
    const allowed=value.action==='STOP'?schedule.state!=='STOPPED':value.action==='PAUSE'?schedule.state==='ACTIVE':schedule.state==='PAUSED';requireCondition(allowed,'INVALID_TRANSITION','当前计划不能执行此控制',409);
    if(value.action==='RESUME'){const definition=(await client.query('SELECT definition FROM kff.schedule_versions WHERE id=$1',[schedule.current_version_id])).rows[0].definition as ScheduleDefinition;requireCondition(definition.timezone_data===timezoneDataVersion(),'TIMEZONE_DATA_CHANGED','时区数据已改变，请重新预览并保存版本',409);requireCondition(schedule.next_slot_index<definition.slots.length,'SCHEDULE_EXHAUSTED','此版本的时点已经处理完毕',409);}
    let canceled=0;if(value.action==='STOP')canceled=(await client.query("UPDATE kff.schedule_occurrences SET state='CANCELED',cancellation_reason='SCHEDULE_STOPPED' WHERE schedule_id=$1 AND state='READY_FOR_TASK'",[id])).rowCount??0;
    const state=value.action==='STOP'?'STOPPED':value.action==='PAUSE'?'PAUSED':'ACTIVE';
    const result=(await client.query<ScheduleRecord>('UPDATE kff.schedules SET state=$2,version=version+1,pause_reason=NULL WHERE id=$1 RETURNING *',[id,state])).rows[0];
    await audit(client,scope,'schedule.controlled',id,{request_id:value.request_id,request_hash:digest(value),action:value.action,reason:value.reason,canceled_occurrences:canceled,result});return result;
  });
}
export async function prepareScheduleOne(options:{beforeCommit?:()=>Promise<void>}={}){
  return transaction(async client=>{
    const schedule=(await client.query<ScheduleRecord&{organization_id:string;brand_id:string;created_by:string}>("SELECT * FROM kff.schedules WHERE state='ACTIVE' AND next_due_at<=clock_timestamp() ORDER BY next_due_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!schedule)return null;
    const version=(await client.query<ScheduleVersion>('SELECT * FROM kff.schedule_versions WHERE id=$1',[schedule.current_version_id])).rows[0];
    const scope:Scope={organization_id:schedule.organization_id,brand_id:schedule.brand_id,user_id:schedule.created_by,role:'admin'};
    if(version.definition.timezone_data!==timezoneDataVersion()||digest(version.definition)!==version.definition_hash){await client.query("UPDATE kff.schedules SET state='PAUSED',version=version+1,pause_reason='RULES_CHANGED' WHERE id=$1",[schedule.id]);await audit(client,scope,'schedule.rules_blocked',schedule.id,{version_id:version.id});return {id:schedule.id,blocked:true};}
    const at=(await client.query('SELECT clock_timestamp() AS instant')).rows[0].instant.toISOString();const result=evaluateSchedule(version.definition,schedule.next_slot_index,at,schedule.last_release_at?new Date(schedule.last_release_at).toISOString():null);
    for(const decision of result.decisions)await client.query('INSERT INTO kff.schedule_occurrences(organization_id,brand_id,schedule_id,version_id,slot_index,slot_key,slot,scheduled_at,available_at,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[schedule.organization_id,schedule.brand_id,schedule.id,version.id,decision.slot.index,decision.slot.key,decision.slot,decision.slot.scheduled_at,decision.available_at,decision.state,decision.reason]);
    await client.query("UPDATE kff.schedules SET next_slot_index=$2,next_due_at=$3,last_release_at=$4,state=CASE WHEN $3::timestamptz IS NULL THEN 'COMPLETED' ELSE 'ACTIVE' END,version=version+1 WHERE id=$1",[schedule.id,result.next_index,result.next_due_at,result.last_release_at]);
    await audit(client,scope,'schedule.points_prepared',schedule.id,{version_id:version.id,from_index:schedule.next_slot_index,to_index:result.next_index,ready_count:result.decisions.filter(row=>row.state==='READY_FOR_TASK').length,skipped_count:result.decisions.filter(row=>row.state==='SKIPPED').length,evaluated_at:at,execution_authorized:false});
    await options.beforeCommit?.();return {id:schedule.id,blocked:false,prepared:result.decisions.length};
  });
}
