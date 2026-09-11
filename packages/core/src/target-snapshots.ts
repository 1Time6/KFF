import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {scoped,transaction} from '@kff/database';
import type {Scope,CollectionQuery,CollectionResult} from '@kff/contracts';
import {targetPreviewInput,targetSnapshotInput,targetRevokeInput,type TargetPreviewInput,type FrozenCollectionTarget} from '../../contracts/src/target-selection';
import {digest,requireCondition} from './index';
import {audit,requireWrite} from './service';
import {filteredCollectionRows,collectionResultPage} from './collection-filter';

export interface TargetDefinition {
  schema_version:'kff.target-set.v1';query_id:string;account_id:string;query_snapshot_hash:string;input:TargetPreviewInput;
  included_count:number;excluded_count:number;filtered_count:number;targets:FrozenCollectionTarget[];source_expires_at:string;execution_authorized:false;
  source_returned_count:number;source_unique_count:number;
}
export interface TargetPreview {id:string;query_id:string;definition:TargetDefinition|null;definition_hash:string;created_at:string;expires_at:string;expired:boolean}
export interface TargetSnapshot extends TargetPreview {title:string;state:'ACTIVE'|'REVOKED';version:number;included_count:number;excluded_count:number}
async function getQuery(client:PoolClient,id:string) {
  const query=(await client.query<CollectionQuery>('SELECT id,title,snapshot,snapshot_hash,created_at,expires_at FROM kff.collection_queries WHERE id=$1',[id])).rows[0];
  requireCondition(query,'NOT_FOUND','查询不存在',404);return query;
}
function selectTargets(query:CollectionQuery,rows:CollectionResult[],input:TargetPreviewInput):FrozenCollectionTarget[] {
  return rows.map(row=>{
    const reasons:string[]=[];
    if(!row.allowed_purposes.includes(input.purpose))reasons.push('SOURCE_PURPOSE_NOT_ALLOWED');
    if(input.purpose==='marketing'||input.purpose==='customer_service')reasons.push('ACTION_AND_CONTACT_QUALIFICATION_REQUIRED');
    if(input.fields.some(field=>!query.snapshot.fields.includes(field)))reasons.push('SOURCE_FIELD_NOT_ALLOWED');
    return {result_id:row.id,observation_id:row.observation_id,source_object_id:row.source_object_id,source_key:query.snapshot.source_key,object_version:row.object_version,evidence_hash:row.evidence_hash,source_url:row.source_url,
      observed_at:new Date(row.observed_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),allowed_purposes:row.allowed_purposes,disposition:reasons.length?'EXCLUDED':'INCLUDED',reason_codes:reasons,
      fields:reasons.length?{}:Object.fromEntries(input.fields.filter(field=>row.fields[field]!==undefined).map(field=>[field,row.fields[field]!]))};
  });
}
export async function previewTargets(scope:Scope,input:TargetPreviewInput):Promise<TargetPreview> {
  requireWrite(scope);const value=targetPreviewInput.parse(input);const hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['target-preview/'+scope.brand_id+'/'+value.request_id]);
    const previous=(await client.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.target_previews WHERE request_id=$1',[value.request_id])).rows[0];
    if(previous){requireCondition(previous.request_hash===hash,'IDEMPOTENCY_CONFLICT','预览请求已有不同选择',409);requireCondition(!previous.expired&&previous.definition,'RETENTION_EXPIRED','此预览已到期，请生成新预览',410);return previous;}
    const query=await getQuery(client,value.query_id);requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[query.expires_at])).rows[0].valid,'RETENTION_EXPIRED','来源查询已到期',410);
    const run=(await client.query('SELECT id,returned_count,unique_count FROM kff.collection_runs WHERE query_id=$1 FOR SHARE',[query.id])).rows[0];
    const all=await filteredCollectionRows(client,query,run.id,value.filter);let selected:CollectionResult[];
    if(value.mode==='CURRENT_PAGE'){
      const page=collectionResultPage(query,all,value.filter,value.after,value.page_size);requireCondition(page.page_hash===value.page_hash,'SELECTION_VIEW_CHANGED','当前页已经变化，请刷新后重新选择',409);selected=page.results;
    }else if(value.mode==='MANUAL'){
      const ids=new Set(value.result_ids);selected=all.filter(row=>ids.has(row.id));requireCondition(selected.length===ids.size,'SELECTION_VIEW_CHANGED','手选对象不属于当前筛选或已经到期',409);
      requireCondition(selected.every(row=>value.observations.some(item=>item.result_id===row.id&&item.observation_id===row.observation_id)),'SELECTION_VIEW_CHANGED','手选对象的观察版本已经变化，请重新核对',409);
    }else selected=all;
    const targets=selectTargets(query,selected,value);const included=targets.filter(row=>row.disposition==='INCLUDED').length;
    const sourceExpires=new Date(Math.min(new Date(query.expires_at).getTime(),...targets.map(row=>new Date(row.expires_at).getTime()))).toISOString();
    const definition:TargetDefinition={schema_version:'kff.target-set.v1',query_id:query.id,account_id:query.snapshot.account_id,query_snapshot_hash:query.snapshot_hash,input:value,included_count:included,excluded_count:targets.length-included,filtered_count:all.length,source_returned_count:run.returned_count,source_unique_count:run.unique_count,targets,source_expires_at:sourceExpires,execution_authorized:false};
    const result=(await client.query<TargetPreview>('INSERT INTO kff.target_previews(organization_id,brand_id,query_id,request_id,request_hash,definition,definition_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9::timestamptz,now()+interval \'15 minutes\')) RETURNING id,query_id,definition,definition_hash,created_at,expires_at,false AS expired',[scope.organization_id,scope.brand_id,query.id,value.request_id,hash,definition,digest(definition),scope.user_id,sourceExpires])).rows[0];
    await audit(client,scope,'targets.previewed',query.id,{preview_id:result.id,definition_hash:result.definition_hash,mode:value.mode,included_count:included,excluded_count:definition.excluded_count});return result;
  });
}
export async function saveTargetSnapshot(scope:Scope,input:z.infer<typeof targetSnapshotInput>):Promise<TargetSnapshot> {
  requireWrite(scope);const value=targetSnapshotInput.parse(input);const hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['target-snapshot-request/'+scope.brand_id+'/'+value.request_id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['target-snapshot/'+scope.brand_id+'/'+value.preview_id]);
    const previous=(await client.query<TargetSnapshot&{preview_id:string;request_hash:string;request_id:string}>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.target_snapshots WHERE request_id=$1 OR preview_id=$2 ORDER BY (request_id=$1) DESC LIMIT 1',[value.request_id,value.preview_id])).rows[0];
    if(previous){requireCondition(previous.preview_id===value.preview_id&&previous.definition_hash===value.preview_hash&&previous.title===value.title&&previous.included_count===value.confirmed_included_count&&previous.excluded_count===value.confirmed_excluded_count&&(previous.request_id!==value.request_id||previous.request_hash===hash),'IDEMPOTENCY_CONFLICT','保存请求已对应不同目标范围',409);return {...previous,definition:previous.expired?null:previous.definition};}
    const preview=(await client.query<TargetPreview>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.target_previews WHERE id=$1 FOR SHARE',[value.preview_id])).rows[0];
    requireCondition(preview,'NOT_FOUND','目标预览不存在',404);requireCondition(!preview.expired&&preview.definition,'RETENTION_EXPIRED','预览已到期，请重新选择',410);
    requireCondition(preview.definition_hash===value.preview_hash&&digest(preview.definition)===value.preview_hash,'PREVIEW_MISMATCH','目标预览摘要不一致',409);
    const definition=preview.definition;requireCondition(definition.included_count===value.confirmed_included_count&&definition.excluded_count===value.confirmed_excluded_count,'INVALID_CONFIRMATION','请核对准确的纳入与排除数量');
    const query=await getQuery(client,preview.query_id);requireCondition(query.snapshot_hash===definition.query_snapshot_hash,'PREVIEW_MISMATCH','来源定义发生变化',409);
    requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[definition.source_expires_at])).rows[0].valid,'RETENTION_EXPIRED','来源观察已到期，请重新选择',410);
    const result=(await client.query<TargetSnapshot>('INSERT INTO kff.target_snapshots(organization_id,brand_id,query_id,preview_id,request_id,request_hash,title,definition,definition_hash,included_count,excluded_count,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,query_id,title,state,version,definition,definition_hash,included_count,excluded_count,created_at,expires_at,false AS expired',[scope.organization_id,scope.brand_id,query.id,preview.id,value.request_id,hash,value.title,definition,value.preview_hash,definition.included_count,definition.excluded_count,scope.user_id,definition.source_expires_at])).rows[0];
    await audit(client,scope,'targets.snapshot_saved',result.id,{query_id:query.id,preview_id:preview.id,definition_hash:result.definition_hash,included_count:result.included_count,excluded_count:result.excluded_count});return result;
  });
}
export async function targetSnapshots(scope:Scope,queryId:string) {
  return scoped(scope,async client=>{await getQuery(client,queryId);return (await client.query<Omit<TargetSnapshot,'definition'>>('SELECT id,query_id,title,state,version,definition_hash,included_count,excluded_count,created_at,expires_at,expires_at<=clock_timestamp() AS expired FROM kff.target_snapshots WHERE query_id=$1 ORDER BY created_at DESC,id LIMIT 100',[queryId])).rows;});
}
export async function readTargetSnapshot(scope:Scope,id:string) {
  return scoped(scope,async client=>{const row=(await client.query<TargetSnapshot>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.target_snapshots WHERE id=$1',[id])).rows[0];requireCondition(row,'NOT_FOUND','目标快照不存在',404);return {...row,definition:row.expired?null:row.definition};});
}
export async function lockTargetSnapshot(client:PoolClient,id:string,queryId:string) {
  const row=(await client.query<TargetSnapshot>('SELECT *,expires_at<=clock_timestamp() AS expired FROM kff.target_snapshots WHERE id=$1 AND query_id=$2 FOR SHARE',[id,queryId])).rows[0];requireCondition(row,'NOT_FOUND','目标快照不属于此查询',404);
  requireCondition(row.state==='ACTIVE','TARGET_SNAPSHOT_REVOKED','目标快照已撤销',409);requireCondition(!row.expired&&row.definition,'RETENTION_EXPIRED','目标快照已到期',410);requireCondition(digest(row.definition)===row.definition_hash,'PREVIEW_MISMATCH','目标快照摘要不一致',409);return {...row,definition:row.definition};
}
export async function revokeTargetSnapshot(scope:Scope,id:string,input:z.infer<typeof targetRevokeInput>) {
  requireWrite(scope);const value=targetRevokeInput.parse(input);
  return scoped(scope,async client=>{
    const row=(await client.query<TargetSnapshot>('SELECT * FROM kff.target_snapshots WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row,'NOT_FOUND','目标快照不存在',404);
    const previous=(await client.query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='targets.snapshot_revoked' AND details->>'request_id'=$2",[id,value.request_id])).rows[0];
    if(previous){requireCondition(previous.details.request_hash===digest(value),'IDEMPOTENCY_CONFLICT','撤销请求已对应不同内容',409);return previous.details.result;}
    requireCondition(row.state==='ACTIVE'&&row.version===value.expected_version,'VERSION_CONFLICT','目标快照状态已变化',409);
    const result=(await client.query("UPDATE kff.target_snapshots SET state='REVOKED',version=version+1 WHERE id=$1 RETURNING id,state,version",[id])).rows[0];
    await audit(client,scope,'targets.snapshot_revoked',id,{request_id:value.request_id,request_hash:digest(value),reason:value.reason,result});return result;
  });
}
export async function purgeExpiredTargetSets() {
  return transaction(async client=>{
    const counts={previews:0,snapshots:0};
    for(const [kind,table] of [['previews','target_previews'],['snapshots','target_snapshots']] as const){
      const cleared=await client.query('UPDATE kff.'+table+' SET definition=NULL WHERE id IN (SELECT id FROM kff.'+table+' WHERE definition IS NOT NULL AND expires_at<=clock_timestamp() ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,organization_id,brand_id,definition_hash');
      counts[kind]=cleared.rowCount??0;
      for(const row of cleared.rows)await client.query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$1,'targets.definition_purged',$3,$4)",[row.organization_id,row.brand_id,row.id,{actor_kind:'system',kind,definition_hash:row.definition_hash,scope:'local_database_copy_only'}]);
    }
    return counts;
  });
}
