import {z} from 'zod';
import {collectionPageSchema,type CollectionRecord,type CollectionPage} from '@kff/contracts';
import {requireCondition,validateTargetUrl} from '@kff/core';
import type {CollectionRead,CollectionAdapter} from './collection-fixture';
import {readBoundedJson} from './source-http';
import {readApifyComments} from './apify';
export {readBoundedJson} from './source-http';

// No arbitrary URLs or platform credentials supplied by a browser are fetched.
export function localDiscoveryPage(request:CollectionRead):CollectionPage {
  const d=request.snapshot.discovery!;
  requireCondition(d.provider==='LOCAL_FIXTURE','FORBIDDEN_SCOPE','仅限合成采集');
  requireCondition(request.cursor===null||/^offset:[0-9]{1,4}$/.test(request.cursor),'CURSOR_EXPIRED','游标无效');
  const offset=request.cursor?Number(request.cursor.slice(7)):0;
  const keyword=d.keywords[0], rows=[`${keyword}: I would like more information`,`${keyword}: how much does it cost?`,'unrelated sample',`${keyword}: please help me`].map((message,i)=>({
    source_object_id:request.snapshot.external_account_id+'_'+(i+1),source_url:'http://127.0.0.1:4311/collection-object/'+request.snapshot.external_account_id+'_'+(i+1),
    fields:Object.fromEntries(request.snapshot.fields.map(field=>[field,{kind:'VALUE' as const,value:field==='message'?message:field==='author_id'?String(900100+i):field==='created_time'?new Date().toISOString():0}]))
  }));
  return {schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:request.query_id,account_external_id:request.snapshot.external_account_id,cursor:request.cursor,next_cursor:offset+request.limit<rows.length?'offset:'+(offset+request.limit):null,observed_at:new Date().toISOString(),reported_total:null,coverage:'SYNTHETIC_SAMPLE',rows:rows.slice(offset,offset+request.limit)};
}
export function discoveryAdapter(options:{fetch?:typeof fetch}={}):CollectionAdapter {
  const fetcher=options.fetch??fetch;
  return {async readPage(request){
    const d=request.snapshot.discovery;requireCondition(d,'SOURCE_NOT_CONFIGURED','缺少采集配置');
    if(d.provider==='LOCAL_FIXTURE')return localDiscoveryPage(request);
    requireCondition(d.provider !== 'LOCAL_BROWSER', 'SOURCE_UNSUPPORTED', '浏览器采集必须通过 Local Agent 任务执行', 409);
    requireCondition(process.env.KFF_ENABLE_DISCOVERY==='true','DISCOVERY_DISABLED','真实采集未启用',409);
    if(d.provider==='DATA_PROVIDER'){
      if(d.target.startsWith('apify-run:'))return readApifyComments(request,fetcher);
      const endpoint=process.env.KFF_DISCOVERY_PROVIDER_URL,key=process.env.KFF_DISCOVERY_PROVIDER_KEY;
      requireCondition(endpoint&&key,'SOURCE_NOT_CONFIGURED','尚未配置全域搜索/采集服务',503);
      const url=validateTargetUrl(endpoint,[new URL(endpoint).hostname]);requireCondition(url.protocol==='https:'&&!url.search&&!url.hash,'INVALID_INPUT','采集服务须使用固定 HTTPS 地址');
      const body={protocol:'kff.discovery-provider.v1',platform:d.platform,strategy:d.strategy,keywords:d.keywords,target:d.target,cursor:request.cursor,limit:request.limit,fields:request.snapshot.fields};
      const data=await readBoundedJson(await fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)}));
      const page=z.object({rows:collectionPageSchema.shape.rows,next_cursor:collectionPageSchema.shape.next_cursor}).strict().parse(data);
      return {...page,schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:request.query_id,account_external_id:request.snapshot.external_account_id,cursor:request.cursor,observed_at:new Date().toISOString(),reported_total:null,coverage:'PROVIDER_RESULTS_ONLY'};
    }
    requireCondition(d.strategy==='COMMENTS'&&/^[0-9_]{1,160}$/.test(d.target),'SOURCE_UNSUPPORTED','Meta 直连当前支持指定自有帖子/媒体评论；全域关键词、话题和竞品采集需要数据源',409);
    const token=d.credential_ref?process.env[d.credential_ref]:undefined;
    requireCondition(token&&d.graph_version,'SOURCE_AUTH_REQUIRED','尚未配置采集令牌与 Graph 版本',503);
    const base=d.platform==='facebook'?'https://graph.facebook.com/':'https://graph.instagram.com/';
    const graph=async(path:string,params:Record<string,string>)=>{
      const url=new URL(d.graph_version+'/'+path,base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
      return readBoundedJson(await fetcher(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)}));
    };
    const identity=z.object({id:z.string()}).parse(await graph('me',{fields:'id'}));
    requireCondition(identity.id===request.snapshot.external_account_id,'ACCOUNT_MISMATCH','采集令牌与账号不一致');
    const parent=z.object({id:z.string(),permalink:z.string().optional(),permalink_url:z.string().optional(),from:z.object({id:z.string()}).optional(),owner:z.object({id:z.string()}).optional()}).parse(await graph(d.target,{fields:d.platform==='facebook'?'id,from,permalink_url':'id,owner,permalink'}));
    requireCondition(parent.id===d.target&&(parent.from?.id??parent.owner?.id)===identity.id,'SOURCE_NOT_OWNED','当前 Meta 连接仅采集本账号内容的评论',409);
    const raw=z.object({data:z.array(z.object({id:z.string(),message:z.string().optional(),text:z.string().optional(),from:z.object({id:z.string().optional()}).optional(),created_time:z.string().optional(),timestamp:z.string().optional(),like_count:z.number().optional(),comment_count:z.number().optional()}).passthrough()).max(100),paging:z.object({cursors:z.object({after:z.string().max(2048).optional()}).optional(),next:z.string().optional()}).optional()}).parse(await graph(d.target+'/comments',{fields:d.platform==='facebook'?'id,message,from,created_time,like_count,comment_count':'id,text,from,timestamp',limit:String(request.limit),...(request.cursor?{after:request.cursor}:{})}));
    const rows:CollectionRecord[]=raw.data.map(row=>{
      const values:Record<string,unknown>={message:row.message??row.text,author_id:row.from?.id,created_time:row.created_time??row.timestamp,reaction_count:row.like_count,comment_count:row.comment_count};
      if(typeof values.created_time==='string')values.created_time=new Date(values.created_time).toISOString();
      return {source_object_id:row.id,source_url:parent.permalink??parent.permalink_url??('https://www.facebook.com/'+parent.id),fields:Object.fromEntries(request.snapshot.fields.map(field=>[field,values[field]===undefined?{kind:'NOT_RETURNED'}:{kind:'VALUE',value:values[field]}])) as CollectionRecord['fields']};
    });
    requireCondition(!raw.paging?.next||raw.paging.cursors?.after,'COLLECTION_INVALID_PAGE','来源声明有下一页但未提供游标');
    return {schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:request.query_id,account_external_id:identity.id,cursor:request.cursor,next_cursor:raw.paging?.next?raw.paging.cursors!.after!:null,observed_at:new Date().toISOString(),reported_total:null,coverage:'API_VISIBLE_ONLY',rows};
  }};
}
