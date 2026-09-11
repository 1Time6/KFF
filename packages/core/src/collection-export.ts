import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { scoped } from '@kff/database';
import type { Scope, CollectionQuery, CollectionResult } from '@kff/contracts';
import { collectionExportInput } from '../../contracts/src/imports';
import type { z } from 'zod';
import { requireCondition } from './index';
import { audit } from './service';
import {lockTargetSnapshot} from './target-snapshots';

export async function exportCollection(scope:Scope,id:string,input:z.infer<typeof collectionExportInput>) {
  const value=collectionExportInput.parse(input);
  return scoped(scope,async client => {
    const query=(await client.query<CollectionQuery>('SELECT * FROM kff.collection_queries WHERE id=$1',[id])).rows[0];
    requireCondition(query,'NOT_FOUND','查询不存在',404);
    const snapshot=query.snapshot;
    const allowed=snapshot.source_type==='MANUAL_IMPORT' ? snapshot.export_fields : snapshot.source_type==='OWNED_FIXTURE' ? snapshot.fields : [];
    requireCondition(value.fields.every(field=>allowed.includes(field) && snapshot.fields.includes(field)),'EXPORT_FIELD_FORBIDDEN','来源未允许导出所选字段',403);
    const run=(await client.query('SELECT * FROM kff.collection_runs WHERE query_id=$1 FOR SHARE',[id])).rows[0];
    const frozen=value.target_snapshot_id?await lockTargetSnapshot(client,value.target_snapshot_id,id):null;
    if(frozen)requireCondition(value.fields.every(field=>frozen.definition.input.fields.includes(field)),'EXPORT_FIELD_FORBIDDEN','此字段没有包含在固定快照中',403);
    const rows:CollectionResult[]=frozen?frozen.definition.targets.filter(row=>row.disposition==='INCLUDED').map((row,index)=>({...row,id:row.result_id,result_order:String(index+1)})):(await client.query<CollectionResult>('SELECT r.id,r.observation_id,r.result_order::text,o.source_object_id,o.observed_at,o.source_url,o.fields,o.evidence_hash,o.allowed_purposes,o.expires_at,o.object_version FROM kff.collection_results r JOIN kff.collection_observations o ON o.id=r.observation_id WHERE r.run_id=$1 AND ($2::uuid[] IS NULL OR r.id=ANY($2)) AND o.expires_at>clock_timestamp() ORDER BY r.result_order LIMIT 1001',[run.id,value.result_ids??null])).rows;
    requireCondition(rows.length<=1000 && (!value.result_ids || rows.length===value.result_ids.length),'EXPORT_SELECTION_CHANGED','所选结果包含不存在、越权或已过期对象，请刷新后重选',409);
    const headers=['source_object_id',...value.fields.flatMap(field=>[field,field+'__kind']),'source_type','source_url','observation_id','observed_at','expires_at','evidence_hash','allowed_purposes','query_id','returned_count','unique_count','reported_total','coverage','target_snapshot_id','target_snapshot_hash','_kff_text_encoding'];
    const isCSV=value.format==='csv'; const text=(value:string)=>isCSV ? "'"+value : value;
    const table=rows.map(row=>{
      const data:(string|number|boolean)[]=[text(row.source_object_id)];
      for(const key of value.fields) { const field=row.fields[key]??{kind:'NOT_RETURNED'}; const content=field.kind==='VALUE' ? typeof field.value==='string' ? text(field.value) : field.value : ''; data.push(content,field.kind); }
      data.push(text(snapshot.source_type),text(row.source_url),text(row.observation_id),text(new Date(row.observed_at).toISOString()),text(new Date(row.expires_at).toISOString()),text(row.evidence_hash),text(row.allowed_purposes.join(',')),text(id),frozen?.definition.source_returned_count??run.returned_count,frozen?.definition.source_unique_count??run.unique_count,frozen?'':run.reported_total??'',snapshot.source_type==='MANUAL_IMPORT'?'UPLOADED_ROWS_ONLY':'SYNTHETIC_SAMPLE',text(frozen?.id??''),text(frozen?.definition_hash??''),isCSV?'apostrophe-v1':'typed-xlsx-v1'); return data;
    });
    let bytes:Buffer;
    if(isCSV) bytes=Buffer.from(stringify([headers,...table],{bom:true,record_delimiter:'\r\n',quoted:true}),'utf8');
    else {
      const workbook=new ExcelJS.Workbook(); workbook.creator='KFF'; const sheet=workbook.addWorksheet('Results',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
      sheet.addRow(headers); sheet.addRows(table); sheet.columns=headers.map(key=>({width:key==='source_object_id'?40:key==='message'?48:26}));
      sheet.eachRow(row=>{ row.height=26; row.eachCell(cell=>{ cell.font={name:'Arial',size:10}; cell.alignment={vertical:'middle',wrapText:true}; if(typeof cell.value==='string') cell.numFmt='@'; }); });
      sheet.getRow(1).eachCell(cell=>{cell.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF243349'}};});
      bytes=Buffer.from(await workbook.xlsx.writeBuffer());
    }
    requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[query.expires_at])).rows[0].valid,'RETENTION_EXPIRED','结果保留期已结束',410);
    if(frozen)requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[frozen.expires_at])).rows[0].valid,'RETENTION_EXPIRED','目标快照已到期',410);
    const hash=createHash('sha256').update(bytes).digest('hex');
    await audit(client,scope,'collection.exported',id,{format:value.format,fields:value.fields,exported_objects:rows.length,observation_ids:rows.map(row=>row.observation_id),file_hash:hash,expires_at:frozen?.expires_at??query.expires_at,coverage:snapshot.source_type==='MANUAL_IMPORT'?'UPLOADED_ROWS_ONLY':'SYNTHETIC_SAMPLE',target_snapshot_id:frozen?.id??null,target_snapshot_hash:frozen?.definition_hash??null});
    return {bytes,filename:'kff-results-'+id+'.'+value.format,format:value.format,file_hash:hash};
  });
}
