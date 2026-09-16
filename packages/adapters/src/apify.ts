import {z} from 'zod';
import {type CollectionPage,type CollectionRecord} from '@kff/contracts';
import {requireCondition} from '@kff/core';
import {apifyConnection} from './apify-connection';
import {readBoundedJson} from './source-http';
import type {CollectionRead} from './collection-fixture';

export const apifyCommentActors={facebook:'apify~facebook-comments-scraper',instagram:'apify~instagram-comment-scraper'} as const;
const id=z.string().regex(/^[A-Za-z0-9]{17}$/);
const string=(value:unknown)=>typeof value==='string'?value:undefined;
const numericId=(value:unknown)=>typeof value==='string'&&/^[0-9]{1,128}$/.test(value)?value:undefined;
function count(value:unknown){const n=typeof value==='number'?value:typeof value==='string'&&/^[0-9]+$/.test(value)?Number(value):NaN;return Number.isSafeInteger(n)&&n>=0?n:undefined;}
function date(value:unknown){const time=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?new Date(time).toISOString():undefined;}
function platformUrl(value:unknown,platform:'facebook'|'instagram'){
  requireCondition(typeof value==='string','COLLECTION_INVALID_PAGE','Apify 未返回可核实的来源链接',502);
  const url=new URL(value),hosts=platform==='facebook'?['facebook.com','www.facebook.com']:['instagram.com','www.instagram.com'];
  requireCondition(url.protocol==='https:'&&hosts.includes(url.hostname)&&!url.port&&!url.username&&!url.password,'COLLECTION_SOURCE_MISMATCH','Apify 来源链接不属于指定平台',502);
  return url.toString();
}
export function normalizeApifyComment(value:unknown,request:CollectionRead,fallbackUrl?:string):CollectionRecord{
  const row=z.record(z.string(),z.unknown()).parse(value),platform=request.snapshot.discovery!.platform;
  requireCondition(!row.error&&!row.errorDescription,'SOURCE_ITEM_ERROR','Apify 返回采集错误记录',502);
  const commentId=platform==='facebook'?numericId(row.commentId):numericId(row.id);
  requireCondition(commentId,'COLLECTION_INVALID_PAGE','Apify 未返回稳定的评论 ID',502);
  const source=platformUrl(platform==='facebook'?row.commentUrl??row.facebookUrl??row.inputUrl??fallbackUrl:row.postUrl??row.inputUrl??fallbackUrl,platform);
  const author=platform==='facebook'?numericId(row.profileId):numericId(row.ownerId);
  const values:Record<string,unknown>={message:string(row.text),author_id:author,created_time:date(platform==='facebook'?row.date:row.timestamp),reaction_count:count(row.likesCount),comment_count:count(row.repliesCount)};
  return {source_object_id:commentId,source_url:source,fields:Object.fromEntries(request.snapshot.fields.map(field=>[field,values[field]===undefined?{kind:'NOT_RETURNED'}:{kind:'VALUE',value:values[field]}])) as CollectionRecord['fields']};
}

// Read an explicitly selected, completed run. This path never starts or bills a crawl.
export async function readApifyComments(request:CollectionRead,fetcher:typeof fetch=fetch):Promise<CollectionPage>{
  const d=request.snapshot.discovery!;
  requireCondition(process.env.KFF_ENABLE_DISCOVERY==='true','DISCOVERY_DISABLED','真实采集未启用',409);
  requireCondition(d.provider==='DATA_PROVIDER'&&d.strategy==='COMMENTS'&&/^apify-run:[A-Za-z0-9]{17}$/.test(d.target),'SOURCE_UNSUPPORTED','Apify 首阶段支持已完成的 Facebook / Instagram 评论采集 Run ID',409);
  const connection=apifyConnection();requireCondition(connection,'SOURCE_NOT_CONFIGURED','Apify 连接尚未配置',503);
  const runId=d.target.slice(10);
  requireCondition(request.cursor===null||new RegExp('^apify:'+runId+':[0-9]{1,9}$').test(request.cursor),'CURSOR_EXPIRED','Apify 游标与采集任务不匹配',409);
  const offset=request.cursor?Number(request.cursor.split(':')[2]):0;
  const get=async(resource:string)=>readBoundedJson(await fetcher('https://api.apify.com/v2/'+resource,{headers:{Authorization:'Bearer '+connection.token},redirect:'error',signal:AbortSignal.timeout(5000)}));
  const [rawRun,rawActor]=await Promise.all([get('actor-runs/'+runId),get('actors/'+apifyCommentActors[d.platform])]);
  const run=z.object({data:z.object({id,actId:id,userId:id,status:z.string(),defaultDatasetId:id,defaultKeyValueStoreId:id})}).parse(rawRun).data;
  const actor=z.object({data:z.object({id})}).parse(rawActor).data;
  requireCondition(run.id===runId&&run.userId===connection.user_id&&run.actId===actor.id,'COLLECTION_SOURCE_MISMATCH','Apify 运行所属账号或采集器不匹配',409);
  requireCondition(run.status==='SUCCEEDED','SOURCE_RUN_NOT_READY','Apify 运行尚未成功结束；请先核对原运行',409);
  const input=z.record(z.string(),z.unknown()).parse(await get('key-value-stores/'+run.defaultKeyValueStoreId+'/records/INPUT'));
  const urls=d.platform==='facebook'?z.array(z.object({url:z.string()})).parse(input.startUrls).map(v=>v.url):z.array(z.string()).parse(input.directUrls);
  requireCondition(urls.length>0&&urls.length<=100,'COLLECTION_INVALID_PAGE','Apify 输入来源范围无效',502);
  const sources=urls.map(url=>platformUrl(url,d.platform));
  const response=await fetcher('https://api.apify.com/v2/datasets/'+run.defaultDatasetId+'/items?format=json&clean=false&offset='+offset+'&limit='+request.limit,{headers:{Authorization:'Bearer '+connection.token},redirect:'error',signal:AbortSignal.timeout(5000)});
  const rows=z.array(z.unknown()).max(request.limit).parse(await readBoundedJson(response));
  const totalHeader=response.headers.get('x-apify-pagination-total');
  requireCondition(totalHeader!==null&&/^[0-9]{1,9}$/.test(totalHeader),'COLLECTION_INVALID_PAGE','Apify 未返回可核实的分页总数',502);
  const total=Number(totalHeader),next=offset+rows.length;
  requireCondition(next<=total&&(rows.length>0||offset>=total),'COLLECTION_INVALID_PAGE','Apify 分页数据与总数不一致',502);
  return {schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:request.query_id,account_external_id:request.snapshot.external_account_id,cursor:request.cursor,next_cursor:next<total?'apify:'+runId+':'+next:null,observed_at:new Date().toISOString(),reported_total:total,coverage:'PROVIDER_RESULTS_ONLY',rows:rows.map(row=>normalizeApifyComment(row,request,sources.length===1?sources[0]:undefined))};
}
