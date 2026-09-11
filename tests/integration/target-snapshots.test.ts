import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import {uploadImport,previewImport,confirmImport} from '../../packages/core/src/imports';
import {createCollection,collectionDetail,claimCollection,commitCollectionPage} from '../../packages/core/src/collections';
import {syntheticCollectionPage} from '../../packages/adapters/src/collection-fixture';
import {exportCollection} from '../../packages/core/src/collection-export';
import {parseImportFile} from '../../packages/core/src/import-parser';
import {previewTargets,saveTargetSnapshot,readTargetSnapshot,revokeTargetSnapshot,lockTargetSnapshot,purgeExpiredTargetSets,type TargetPreview} from '../../packages/core/src/target-snapshots';
import {collectionFilterSchema,targetPreviewInput,type TargetPreviewInput} from '../../packages/contracts/src/target-selection';
import type {Scope} from '../../packages/contracts/src/index';

const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
async function source(count=32){
  const file=await uploadImport(scope,{request_id:randomUUID(),account_id:localIds.account,title:'Target set source',filename:'target-input.csv',format:'csv',encoding:'utf-8',source_namespace:'target-source',source_description:'Owned synthetic target records',processing_basis:'Owned repository software fixture',purpose:'data_review',export_fields:['message','author_id','reaction_count'],original_access:'owner_admin',original_retention_days:7,retention_days:7,display_timezone:'UTC'},Buffer.from('source_object_id,message,author_id,reaction_count\n'+Array.from({length:count},(_,index)=>['000'+String(index+1).padStart(2,'0'),index%2?'Other':'Match',index%2?'002':'001',index===0?'':index-1].join(',')).join('\n')));
  const preview=await previewImport(scope,file.id,{request_id:randomUUID(),sheet:0,header_row:1,source_object_id:0,fields:{message:1,author_id:2,reaction_count:3},kind_columns:{},text_encoding:'plain'});
  const confirmed=await confirmImport(scope,file.id,{request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.preview_hash,excluded_error_rows:0,confirm_valid_rows:true});return confirmed.query_id;
}
const selection=(queryId:string,extra:Partial<TargetPreviewInput>={}):TargetPreviewInput=>targetPreviewInput.parse({request_id:randomUUID(),query_id:queryId,mode:'ALL_FILTERED',filter:{},purpose:'data_review',fields:['message','author_id','reaction_count'],...extra});
const confirmation=(preview:TargetPreview)=>({request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.definition_hash,title:'Frozen selection',confirmed_included_count:preview.definition!.included_count,confirmed_excluded_count:preview.definition!.excluded_count});
async function fixture(){
  const account=(await query('SELECT external_id FROM kff.accounts WHERE id=$1',[localIds.account]))[0];
  const collection=await createCollection(scope,{request_id:randomUUID(),title:'Incremental source',source_key:'kff.fixture.page.posts',account_id:localIds.account,targets:[account.external_id],fields:['message','author_id','reaction_count'],purpose:'software_verification',mode:'TEST_ONLY',incremental_rule:'append_observations',max_records:20,max_pages:10,page_size:2,display_timezone:'UTC',retention_days:7,scenario:'normal'});
  const claim=(await claimCollection())!;await commitCollectionPage(claim,syntheticCollectionPage(claim));return collection.id;
}
async function advance(){await query("UPDATE kff.collection_runs SET available_at=now() WHERE state='QUEUED'");const claim=(await claimCollection())!;await commitCollectionPage(claim,syntheticCollectionPage(claim));}
async function reset(){await query('TRUNCATE kff.import_files,kff.collection_queries,kff.collection_objects CASCADE');await query("UPDATE kff.accounts SET outbound_paused=false,state='ACTIVE'");await query('UPDATE kff.brands SET outbound_paused=false');await query('UPDATE kff.organizations SET outbound_paused=false');}
beforeAll(async()=>{const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated database required');await migrate();await seed();});beforeEach(reset);afterAll(async()=>{await reset();await closePool();});

it('distinguishes the exact current page, manual rows across pages and all filtered results',async()=>{
  const id=await source();const first=await collectionDetail(scope,id,'0',25);const second=await collectionDetail(scope,id,first.next_cursor!,25);expect(first.filtered_count).toBe(32);expect(second.results).toHaveLength(7);
  const page=await previewTargets(scope,selection(id,{mode:'CURRENT_PAGE',page_hash:first.page_hash}));expect(page.definition!.targets).toHaveLength(25);
  const picked=[first.results[0],second.results[6]];const manual=await previewTargets(scope,selection(id,{mode:'MANUAL',result_ids:picked.map(row=>row.id),observations:picked.map(row=>({result_id:row.id,observation_id:row.observation_id}))}));expect(manual.definition!.targets.map(row=>row.source_object_id)).toEqual(['00001','00032']);
  const filtered=await previewTargets(scope,selection(id,{filter:collectionFilterSchema.parse({message_contains:'mAtCh'})}));expect(filtered.definition!.targets).toHaveLength(16);
  expect(filtered.definition!.targets.some(row=>row.source_object_id==='00031')).toBe(true);expect(filtered.definition!.execution_authorized).toBe(false);
});
it('treats zero, null, literal ID prefixes and requested field filters independently',async()=>{
  const id=await source(4);const minimum=await collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({min_reactions:0}));expect(minimum.filtered_count).toBe(3);
  const nulls=await collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({field_states:{reaction_count:'NULL'}}));expect(nulls.results.map(row=>row.source_object_id)).toEqual(['00001']);
  expect((await collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({author_id:'001',message_contains:'match',min_reactions:1}))).results.map(row=>row.source_object_id)).toEqual(['00003']);
  expect((await collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({id_prefix:"'; DROP TABLE"}))).results).toEqual([]);
  await expect(collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({field_states:{created_time:'NULL'}}))).rejects.toMatchObject({code:'FILTER_FIELD_UNAVAILABLE'});
});
it('rejects changed current pages and stale manual observation versions before preview creation',async()=>{
  const id=await fixture();const first=await collectionDetail(scope,id,'0',2);await advance();
  await expect(previewTargets(scope,selection(id,{purpose:'software_verification',mode:'CURRENT_PAGE',page_size:2,page_hash:first.page_hash}))).rejects.toMatchObject({code:'SELECTION_VIEW_CHANGED'});
  await expect(previewTargets(scope,selection(id,{purpose:'software_verification',mode:'MANUAL',result_ids:[first.results[0].id],observations:[{result_id:first.results[0].id,observation_id:first.results[0].observation_id}]}))).rejects.toMatchObject({code:'SELECTION_VIEW_CHANGED'});
});
it('freezes old observations and membership despite later source increments and changed filters',async()=>{
  const id=await fixture();const preview=await previewTargets(scope,selection(id,{purpose:'software_verification'}));await advance();await advance();
  const snapshot=await saveTargetSnapshot(scope,confirmation(preview));expect(snapshot.included_count).toBe(2);expect((await collectionDetail(scope,id)).run.unique_count).toBe(4);
  const exported=await exportCollection(scope,id,{format:'csv',fields:['message'],target_snapshot_id:snapshot.id});const parsed=await parseImportFile(exported.bytes,{format:'csv',encoding:'utf-8'});
  expect(parsed.sheets[0].rows).toHaveLength(3);expect(parsed.sheets[0].rows[1][1]).toEqual({type:'text',value:"'同名合成记录"});expect(exported.bytes.toString('utf8')).toContain(snapshot.definition_hash);
  await collectionDetail(scope,id,'0',25,collectionFilterSchema.parse({id_prefix:'00000'}));expect((await readTargetSnapshot(scope,snapshot.id)).definition_hash).toBe(snapshot.definition_hash);
});
it('deduplicates previews and confirmed snapshots and refuses altered counts or request content',async()=>{
  const id=await source(3);const value=selection(id);const previews=await Promise.all(Array.from({length:4},()=>previewTargets(scope,value)));expect(new Set(previews.map(row=>row.id)).size).toBe(1);
  await expect(previewTargets(scope,{...value,purpose:'marketing'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const input=confirmation(previews[0]);await expect(saveTargetSnapshot(scope,{...input,confirmed_included_count:4})).rejects.toMatchObject({code:'INVALID_CONFIRMATION'});
  const saved=await Promise.all(Array.from({length:4},()=>saveTargetSnapshot(scope,input)));expect(new Set(saved.map(row=>row.id)).size).toBe(1);
  await expect(saveTargetSnapshot(scope,{...input,title:'Different'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(query("UPDATE kff.target_snapshots SET definition='{}' WHERE id=$1",[saved[0].id])).rejects.toThrow('IMMUTABLE_TARGET_SNAPSHOT');
});
it('records source-purpose and action/contact exclusions without creating any executable task',async()=>{
  const id=await source(3);const before=(await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n;const preview=await previewTargets(scope,selection(id,{purpose:'marketing'}));
  expect(preview.definition).toMatchObject({included_count:0,excluded_count:3,execution_authorized:false});for(const row of preview.definition!.targets){expect(row.reason_codes).toEqual(['SOURCE_PURPOSE_NOT_ALLOWED','ACTION_AND_CONTACT_QUALIFICATION_REQUIRED']);expect(row.fields).toEqual({});}
  await saveTargetSnapshot(scope,confirmation(preview));expect((await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n).toBe(before);
});
it('refuses cross-brand references, foreign-query selections and viewer mutations',async()=>{
  const id=await source(3);const preview=await previewTargets(scope,selection(id));const saved=await saveTargetSnapshot(scope,confirmation(preview));const other={...scope,brand_id:randomUUID()};
  await expect(previewTargets(other,selection(id))).rejects.toMatchObject({code:'NOT_FOUND'});await expect(saveTargetSnapshot(other,confirmation(preview))).rejects.toMatchObject({code:'NOT_FOUND'});await expect(readTargetSnapshot(other,saved.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  for(const table of ['target_previews','target_snapshots'])expect(await scoped(other,async client=>(await client.query('SELECT * FROM kff.'+table)).rows)).toEqual([]);
  await expect(previewTargets({...scope,role:'viewer'},selection(id))).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(revokeTargetSnapshot({...scope,role:'viewer'},saved.id,{request_id:randomUUID(),expected_version:1,reason:'Viewer cannot revoke'})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  const otherId=await source(4);const second=await collectionDetail(scope,otherId);await expect(previewTargets(scope,selection(id,{mode:'MANUAL',result_ids:[second.results[0].id],observations:[{result_id:second.results[0].id,observation_id:second.results[0].observation_id}]}))).rejects.toMatchObject({code:'SELECTION_VIEW_CHANGED'});
  await expect(exportCollection(scope,otherId,{format:'csv',fields:['message'],target_snapshot_id:saved.id})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('prioritizes a used request key over a separately existing preview resource',async()=>{
  const id=await source(3);const first=await previewTargets(scope,selection(id));const firstInput=confirmation(first);await saveTargetSnapshot(scope,firstInput);
  const second=await previewTargets(scope,selection(id,{filter:collectionFilterSchema.parse({id_prefix:'00001'})}));const secondInput=confirmation(second);await saveTargetSnapshot(scope,secondInput);
  await expect(saveTargetSnapshot(scope,{...firstInput,request_id:secondInput.request_id})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('limits snapshot exports to frozen fields and rejects explicit IDs mixed into a snapshot request',async()=>{
  const id=await source(3);const preview=await previewTargets(scope,selection(id,{fields:['message']}));const saved=await saveTargetSnapshot(scope,confirmation(preview));
  await expect(exportCollection(scope,id,{format:'csv',fields:['author_id'],target_snapshot_id:saved.id})).rejects.toMatchObject({code:'EXPORT_FIELD_FORBIDDEN'});
  await expect(exportCollection(scope,id,{format:'csv',fields:['message'],target_snapshot_id:saved.id,result_ids:[preview.definition!.targets[0].result_id]})).rejects.toThrow();
  expect((await exportCollection(scope,id,{format:'xlsx',fields:['message'],target_snapshot_id:saved.id})).bytes.length).toBeGreaterThan(0);
});
it('rejects an association between a preview and another query at the database boundary',async()=>{
  const id=await source(3);const preview=await previewTargets(scope,selection(id));const saved=await saveTargetSnapshot(scope,confirmation(preview));const secondId=await source(4);
  const secondPreview=await previewTargets(scope,selection(secondId));
  await expect(query('INSERT INTO kff.target_snapshots(organization_id,brand_id,query_id,preview_id,request_id,request_hash,title,definition,definition_hash,included_count,excluded_count,created_by,expires_at) SELECT organization_id,brand_id,query_id,$1,$2,request_hash,title,definition,definition_hash,included_count,excluded_count,created_by,expires_at FROM kff.target_snapshots WHERE id=$3',[secondPreview.id,randomUUID(),saved.id])).rejects.toMatchObject({code:'23503'});
});
it('coordinates revocation with an existing reader and blocks all later exports',async()=>{
  const id=await source(3);const preview=await previewTargets(scope,selection(id));const saved=await saveTargetSnapshot(scope,confirmation(preview));
  let release!:()=>void;let acquired!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{acquired=resolve;});
  const reading=scoped(scope,async client=>{await lockTargetSnapshot(client,saved.id,id);acquired();await held;});await ready;
  const input={request_id:randomUUID(),expected_version:1,reason:'Synthetic operator withdraws this selection'};let finished=false;const revoking=revokeTargetSnapshot(scope,saved.id,input).then(result=>{finished=true;return result;});
  await query('SELECT pg_sleep(0.05)');expect(finished).toBe(false);release();await reading;expect(await revoking).toMatchObject({state:'REVOKED',version:2});expect(await revokeTargetSnapshot(scope,saved.id,input)).toMatchObject({state:'REVOKED',version:2});
  await expect(exportCollection(scope,id,{format:'csv',fields:['message'],target_snapshot_id:saved.id})).rejects.toMatchObject({code:'TARGET_SNAPSHOT_REVOKED'});await expect(query("UPDATE kff.target_snapshots SET state='ACTIVE',version=3 WHERE id=$1",[saved.id])).rejects.toThrow('IMMUTABLE_TARGET_SNAPSHOT');
});
it('hides expired definitions immediately and purges copied evidence while retaining current snapshots',async()=>{
  const id=await source(3);const preview=await previewTargets(scope,selection(id));const saved=await saveTargetSnapshot(scope,confirmation(preview));const expiredPreview=randomUUID();const expiredSnapshot=randomUUID();
  await query("INSERT INTO kff.target_previews(id,organization_id,brand_id,query_id,request_id,request_hash,definition,definition_hash,created_by,created_at,expires_at) SELECT $1,organization_id,brand_id,query_id,$2,request_hash,definition,definition_hash,created_by,now()-interval '2 days',now()-interval '1 day' FROM kff.target_previews WHERE id=$3",[expiredPreview,randomUUID(),preview.id]);
  await expect(saveTargetSnapshot(scope,{...confirmation(preview),preview_id:expiredPreview})).rejects.toMatchObject({code:'RETENTION_EXPIRED'});
  await query("INSERT INTO kff.target_snapshots(id,organization_id,brand_id,query_id,preview_id,request_id,request_hash,title,definition,definition_hash,included_count,excluded_count,created_by,created_at,expires_at) SELECT $1,organization_id,brand_id,query_id,$2,$3,request_hash,title,definition,definition_hash,included_count,excluded_count,created_by,now()-interval '2 days',now()-interval '1 day' FROM kff.target_snapshots WHERE id=$4",[expiredSnapshot,expiredPreview,randomUUID(),saved.id]);
  expect(await readTargetSnapshot(scope,expiredSnapshot)).toMatchObject({expired:true,definition:null});expect(await saveTargetSnapshot(scope,{...confirmation(preview),preview_id:expiredPreview})).toMatchObject({id:expiredSnapshot,expired:true,definition:null});
  await expect(exportCollection(scope,id,{format:'csv',fields:['message'],target_snapshot_id:expiredSnapshot})).rejects.toMatchObject({code:'RETENTION_EXPIRED'});
  expect(await purgeExpiredTargetSets()).toEqual({previews:1,snapshots:1});expect((await query('SELECT definition FROM kff.target_snapshots WHERE id=$1',[expiredSnapshot]))[0].definition).toBeNull();expect((await readTargetSnapshot(scope,saved.id)).definition?.targets).toHaveLength(3);
  expect(await query("SELECT details->>'kind' AS kind FROM kff.audit_events WHERE event_type='targets.definition_purged' AND object_id=ANY($1::uuid[]) ORDER BY details->>'kind'",[[expiredPreview,expiredSnapshot]])).toEqual([{kind:'previews'},{kind:'snapshots'}]);
  expect(await purgeExpiredTargetSets()).toEqual({previews:0,snapshots:0});
});
