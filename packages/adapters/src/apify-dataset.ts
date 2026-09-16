import {z} from 'zod';
import {AppError,requireCondition} from '@kff/core';
import {apifyConnection} from './apify-connection';
import {readBoundedJson} from './source-http';

export const apifyDatasetKinds=z.enum(['FACEBOOK_POSTS','FACEBOOK_COMMENTS','INSTAGRAM_COMMENTS']);
export type ApifyDatasetKind=z.infer<typeof apifyDatasetKinds>;
const actors={FACEBOOK_POSTS:'TMBawM4LZpKN15DZX',FACEBOOK_COMMENTS:'us5srxAYnsrkgUv2v',INSTAGRAM_COMMENTS:'SbK00X0JYCPblD2wp'};
const id=z.string().regex(/^[A-Za-z0-9]{17}$/);
async function response(resource:string,fetcher:typeof fetch){
  const connection=apifyConnection();requireCondition(connection,'SOURCE_NOT_CONFIGURED','Apify 凭据未配置',503);
  for(let attempt=0;attempt<2;attempt++)try{return await fetcher('https://api.apify.com/v2/'+resource,{headers:{Authorization:'Bearer '+connection.token},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{if(attempt===1)throw new AppError('SOURCE_UNAVAILABLE','Apify 网络暂时不可达，请重试同一批次；不会重新启动抓取',503);}
  throw new AppError('SOURCE_UNAVAILABLE','Apify 暂时不可达',503);
}
export async function verifyApifyIdentity(fetcher:typeof fetch=fetch){
  const raw=await readBoundedJson(await response('users/me',fetcher));
  const user=z.object({data:z.object({id,username:z.string().min(1).max(100)})}).parse(raw).data;
  requireCondition(user.id===apifyConnection()?.user_id,'COLLECTION_SOURCE_MISMATCH','Apify 账号与已保存连接不一致',409);return user;
}
export interface ApifyDataset {run_id:string;actor_id:string;owner_id:string;dataset_id:string;kind:ApifyDatasetKind;finished_at:string;usage_usd:number|null;input:Record<string,unknown>;rows:Record<string,unknown>[]}
// Explicit imports read an already completed dataset; they never launch or retry a paid crawl.
export async function readCompletedApifyDataset(runId:string,kind:ApifyDatasetKind,fetcher:typeof fetch=fetch):Promise<ApifyDataset>{
  id.parse(runId);apifyDatasetKinds.parse(kind);
  const raw=await readBoundedJson(await response('actor-runs/'+runId,fetcher));
  const run=z.object({data:z.object({id,actId:id,userId:id,status:z.string(),defaultDatasetId:id,defaultKeyValueStoreId:id,finishedAt:z.string().datetime().nullable(),usageTotalUsd:z.number().nonnegative().optional()})}).parse(raw).data;
  requireCondition(run.id===runId&&run.userId===apifyConnection()?.user_id&&run.actId===actors[kind],'COLLECTION_SOURCE_MISMATCH','运行账号或采集器不匹配',409);
  requireCondition(run.status==='SUCCEEDED'&&run.finishedAt,'SOURCE_RUN_NOT_READY','请导入已成功结束的 Apify 运行',409);
  const input=z.record(z.string(),z.unknown()).parse(await readBoundedJson(await response('key-value-stores/'+run.defaultKeyValueStoreId+'/records/INPUT',fetcher)));
  const rows:Record<string,unknown>[]=[];let total:number|undefined;
  do{
    const res=await response('datasets/'+run.defaultDatasetId+'/items?format=json&clean=false&offset='+rows.length+'&limit=100',fetcher);
    const header=res.headers.get('x-apify-pagination-total');
    requireCondition(header!==null&&/^[0-9]{1,9}$/.test(header),'COLLECTION_INVALID_PAGE','缺少分页总数',502);
    const current=Number(header);requireCondition(current<=1000&&(total===undefined||total===current),'COLLECTION_LIMIT_EXCEEDED','单次导入最多 1000 条，且运行结果须保持稳定',409);total=current;
    const page=z.array(z.record(z.string(),z.unknown())).max(100).parse(await readBoundedJson(res));
    requireCondition(rows.length+page.length<=total&&(page.length>0||rows.length===total),'COLLECTION_INVALID_PAGE','分页数量不一致',502);rows.push(...page);
  }while(rows.length<total);
  return {run_id:run.id,actor_id:run.actId,owner_id:run.userId,dataset_id:run.defaultDatasetId,kind,finished_at:run.finishedAt,usage_usd:run.usageTotalUsd??null,input,rows};
}
