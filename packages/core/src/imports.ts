import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { scoped, transaction } from '@kff/database';
import type { Scope } from '@kff/contracts';
import { importUploadInput, importMappingInput, importConfirmationInput, type ImportUpload, type ParsedImport, type ImportMapping, type ImportRowPreview, type ManualImportSnapshot } from '../../contracts/src/imports';
import type { z } from 'zod';
import { digest, requireCondition } from './index';
import { audit, requireWrite } from './service';
import { parseImportFile } from './import-parser';
import { mapImportRows } from './import-mapping';

interface ImportFile { id:string; organization_id:string; brand_id:string; account_id:string; configuration:ImportUpload; created_by:string; file_hash:string; request_hash:string; byte_length:number; expires_at:string; original_expires_at:string; created_at:string; original:Buffer|null; parsed:ParsedImport|null; data_valid:boolean; original_valid:boolean }
const selectFile = 'SELECT *,expires_at>clock_timestamp() AS data_valid,original_expires_at>clock_timestamp() AS original_valid FROM kff.import_files';
function canReadOriginal(scope:Scope, file:ImportFile) { requireCondition(file.configuration.original_access === 'brand' || scope.role === 'admin' || scope.user_id === file.created_by, 'FORBIDDEN_SCOPE','原文件和映射仅向上传者及管理员开放',403); }
async function readFile(client:PoolClient,id:string) { const file=(await client.query<ImportFile>(selectFile+' WHERE id=$1',[id])).rows[0]; requireCondition(file,'NOT_FOUND','导入文件不存在',404); return file; }
async function sourceLock(client:PoolClient,scope:Scope,file:ImportFile) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['manual-import/'+scope.brand_id+'/'+file.account_id+'/'+file.configuration.source_namespace]); }
async function existingObjects(client:PoolClient,file:ImportFile,rows:ImportRowPreview[]) {
  const ids = [...new Set(rows.flatMap(row => row.record ? [row.record.source_object_id] : []))].sort();
  return (await client.query<{source_object_id:string;last_version:number}>('SELECT source_object_id,last_version FROM kff.collection_objects WHERE account_id=$1 AND source_key=$2 AND source_object_id=ANY($3::text[]) ORDER BY source_object_id',[file.account_id,'manual:'+file.configuration.source_namespace,ids])).rows;
}
export async function uploadImport(scope:Scope,input:ImportUpload,bytes:Buffer) {
  requireWrite(scope); const value=importUploadInput.parse(input); const fileHash=createHash('sha256').update(bytes).digest('hex'); const requestHash=digest({configuration:value,file_hash:fileHash});
  const previous = await scoped(scope,async client => {
    const old=(await client.query('SELECT id,request_hash FROM kff.import_files WHERE request_id=$1',[value.request_id])).rows[0];
    if(old) { requireCondition(old.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','上传请求已对应另一份文件或配置',409); return old.id as string; }
    requireCondition((await client.query('SELECT id FROM kff.accounts WHERE id=$1',[value.account_id])).rowCount,'FORBIDDEN_SCOPE','账号不属于当前品牌',403); return null;
  }); if(previous) return {id:previous,reused:true};
  const parsed=await parseImportFile(bytes,value);
  return scoped(scope,async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['import-upload/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query('SELECT id,request_hash FROM kff.import_files WHERE request_id=$1',[value.request_id])).rows[0];
    if(old) { requireCondition(old.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','上传请求已对应另一份文件或配置',409); return {id:old.id as string,reused:true}; }
    const file=(await client.query('INSERT INTO kff.import_files(organization_id,brand_id,request_id,account_id,created_by,configuration,request_hash,file_hash,byte_length,original,parsed,original_expires_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+make_interval(days=>$12),now()+make_interval(days=>$13)) RETURNING id',[scope.organization_id,scope.brand_id,value.request_id,value.account_id,scope.user_id,value,requestHash,fileHash,bytes.length,bytes,parsed,value.original_retention_days,value.retention_days])).rows[0];
    await audit(client,scope,'import.uploaded',file.id,{file_hash:fileHash,byte_length:bytes.length,format:value.format,source_type:'MANUAL_IMPORT',original_access:value.original_access}); return {id:file.id as string,reused:false};
  });
}
export async function importWorkspace(scope:Scope) {
  return scoped(scope,async client => (await client.query('SELECT f.id,f.configuration,f.file_hash,f.byte_length,f.created_at,f.expires_at,f.original_expires_at,c.query_id FROM kff.import_files f LEFT JOIN kff.import_confirmations c ON c.import_id=f.id ORDER BY f.created_at DESC,f.id LIMIT 100')).rows);
}
export async function importDetail(scope:Scope,id:string) {
  return scoped(scope,async client => {
    const file=await readFile(client,id); canReadOriginal(scope,file); const confirmation=(await client.query('SELECT query_id,preview_id FROM kff.import_confirmations WHERE import_id=$1',[id])).rows[0] ?? null;
    const preview=(await client.query('SELECT id,mapping,summary,preview_hash,created_at,CASE WHEN expires_at>clock_timestamp() THEN rows ELSE NULL END AS rows FROM kff.import_previews WHERE import_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0] ?? null;
    return {id:file.id,configuration:file.configuration,file_hash:file.file_hash,byte_length:file.byte_length,created_at:file.created_at,expires_at:file.expires_at,original_expires_at:file.original_expires_at,expired:!file.data_valid,
      sheets:file.data_valid ? file.parsed?.sheets.map(sheet => ({name:sheet.name,row_count:sheet.rows.length,headers:sheet.rows.slice(0,20)})) ?? [] : [],preview,confirmation};
  });
}
export async function downloadImportOriginal(scope:Scope,id:string) {
  return scoped(scope,async client => { const file=await readFile(client,id); canReadOriginal(scope,file); requireCondition(file.original_valid && file.original,'RETENTION_EXPIRED','原文件保留期已结束',410); await audit(client,scope,'import.original_downloaded',id,{file_hash:file.file_hash}); return {bytes:file.original,filename:file.configuration.filename,format:file.configuration.format,content_type:file.configuration.format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset='+file.configuration.encoding}; });
}
export async function previewImport(scope:Scope,id:string,input:ImportMapping) {
  requireWrite(scope); const mapping=importMappingInput.parse(input); const requestHash=digest(mapping);
  return scoped(scope,async client => {
    const file=await readFile(client,id); canReadOriginal(scope,file); await sourceLock(client,scope,file);
    requireCondition(file.data_valid && file.parsed,'RETENTION_EXPIRED','导入数据保留期已结束',410);
    requireCondition(!(await client.query('SELECT id FROM kff.import_confirmations WHERE import_id=$1',[id])).rowCount,'IMPORT_ALREADY_CONFIRMED','此文件已经确认入库',409);
    const old=(await client.query('SELECT * FROM kff.import_previews WHERE import_id=$1 AND request_id=$2',[id,mapping.request_id])).rows[0];
    if(old) { requireCondition(old.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','预览请求已对应另一份映射',409); return old; }
    const rows=mapImportRows(file.parsed,mapping); const existing=await existingObjects(client,file,rows); const valid=rows.filter(row=>row.record);
    const summary={total_rows:rows.length,valid_rows:valid.length,error_rows:rows.length-valid.length,unique_objects:new Set(valid.map(row=>row.source_object_id)).size,duplicate_rows:valid.filter(row=>row.duplicate_in_file).length,existing_objects:existing};
    const previewHash=digest({file_hash:file.file_hash,mapping,rows,summary});
    const preview=(await client.query('INSERT INTO kff.import_previews(organization_id,brand_id,import_id,request_id,request_hash,mapping,rows,summary,preview_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,mapping,rows,summary,preview_hash,created_at',[scope.organization_id,scope.brand_id,id,mapping.request_id,requestHash,mapping,JSON.stringify(rows),summary,previewHash,file.expires_at])).rows[0];
    await audit(client,scope,'import.previewed',id,{preview_id:preview.id,preview_hash:previewHash,valid_rows:valid.length,error_rows:summary.error_rows}); return preview;
  });
}
export async function confirmImport(scope:Scope,id:string,input:z.infer<typeof importConfirmationInput>) {
  requireWrite(scope); const value=importConfirmationInput.parse(input); const requestHash=digest({import_id:id,...value});
  return scoped(scope,async client => {
    const file=await readFile(client,id); canReadOriginal(scope,file); await sourceLock(client,scope,file);
    const old=(await client.query('SELECT c.*,p.preview_hash,p.summary FROM kff.import_confirmations c JOIN kff.import_previews p ON p.id=c.preview_id WHERE c.import_id=$1 OR c.id=$2 ORDER BY (c.id=$2) DESC LIMIT 1',[id,value.request_id])).rows[0];
    if(old) { requireCondition(old.import_id===id && old.preview_id===value.preview_id && old.preview_hash===value.preview_hash && old.summary.error_rows===value.excluded_error_rows && (old.id!==value.request_id || old.request_hash===requestHash),'IDEMPOTENCY_CONFLICT','确认请求已有不同内容',409); return {query_id:old.query_id as string,reused:true}; }
    requireCondition(file.data_valid,'RETENTION_EXPIRED','导入数据保留期已结束',410);
    const preview=(await client.query('SELECT * FROM kff.import_previews WHERE id=$1 AND import_id=$2',[value.preview_id,id])).rows[0];
    requireCondition(preview && preview.preview_hash===value.preview_hash && preview.rows,'PREVIEW_MISMATCH','预览不存在、已过期或摘要不一致',409);
    const rows:ImportRowPreview[]=preview.rows; const valid=rows.flatMap(row=>row.record ? [row.record] : []);
    requireCondition(digest({file_hash:file.file_hash,mapping:preview.mapping,rows,summary:preview.summary})===preview.preview_hash,'PREVIEW_MISMATCH','预览内容与不可变摘要不一致',409);
    requireCondition(value.excluded_error_rows===preview.summary.error_rows && valid.length>0,'INVALID_CONFIRMATION','请明确确认有效行及排除的错误数量');
    const {request_id:_requestId,...mappingIdentity}=preview.mapping as ImportMapping;
    const configuration=file.configuration;
    const contentHash=digest({file_hash:file.file_hash,mapping:mappingIdentity,account_id:file.account_id,source_namespace:configuration.source_namespace,source_description:configuration.source_description,processing_basis:configuration.processing_basis,purpose:configuration.purpose,export_fields:configuration.export_fields,retention_days:configuration.retention_days});
    const duplicate=(await client.query('SELECT c.query_id FROM kff.import_confirmations c JOIN kff.collection_queries q ON q.id=c.query_id WHERE c.content_hash=$1 AND q.expires_at>clock_timestamp() ORDER BY c.created_at LIMIT 1',[contentHash])).rows[0];
    let queryId:string;
    if(duplicate) queryId=duplicate.query_id;
    else {
      requireCondition(digest(await existingObjects(client,file,rows))===digest(preview.summary.existing_objects),'PREVIEW_STALE','同源记录已经变化，请重新预览后确认',409);
      const snapshot:ManualImportSnapshot={schema_version:'kff.manual-import.v1',source_type:'MANUAL_IMPORT',source_key:'manual:'+configuration.source_namespace,source_version:'manual-file-v1',account_id:file.account_id,title:configuration.title,fields:Object.keys(preview.mapping.fields) as ManualImportSnapshot['fields'],export_fields:configuration.export_fields,display_timezone:configuration.display_timezone,allowed_purposes:['data_review'],import_id:id,source_description:configuration.source_description,processing_basis:configuration.processing_basis,file_hash:file.file_hash,preview_hash:preview.preview_hash,coverage:'UPLOADED_ROWS_ONLY',original_rows:rows.length,excluded_error_rows:preview.summary.error_rows};
      queryId=randomUUID(); const runId=randomUUID(); const pageId=randomUUID();
      await client.query('INSERT INTO kff.collection_queries(id,organization_id,brand_id,request_id,account_id,title,snapshot,snapshot_hash,request_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[queryId,scope.organization_id,scope.brand_id,value.request_id,file.account_id,configuration.title,snapshot,digest(snapshot),contentHash,scope.user_id,file.expires_at]);
      await client.query("INSERT INTO kff.collection_runs(id,organization_id,brand_id,query_id,state,version,committed_pages,returned_count,unique_count,stop_reason,started_at,finished_at) VALUES($1,$2,$3,$4,'COMPLETED',1,1,$5,$6,'IMPORT_CONFIRMED',now(),now())",[runId,scope.organization_id,scope.brand_id,queryId,valid.length,new Set(valid.map(row=>row.source_object_id)).size]);
      const now=(await client.query('SELECT now() AS time')).rows[0].time;
      await client.query('INSERT INTO kff.collection_pages(id,organization_id,brand_id,run_id,page_number,cursor_in_hash,evidence_hash,observed_at,returned_count) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)',[pageId,scope.organization_id,scope.brand_id,runId,digest(null),preview.preview_hash,now,valid.length]);
      const objects=new Map<string,{id:string;last_version:number}>();
      for(const objectId of [...new Set(valid.map(row=>row.source_object_id))].sort()) {
        await client.query('INSERT INTO kff.collection_objects(organization_id,brand_id,account_id,source_key,source_object_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,brand_id,account_id,source_key,source_object_id) DO NOTHING',[scope.organization_id,scope.brand_id,file.account_id,snapshot.source_key,objectId]);
        objects.set(objectId,(await client.query('SELECT id,last_version FROM kff.collection_objects WHERE account_id=$1 AND source_key=$2 AND source_object_id=$3 FOR UPDATE',[file.account_id,snapshot.source_key,objectId])).rows[0]);
      }
      for(const record of valid) {
        const object=objects.get(record.source_object_id)!; object.last_version++; const observation=randomUUID();
        await client.query('UPDATE kff.collection_objects SET last_version=$1 WHERE id=$2',[object.last_version,object.id]);
        const evidenceHash=digest({file_hash:file.file_hash,preview_hash:preview.preview_hash,sheet:preview.mapping.sheet,...record});
        await client.query('INSERT INTO kff.collection_observations(id,organization_id,brand_id,object_id,run_id,page_id,row_number,object_version,source_object_id,source_url,observed_at,fields,evidence_hash,allowed_purposes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[observation,scope.organization_id,scope.brand_id,object.id,runId,pageId,record.row_number,object.last_version,record.source_object_id,'/api/imports/'+id+'/original#row='+record.row_number,now,record.fields,evidenceHash,JSON.stringify(snapshot.allowed_purposes),file.expires_at]);
        await client.query('INSERT INTO kff.collection_results(organization_id,brand_id,run_id,object_id,observation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,object_id) DO UPDATE SET observation_id=EXCLUDED.observation_id',[scope.organization_id,scope.brand_id,runId,object.id,observation]);
      }
    }
    await client.query('INSERT INTO kff.import_confirmations(id,organization_id,brand_id,import_id,preview_id,request_hash,query_id,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[value.request_id,scope.organization_id,scope.brand_id,id,preview.id,requestHash,queryId,contentHash,scope.user_id]);
    await audit(client,scope,'import.confirmed',id,{query_id:queryId,preview_id:preview.id,preview_hash:preview.preview_hash,file_hash:file.file_hash,valid_rows:valid.length,error_rows:preview.summary.error_rows,reused:!!duplicate}); return {query_id:queryId,reused:!!duplicate};
  });
}
export async function purgeExpiredImports() {
  return transaction(async client => {
    const originals=await client.query('UPDATE kff.import_files SET original=NULL WHERE original IS NOT NULL AND original_expires_at<=clock_timestamp() RETURNING id,organization_id,brand_id');
    const parsed=await client.query('UPDATE kff.import_files SET parsed=NULL WHERE parsed IS NOT NULL AND expires_at<=clock_timestamp()');
    const previews=await client.query('UPDATE kff.import_previews SET rows=NULL WHERE rows IS NOT NULL AND expires_at<=clock_timestamp()');
    for(const file of originals.rows) await client.query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$1,'import.original_purged',$3,$4)",[file.organization_id,file.brand_id,file.id,{actor_kind:'system',scope:'local_database_original_only'}]);
    return {originals:originals.rowCount,parsed:parsed.rowCount,previews:previews.rowCount};
  });
}
