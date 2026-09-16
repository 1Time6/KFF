import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {collectionSnapshotSchema} from '@kff/contracts';
import {discoveryAdapter} from '../../packages/adapters/src/discovery';
import {normalizeApifyComment} from '../../packages/adapters/src/apify';
import {normalizeCollectionPage,type CollectionRead} from '../../packages/adapters/src/collection-fixture';

const runId='r'.repeat(17),actorId='a'.repeat(17),userId='u'.repeat(17),datasetId='d'.repeat(17),storeId='s'.repeat(17);
afterEach(()=>vi.unstubAllEnvs());
function request(platform:'facebook'|'instagram'='facebook'):CollectionRead{
  vi.stubEnv('KFF_ENABLE_DISCOVERY','true');vi.stubEnv('APIFY_API_TOKEN','apify_api_'+'x'.repeat(30));vi.stubEnv('APIFY_USER_ID',userId);
  return {query_id:randomUUID(),cursor:null,limit:2,snapshot:collectionSnapshotSchema.parse({schema_version:'kff.collection.v1',source_key:'social.discovery',source_version:'social-discovery-v1',source_type:'SOCIAL_DISCOVERY',title:'Apify test',account_id:randomUUID(),targets:['123'],fields:['author_id','comment_count','created_time','message','reaction_count'],mode:'CONTROLLED_PILOT',purpose:'lead_discovery',incremental_rule:'append_observations',max_records:20,max_pages:10,page_size:2,display_timezone:'UTC',retention_days:7,scenario:'normal',account_version:1,external_account_id:'123',allowed_purposes:['lead_discovery'],discovery:{platform,provider:'DATA_PROVIDER',strategy:'COMMENTS',keywords:['help'],target:'apify-run:'+runId,processing_basis:'Public comments for integration verification'}})};
}
function api(platform:'facebook'|'instagram',options:{status?:string;owner?:string;total?:string;errorRow?:boolean}={}){
  return vi.fn(async(url:unknown,init?:RequestInit)=>{
    expect(init?.method??'GET').toBe('GET');expect(init?.redirect).toBe('error');
    const u=new URL(String(url));expect(u.origin).toBe('https://api.apify.com');expect(u.searchParams.has('token')).toBe(false);
    if(u.pathname.includes('/actor-runs/'))return Response.json({data:{id:runId,actId:actorId,userId:options.owner??userId,status:options.status??'SUCCEEDED',defaultDatasetId:datasetId,defaultKeyValueStoreId:storeId}});
    if(u.pathname.includes('/actors/'))return Response.json({data:{id:actorId}});
    const source=platform==='facebook'?'https://www.facebook.com/123/posts/456':'https://www.instagram.com/p/test/';
    if(u.pathname.includes('/records/INPUT'))return Response.json(platform==='facebook'?{startUrls:[{url:source}]}:{directUrls:[source]});
    const row=platform==='facebook'?{commentId:'789',text:'help',profileId:'pfbidOpaque',date:'2026-09-12T00:00:00Z',likesCount:'0'}:{id:'789',text:'help',ownerId:'000123',timestamp:'2026-09-12T00:00:00Z',likesCount:0};
    return Response.json(options.errorRow?[{error:'unavailable'}]:[row],{headers:{'x-apify-pagination-total':options.total??'2'}});
  });
}
it.each(['facebook','instagram'] as const)('normalizes %s comments from a pinned completed run without starting an Actor',async platform=>{
  const r=request(platform),fetcher=api(platform);const page=normalizeCollectionPage(await discoveryAdapter({fetch:fetcher as typeof fetch}).readPage(r),r);
  expect(page.rows).toHaveLength(1);expect(page.coverage).toBe('PROVIDER_RESULTS_ONLY');expect(page.reported_total).toBe(2);expect(page.next_cursor).toBe('apify:'+runId+':1');
  expect(page.rows[0].fields.author_id).toEqual(platform==='facebook'?{kind:'NOT_RETURNED'}:{kind:'VALUE',value:'000123'});
  expect(page.rows[0].fields.reaction_count).toEqual({kind:'VALUE',value:0});expect(page.rows[0].fields.comment_count).toEqual({kind:'NOT_RETURNED'});
});
it.each(['RUNNING','FAILED','ABORTED'])('does not ingest a %s run or restart it',async status=>{
  const r=request(),fetcher=api('facebook',{status});await expect(discoveryAdapter({fetch:fetcher as typeof fetch}).readPage(r)).rejects.toMatchObject({code:'SOURCE_RUN_NOT_READY'});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects a different Apify owner before reading the dataset',async()=>{
  const r=request();await expect(discoveryAdapter({fetch:api('facebook',{owner:'v'.repeat(17)}) as typeof fetch}).readPage(r)).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
});
it('rejects cursors belonging to another run before any provider I/O',async()=>{
  const r=request();r.cursor='apify:'+'z'.repeat(17)+':0';const fetcher=vi.fn();await expect(discoveryAdapter({fetch:fetcher}).readPage(r)).rejects.toMatchObject({code:'CURSOR_EXPIRED'});expect(fetcher).not.toHaveBeenCalled();
});
it('does not turn provider errors into successful empty results',async()=>{
  const r=request();await expect(discoveryAdapter({fetch:api('facebook',{errorRow:true}) as typeof fetch}).readPage(r)).rejects.toMatchObject({code:'SOURCE_ITEM_ERROR'});
});
it('requires explicit paging metadata',async()=>{
  const r=request();await expect(discoveryAdapter({fetch:api('facebook',{total:'unknown'}) as typeof fetch}).readPage(r)).rejects.toMatchObject({code:'COLLECTION_INVALID_PAGE'});
});
it('rejects hostile source links and preserves missing identities instead of inventing them',()=>{
  const r=request();expect(()=>normalizeApifyComment({commentId:'1',commentUrl:'https://evil.example/'},r)).toThrow();
  expect(()=>normalizeApifyComment({id:'base64',text:'help'},r,'https://www.facebook.com/123/posts/456')).toThrow();
});
it('fails closed when real collection is disabled or credentials are missing',async()=>{
  const r=request(),fetcher=vi.fn();vi.stubEnv('KFF_ENABLE_DISCOVERY','false');await expect(discoveryAdapter({fetch:fetcher}).readPage(r)).rejects.toMatchObject({code:'DISCOVERY_DISABLED'});
  vi.stubEnv('KFF_ENABLE_DISCOVERY','true');vi.stubEnv('APIFY_API_TOKEN','');vi.stubEnv('APIFY_USER_ID','');vi.stubEnv('KFF_AUTH_MODE','supabase');
  await expect(discoveryAdapter({fetch:fetcher}).readPage(r)).rejects.toMatchObject({code:'SOURCE_NOT_CONFIGURED'});expect(fetcher).not.toHaveBeenCalled();
});
