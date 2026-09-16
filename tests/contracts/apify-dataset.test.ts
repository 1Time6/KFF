import {afterEach,it,expect,vi} from 'vitest';
import {readCompletedApifyDataset} from '../../packages/adapters/src/apify-dataset';
const runId='r'.repeat(17),owner='u'.repeat(17),store='s'.repeat(17),dataset='d'.repeat(17);
afterEach(()=>vi.unstubAllEnvs());
function mock(options:{owner?:string;status?:string;total?:number;actor?:string}={}){
  vi.stubEnv('APIFY_API_TOKEN','test-secret-not-real-123');vi.stubEnv('APIFY_USER_ID',owner);
  return vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const u=String(input);expect(u).not.toContain('test-secret-not-real-123');expect(init?.method).toBeUndefined();expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret-not-real-123');
    const data=u.includes('/actor-runs/')?{data:{id:runId,actId:options.actor??'TMBawM4LZpKN15DZX',userId:options.owner??owner,status:options.status??'SUCCEEDED',defaultDatasetId:dataset,defaultKeyValueStoreId:store,finishedAt:new Date().toISOString()}}:u.includes('/records/INPUT')?{query:'八字测算'}:[{postId:'123',postText:'sample'}];
    return new Response(JSON.stringify(data),{headers:{'x-apify-pagination-total':String(options.total??1)}});
  });
}
it('only reads completed allowlisted actor datasets using the configured account',async()=>{const fetcher=mock();const data=await readCompletedApifyDataset(runId,'FACEBOOK_POSTS',fetcher as typeof fetch);expect(data.rows).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(3);});
it.each([{owner:'x'.repeat(17)},{actor:'a'.repeat(17)}])('blocks mismatched run identity before reading data',async options=>{const fetcher=mock(options);await expect(readCompletedApifyDataset(runId,'FACEBOOK_POSTS',fetcher as typeof fetch)).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});expect(fetcher).toHaveBeenCalledTimes(1);});
it('does not import partial or oversized datasets',async()=>{await expect(readCompletedApifyDataset(runId,'FACEBOOK_POSTS',mock({status:'RUNNING'}) as typeof fetch)).rejects.toMatchObject({code:'SOURCE_RUN_NOT_READY'});await expect(readCompletedApifyDataset(runId,'FACEBOOK_POSTS',mock({total:1001}) as typeof fetch)).rejects.toMatchObject({code:'COLLECTION_LIMIT_EXCEEDED'});});
it('retries a failed read once and reports persistent network errors without starting a crawl',async()=>{
  const working=mock();let count=0;
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{if(++count===1)throw new TypeError('network');return working(input,init);});
  expect((await readCompletedApifyDataset(runId,'FACEBOOK_POSTS',fetcher as typeof fetch)).rows).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(4);
  const unavailable=vi.fn(async()=>{throw new TypeError('network');});await expect(readCompletedApifyDataset(runId,'FACEBOOK_POSTS',unavailable as typeof fetch)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});expect(unavailable).toHaveBeenCalledTimes(2);
});
