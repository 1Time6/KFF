import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import ExcelJS from 'exceljs';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import {uploadImport,previewImport,confirmImport,downloadImportOriginal,importDetail,purgeExpiredImports} from '../../packages/core/src/imports';
import {parseImportFile} from '../../packages/core/src/import-parser';
import {mapImportRows} from '../../packages/core/src/import-mapping';
import {exportCollection} from '../../packages/core/src/collection-export';
import {collectionDetail,createCollection,processCollectionPage} from '../../packages/core/src/collections';
import {syntheticCollectionPage} from '../../packages/adapters/src/collection-fixture';
import type {ImportUpload,ImportMapping,Scope,ImportRowPreview} from '../../packages/contracts/src/index';

const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
const csv=Buffer.from('source_object_id,message,author_id,reaction_count,comment_count\r\n000001,"中文,逗号\n第二行",00002,0,0\r\n9007199254740993123456789,=1+1,00003,2,1\r\n000001,更新,00002,3,1\r\n');
const input=(extra:Partial<ImportUpload>={}):ImportUpload=>({request_id:randomUUID(),account_id:localIds.account,title:'Synthetic manual input',filename:'sample.csv',format:'csv',encoding:'utf-8',source_namespace:'owned-sample',source_description:'Repository authored sample, not platform data',processing_basis:'Owned synthetic software verification data',purpose:'data_review',export_fields:['message','author_id','reaction_count','comment_count'],original_access:'owner_admin',original_retention_days:7,retention_days:7,display_timezone:'Asia/Shanghai',...extra});
const mapping=(extra:Partial<ImportMapping>={}):ImportMapping=>({request_id:randomUUID(),sheet:0,header_row:1,source_object_id:0,fields:{message:1,author_id:2,reaction_count:3,comment_count:4},kind_columns:{},text_encoding:'plain',...extra});
async function prepared(bytes=csv,configuration=input(),mapped=mapping()) {const uploaded=await uploadImport(scope,configuration,bytes);const preview=await previewImport(scope,uploaded.id,mapped);return {id:uploaded.id,preview,configuration};}
const confirmation=(preview:{id:string;preview_hash:string;summary:{error_rows:number}})=>({request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.preview_hash,excluded_error_rows:preview.summary.error_rows,confirm_valid_rows:true as const});
async function reset(){await query('TRUNCATE kff.import_files,kff.collection_queries,kff.collection_objects CASCADE');}
beforeAll(async()=>{const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated database required');await migrate();await seed();});
beforeEach(reset);afterAll(async()=>{await reset();await closePool();});

it('reads an independently authored namespaced XLSX, preserves exact text IDs and reports formula/numeric ID rows',async()=>{
  const bytes=readFileSync('tests/fixtures/import-fixture.xlsx');const parsed=await parseImportFile(bytes,{format:'xlsx',encoding:'utf-8'});
  expect(parsed.sheets[0].rows[1][0]).toEqual({type:'text',value:'000123456789012345678901234567890'});
  expect(parsed.sheets[0].rows[2][1]).toEqual({type:'text',value:'=1+1'});
  const result=await prepared(bytes,input({format:'xlsx',filename:'sample.xlsx'}));
  expect(result.preview.summary).toMatchObject({total_rows:7,valid_rows:5,error_rows:2,unique_objects:4,duplicate_rows:1});
  const rows=result.preview.rows as ImportRowPreview[];expect(rows[5].errors).toContain('message: FORMULA_CELL');expect(rows[6].errors).toContain('source_object_id: TEXT_REQUIRED');
  const confirmed=await confirmImport(scope,result.id,confirmation(result.preview));const detail=await collectionDetail(scope,confirmed.query_id);
  expect(detail.run).toMatchObject({state:'COMPLETED',returned_count:5,unique_count:4,reported_total:null,stop_reason:'IMPORT_CONFIRMED'});
  expect(detail.query.snapshot).toMatchObject({source_type:'MANUAL_IMPORT',allowed_purposes:['data_review'],excluded_error_rows:2,coverage:'UPLOADED_ROWS_ONLY'});
  expect(detail.results[0].source_object_id).toBe('000123456789012345678901234567890');expect(detail.results[0].fields.message).toEqual({kind:'VALUE',value:'中文，逗号\n第二行'});
});
it('handles selected UTF-8 BOM, GB18030 and UTF-16LE without lossy replacement or ID coercion',async()=>{
  for(const [bytes,encoding] of [[Buffer.from('\ufeffsource_object_id,message\n0001,中文\n'),'utf-8'],[Buffer.concat([Buffer.from('source_object_id,message\n0001,'),Buffer.from('d6d0cec4','hex')]),'gb18030'],[Buffer.from('\ufeffsource_object_id,message\n0001,中文\n','utf16le'),'utf-16le']] as const){const parsed=await parseImportFile(bytes,{format:'csv',encoding});expect(parsed.sheets[0].rows[1]).toEqual([{type:'text',value:'0001'},{type:'text',value:'中文'}]);}
  await expect(parseImportFile(Buffer.from([0xff,0xfe,0x80]),{format:'csv',encoding:'utf-8'})).rejects.toMatchObject({code:'INVALID_ENCODING'});
  const original=Buffer.concat([Buffer.from('source_object_id,message\n0001,'),Buffer.from('d6d0cec4','hex')]);const saved=await uploadImport(scope,input({encoding:'gb18030'}),original);const downloaded=await downloadImportOriginal(scope,saved.id);expect(downloaded.content_type).toBe('text/csv; charset=gb18030');expect(downloaded.bytes.equals(original)).toBe(true);
});
it('rejects forged container, excessive bytes, row/column expansion and external workbook relationships',async()=>{
  await expect(parseImportFile(Buffer.from('<html>fake xlsx</html>'),{format:'xlsx',encoding:'utf-8'})).rejects.toMatchObject({code:'INVALID_XLSX'});
  await expect(parseImportFile(Buffer.alloc(8*1024*1024+1),{format:'csv',encoding:'utf-8'})).rejects.toMatchObject({code:'FILE_LIMIT_EXCEEDED'});
  await expect(parseImportFile(Buffer.from('h\n'+'a\n'.repeat(1022)),{format:'csv',encoding:'utf-8'})).rejects.toMatchObject({code:'FILE_LIMIT_EXCEEDED'});
  await expect(parseImportFile(Buffer.from(Array(33).fill('a').join(',')),{format:'csv',encoding:'utf-8'})).rejects.toMatchObject({code:'FILE_LIMIT_EXCEEDED'});
  const book=new ExcelJS.Workbook();book.addWorksheet('External').getCell('A1').value={text:'external',hyperlink:'https://example.invalid/never-fetch'};
  await expect(parseImportFile(Buffer.from(await book.xlsx.writeBuffer()),{format:'xlsx',encoding:'utf-8'})).rejects.toMatchObject({code:'UNSUPPORTED_EXTERNAL_LINK'});
  const bomb=new ExcelJS.Workbook();bomb.addWorksheet('Expanded').getCell('A1').value='x'.repeat(8*1024*1024+1);const compressed=Buffer.from(await bomb.xlsx.writeBuffer());expect(compressed.length).toBeLessThan(8*1024*1024);
  await expect(parseImportFile(compressed,{format:'xlsx',encoding:'utf-8'})).rejects.toMatchObject({code:'FILE_LIMIT_EXCEEDED'});
});
it('deduplicates concurrent uploads and refuses changed bytes using an existing request ID',async()=>{
  const value=input();const first=await uploadImport(scope,value,csv);const repeated=await Promise.all([uploadImport(scope,value,csv),uploadImport(scope,value,csv)]);expect(repeated.every(row=>row.id===first.id)).toBe(true);
  await expect(uploadImport(scope,value,Buffer.from('different'))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect((await query('SELECT count(*)::int AS n FROM kff.import_files'))[0].n).toBe(1);
  await expect(query("UPDATE kff.import_files SET file_hash='changed' WHERE id=$1",[first.id])).rejects.toThrow('IMMUTABLE_IMPORT_FILE');
});
it('requires explicit error exclusion and binds confirmation to an immutable scoped preview',async()=>{
  const result=await prepared(Buffer.from('source_object_id,message\n,invalid\n0001,valid'),input(),mapping({fields:{message:1}}));
  await expect(confirmImport(scope,result.id,{...confirmation(result.preview),excluded_error_rows:0})).rejects.toMatchObject({code:'INVALID_CONFIRMATION'});
  await expect(confirmImport(scope,result.id,{...confirmation(result.preview),preview_hash:'0'.repeat(64)})).rejects.toMatchObject({code:'PREVIEW_MISMATCH'});
  expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(0);
  await expect(query("UPDATE kff.import_previews SET preview_hash='changed' WHERE id=$1",[result.preview.id])).rejects.toThrow('IMMUTABLE_IMPORT_PREVIEW');
  await confirmImport(scope,result.id,confirmation(result.preview));expect((await query('SELECT row_number FROM kff.collection_observations'))[0].row_number).toBe(3);
});
it('confirms once under concurrent retries and reuses repeated same-content imports without duplicate observations',async()=>{
  const first=await prepared();const confirm=confirmation(first.preview);const results=await Promise.all(Array.from({length:5},()=>confirmImport(scope,first.id,confirm)));
  expect(new Set(results.map(row=>row.query_id)).size).toBe(1);expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(3);
  await expect(confirmImport(scope,first.id,{...confirmation(first.preview),preview_hash:'0'.repeat(64)})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const next=await prepared();const again=await confirmImport(scope,next.id,confirmation(next.preview));expect(again).toMatchObject({query_id:results[0].query_id,reused:true});
  expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(3);expect((await query('SELECT count(*)::int AS n FROM kff.collection_runs'))[0].n).toBe(1);
});
it('rejects a stale duplicate preview then appends new same-source observations after an explicit new preview',async()=>{
  const first=await prepared();const other=await prepared(Buffer.from('source_object_id,message,author_id,reaction_count,comment_count\n000001,new,00002,1,0'));
  await confirmImport(scope,first.id,confirmation(first.preview));await expect(confirmImport(scope,other.id,confirmation(other.preview))).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const refreshed=await previewImport(scope,other.id,mapping());expect(refreshed.summary.existing_objects).toHaveLength(1);const result=await confirmImport(scope,other.id,confirmation(refreshed));
  expect((await collectionDetail(scope,result.query_id)).results[0]).toMatchObject({source_object_id:'000001',object_version:3});
  expect((await query('SELECT count(*)::int AS n FROM kff.collection_objects'))[0].n).toBe(2);
});
it('does not reassign a confirmation request ID when both its import and another import already exist',async()=>{
  const first=await prepared();const firstRequest=confirmation(first.preview);await confirmImport(scope,first.id,firstRequest);
  const second=await prepared(Buffer.from('source_object_id,message,author_id,reaction_count,comment_count\n99999,other,00002,0,0'));const secondRequest=confirmation(second.preview);await confirmImport(scope,second.id,secondRequest);
  await expect(confirmImport(scope,first.id,{...firstRequest,request_id:secondRequest.request_id})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('prevents cross-brand file, preview, confirmation, export and object selection access',async()=>{
  const row=await prepared();const confirmed=await confirmImport(scope,row.id,confirmation(row.preview));const other={...scope,brand_id:randomUUID()};
  for(const call of [()=>importDetail(other,row.id),()=>downloadImportOriginal(other,row.id),()=>previewImport(other,row.id,mapping()),()=>confirmImport(other,row.id,confirmation(row.preview)),()=>exportCollection(other,confirmed.query_id,{format:'csv',fields:['message']})])await expect(call()).rejects.toMatchObject({code:'NOT_FOUND'});
  for(const table of ['import_files','import_previews','import_confirmations'])expect(await scoped(other,async client=>(await client.query('SELECT * FROM kff.'+table)).rows)).toEqual([]);
  await expect(uploadImport(other,input(),csv)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(exportCollection(scope,confirmed.query_id,{format:'csv',fields:['message'],result_ids:[randomUUID()]})).rejects.toMatchObject({code:'EXPORT_SELECTION_CHANGED'});
});
it('enforces original access independently of normalized results and blocks viewer mutations',async()=>{
  const row=await prepared();const viewer={...scope,user_id:randomUUID(),role:'viewer' as const};const operator={...viewer,role:'operator' as const};
  await expect(downloadImportOriginal(operator,row.id)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(importDetail(operator,row.id)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(previewImport(viewer,row.id,mapping())).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(uploadImport(viewer,input(),csv)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  const shared=await uploadImport(scope,input({original_access:'brand'}),csv);expect((await downloadImportOriginal(viewer,shared.id)).bytes.equals(csv)).toBe(true);
  const result=await confirmImport(scope,row.id,confirmation(row.preview));expect((await exportCollection(viewer,result.query_id,{format:'csv',fields:['message']})).bytes.length).toBeGreaterThan(0);
});
it.each(['csv','xlsx'] as const)('round-trips long IDs, formula text, newlines, zero and field states through %s with permitted selection only',async format=>{
  const row=await prepared();const confirmed=await confirmImport(scope,row.id,confirmation(row.preview));const detail=await collectionDetail(scope,confirmed.query_id);
  const exported=await exportCollection(scope,confirmed.query_id,{format,fields:['message','author_id','reaction_count','comment_count'],result_ids:detail.results.map(row=>row.id)});
  const parsed=await parseImportFile(exported.bytes,{format,encoding:'utf-8'});const headers=parsed.sheets[0].rows[0].map(cell=>cell.type==='text'?cell.value:'');const mapped=mapping({fields:{message:1,author_id:3,reaction_count:5,comment_count:7},kind_columns:{message:2,author_id:4,reaction_count:6,comment_count:8},text_encoding:format==='csv'?'kff-apostrophe-v1':'plain'});
  const rows=mapImportRows(parsed,mapped);expect(rows.every(row=>!row.errors.length)).toBe(true);expect(rows.map(row=>row.record!.source_object_id)).toEqual(detail.results.map(row=>row.source_object_id));expect(rows.map(row=>row.record!.fields)).toEqual(detail.results.map(row=>row.fields));expect(headers).toContain('evidence_hash');
  if(format==='xlsx'){const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(exported.bytes).buffer);expect(book.worksheets[0].getCell('A3').type).toBe(ExcelJS.ValueType.String);expect(book.worksheets[0].getCell('B3').value).toBe('=1+1');expect(book.worksheets[0].getCell('B3').type).toBe(ExcelJS.ValueType.String);}
  else expect(exported.bytes.toString('utf8')).toContain("'=1+1");
  const single=await exportCollection(scope,confirmed.query_id,{format,fields:['message'],result_ids:[detail.results[0].id]});expect((await parseImportFile(single.bytes,{format,encoding:'utf-8'})).sheets[0].rows).toHaveLength(2);
});
it('preserves NULL, hidden, absent, empty string and zero independently in a collection CSV round trip',async()=>{
  await query('UPDATE kff.accounts SET outbound_paused=false');await query('UPDATE kff.brands SET outbound_paused=false');await query('UPDATE kff.organizations SET outbound_paused=false');
  const account=(await query('SELECT external_id FROM kff.accounts WHERE id=$1',[localIds.account]))[0];
  const collection=await createCollection(scope,{request_id:randomUUID(),title:'fixture fields',source_key:'kff.fixture.page.posts',account_id:localIds.account,targets:[account.external_id],fields:['message','author_id','reaction_count','comment_count','created_time'],purpose:'software_verification',mode:'TEST_ONLY',incremental_rule:'append_observations',max_records:20,max_pages:10,page_size:100,display_timezone:'UTC',retention_days:7,scenario:'normal'});
  await processCollectionPage({readPage:async request=>syntheticCollectionPage(request)});const detail=await collectionDetail(scope,collection.id);const exported=await exportCollection(scope,collection.id,{format:'csv',fields:detail.query.snapshot.fields});
  const parsed=await parseImportFile(exported.bytes,{format:'csv',encoding:'utf-8'});const rows=mapImportRows(parsed,mapping({fields:{message:7,author_id:1,reaction_count:9,comment_count:3,created_time:5},kind_columns:{message:8,author_id:2,reaction_count:10,comment_count:4,created_time:6},text_encoding:'kff-apostrophe-v1'}));
  expect(rows.every(row=>!row.errors.length)).toBe(true);expect(rows.map(row=>row.record!.fields)).toEqual(detail.results.map(row=>row.fields));
});
it('rejects unauthorized export fields and records exact download scope without customer content in audit',async()=>{
  const row=await prepared(csv,input({export_fields:['message']}));const confirmed=await confirmImport(scope,row.id,confirmation(row.preview));
  await expect(exportCollection(scope,confirmed.query_id,{format:'csv',fields:['author_id']})).rejects.toMatchObject({code:'EXPORT_FIELD_FORBIDDEN'});
  await exportCollection(scope,confirmed.query_id,{format:'csv',fields:['message']});const event=(await query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='collection.exported'",[confirmed.query_id]))[0];
  expect(event.details).toMatchObject({fields:['message'],exported_objects:2,coverage:'UPLOADED_ROWS_ONLY'});expect(event.details.observation_ids).toHaveLength(2);expect(JSON.stringify(event.details)).not.toContain('更新');
});
it('hides expired originals and previews immediately and purges payloads without touching live files',async()=>{
  const row=await prepared();const expiredId=randomUUID();
  await query("INSERT INTO kff.import_files(id,organization_id,brand_id,request_id,account_id,created_by,configuration,request_hash,file_hash,byte_length,original,parsed,created_at,original_expires_at,expires_at) SELECT $1,organization_id,brand_id,$2,account_id,created_by,configuration,request_hash,file_hash,byte_length,original,parsed,now()-interval '2 days',now()-interval '1 day',now()-interval '1 day' FROM kff.import_files WHERE id=$3",[expiredId,randomUUID(),row.id]);
  await query("INSERT INTO kff.import_previews(organization_id,brand_id,import_id,request_id,request_hash,mapping,rows,summary,preview_hash,expires_at,created_at) SELECT organization_id,brand_id,$1,$2,request_hash,mapping,rows,summary,preview_hash,now()-interval '1 day',now()-interval '2 days' FROM kff.import_previews WHERE id=$3",[expiredId,randomUUID(),row.preview.id]);
  await expect(downloadImportOriginal(scope,expiredId)).rejects.toMatchObject({code:'RETENTION_EXPIRED'});expect(await importDetail(scope,expiredId)).toMatchObject({expired:true,sheets:[],preview:{rows:null}});
  expect(await purgeExpiredImports()).toEqual({originals:1,parsed:1,previews:1});expect((await query('SELECT original,parsed FROM kff.import_files WHERE id=$1',[expiredId]))[0]).toEqual({original:null,parsed:null});expect((await downloadImportOriginal(scope,row.id)).bytes.equals(csv)).toBe(true);
});
