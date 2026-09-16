import {z} from 'zod';
import type {Scope} from '@kff/contracts';
import type {PoolClient} from 'pg';
import {scoped,transaction} from '@kff/database';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite} from './service';
import {leadControl} from '../../contracts/src/acquisition';
import {apifyDatasetKinds,verifyApifyIdentity,readCompletedApifyDataset,type ApifyDatasetKind} from '../../adapters/src/apify-dataset';

interface Source {id:string;organization_id:string;brand_id:string;provider:'APIFY';provider_user_id:string;display_name:string;verified_at:string}
export interface ProviderProspect {id:string;source_id:string;import_id:string;platform:'facebook'|'instagram';kind:'POST'|'COMMENT';remote_id:string;source_url:string;parent_url:string|null;body:string;author_name:string|null;profile_ref:string|null;profile_url:string|null;occurred_at:string|null;search_keywords:string[];score:number;score_reason:string;state:'NEW'|'QUALIFIED'|'DISMISSED'|'OPTED_OUT';version:number;review_note:string|null;expires_at:string;last_seen_at:string}
interface Import {id:string;source_id:string;provider_run_id:string;kind:ApifyDatasetKind;returned_count:number;unique_count:number;usage_usd:string|null;search_keywords:string[];created_at:string}
const input=z.object({source_id:z.string().uuid(),run_id:z.string().regex(/^[A-Za-z0-9]{17}$/),kind:apifyDatasetKinds,retention_days:z.number().int().min(1).max(30).default(14),request_id:z.string().uuid()}).strict();
const text=(v:unknown,max=20000)=>typeof v==='string'?v.slice(0,max):'';
const remoteId=(v:unknown)=>z.string().regex(/^[0-9]{1,128}$/).parse(typeof v==='number'&&Number.isSafeInteger(v)?String(v):v);
function url(v:unknown,platform:'facebook'|'instagram'){
  const u=new URL(z.string().max(1000).parse(v));
  requireCondition(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(platform==='facebook'?['www.facebook.com','facebook.com']:['www.instagram.com','instagram.com']).includes(u.hostname),'COLLECTION_SOURCE_MISMATCH','数据链接与来源平台不符',409);
  u.hostname='www.'+platform+'.com';u.hash='';return u.href;
}
function date(v:unknown){const n=typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(n)?new Date(n).toISOString():null;}
export function providerScore(body:string,parentText:string,keywords:string[]){
  const normalize=(s:string)=>s.normalize('NFKC').toLowerCase();
  const matched=keywords.filter(k=>normalize(parentText).includes(normalize(k))||normalize(body).includes(normalize(k)));
  const explicit=/想了解|想咨询|我要预约|怎[么樣样]收费|多少钱|價格|价格|\b(price|cost|book|appointment|location)\b/i.test(body);
  const weak=/^\s*(pm|dm)\s*[.!！。]?\s*$/i.test(body);
  return {keywords:matched,score:matched.length?(explicit?65:weak?45:30):0,reason:!matched.length?'尚无已核实的主题匹配，等待人工筛选':`主题匹配：${matched.join('、')}；${explicit?'含咨询或预约表达':weak?'仅请求原发布者私信':'仅主题相关'}。待人工筛选，不代表 KFF 获客或联系许可。`};
}
export async function connectApifySource(scope:Scope,fetcher:typeof fetch=fetch){
  requireAdmin(scope);const user=await verifyApifyIdentity(fetcher);
  return scoped(scope,async client=>{
    const result=(await client.query<Source>("INSERT INTO kff.acquisition_sources(organization_id,brand_id,provider,provider_user_id,display_name,verified_at,created_by) VALUES($1,$2,'APIFY',$3,$4,clock_timestamp(),$5) ON CONFLICT(organization_id,brand_id,provider,provider_user_id) DO UPDATE SET verified_at=EXCLUDED.verified_at,display_name=EXCLUDED.display_name RETURNING *",[scope.organization_id,scope.brand_id,user.id,'Apify · '+user.username,scope.user_id])).rows[0];
    await audit(client,scope,'acquisition.source_verified',result.id,{provider:'APIFY',provider_user_id:user.id});return result;
  });
}
export async function importApifyDataset(scope:Scope,raw:unknown,reader:typeof readCompletedApifyDataset=readCompletedApifyDataset){
  requireAdmin(scope);const v=input.parse(raw);
  const before=await scoped(scope,async client=>{
    const source=(await client.query<Source>('SELECT * FROM kff.acquisition_sources WHERE id=$1',[v.source_id])).rows[0];
    requireCondition(source,'FORBIDDEN_SCOPE','数据源不属于当前品牌',403);
    const previous=(await client.query<Import>('SELECT * FROM kff.acquisition_imports WHERE source_id=$1 AND provider_run_id=$2',[v.source_id,v.run_id])).rows[0];
    if(previous)requireCondition(previous.kind===v.kind,'IDEMPOTENCY_CONFLICT','该运行已按另一种来源导入',409);return {source,previous};
  });
  if(before.previous)return {...before.previous,reused:true};
  const dataset=await reader(v.run_id,v.kind);
  requireCondition(dataset.owner_id===before.source.provider_user_id&&dataset.run_id===v.run_id&&dataset.kind===v.kind,'COLLECTION_SOURCE_MISMATCH','运行与品牌数据源不匹配',409);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['apify-import/'+v.source_id]);
    const source=(await client.query<Source>('SELECT * FROM kff.acquisition_sources WHERE id=$1 FOR SHARE',[v.source_id])).rows[0];
    requireCondition(source?.provider_user_id===dataset.owner_id,'COLLECTION_SOURCE_MISMATCH','数据源配置已变化',409);
    const previous=(await client.query<Import>('SELECT * FROM kff.acquisition_imports WHERE source_id=$1 AND provider_run_id=$2',[v.source_id,v.run_id])).rows[0];
    if(previous){requireCondition(previous.kind===v.kind,'IDEMPOTENCY_CONFLICT','该运行已按另一种来源导入',409);return {...previous,reused:true};}
    const platform=dataset.kind==='INSTAGRAM_COMMENTS'?'instagram':'facebook',kind=dataset.kind==='FACEBOOK_POSTS'?'POST':'COMMENT';
    const keywords=kind==='POST'?[z.string().min(1).max(100).parse(dataset.input.query)]:[];
    const inputUrls=kind==='POST'?[]:(platform==='facebook'?z.array(z.object({url:z.string()})).min(1).max(100).parse(dataset.input.startUrls).map(s=>s.url):z.array(z.string()).min(1).max(100).parse(dataset.input.directUrls)).map(s=>url(s,platform));
    const records=new Map<string,Omit<ProviderProspect,'id'|'source_id'|'import_id'|'state'|'version'|'expires_at'|'last_seen_at'|'review_note'>>();
    for(const row of dataset.rows){
      requireCondition(!row.error&&!row.errorDescription,'SOURCE_ITEM_ERROR','采集器返回错误记录，整批未入库',502);
      const remote=remoteId(kind==='POST'?row.postId:platform==='facebook'?row.commentId:row.id);
      const sourceUrl=url(kind==='POST'?row.url:platform==='facebook'?row.commentUrl??row.facebookUrl??row.inputUrl:row.postUrl??row.inputUrl??(inputUrls.length===1?inputUrls[0]:undefined),platform);
      const parent=kind==='POST'?null:url(row.inputUrl??row.facebookUrl??row.postUrl??(inputUrls.length===1?inputUrls[0]:undefined),platform);
      requireCondition(!parent||inputUrls.includes(parent),'COLLECTION_SOURCE_MISMATCH','评论不在本次运行的输入范围内',409);
      const author=row.author&&typeof row.author==='object'?row.author as Record<string,unknown>:{};
      const body=text(kind==='POST'?row.postText:row.text);
      const context=parent?(await client.query<ProviderProspect>("SELECT * FROM kff.acquisition_prospects WHERE source_id=$1 AND platform=$2 AND kind='POST' AND source_url=$3 AND expires_at>clock_timestamp() LIMIT 1",[v.source_id,platform,parent])).rows[0]:undefined;
      const scored=kind==='POST'?{keywords,score:0,reason:'关键词搜索返回的公开帖子；尚未视为潜在客户。'}:providerScore(body,context?.body??'',context?.search_keywords??[]);
      const profile=row.profileUrl??author.url;
      records.set(remote,{platform,kind,remote_id:remote,source_url:sourceUrl,parent_url:parent,body,author_name:text(kind==='POST'?author.name:row.profileName??row.ownerUsername,200)||null,profile_ref:text(kind==='POST'?String(author.id??''):row.profileId??row.ownerId,200)||null,profile_url:typeof profile==='string'?url(profile,platform):null,occurred_at:date(kind==='POST'?row.timestamp:platform==='facebook'?row.date:row.timestamp),search_keywords:scored.keywords,score:scored.score,score_reason:scored.reason});
    }
    const imported=(await client.query<Import>('INSERT INTO kff.acquisition_imports(organization_id,brand_id,source_id,provider_run_id,actor_id,dataset_id,kind,search_keywords,source_urls,returned_count,unique_count,content_hash,usage_usd,finished_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[scope.organization_id,scope.brand_id,v.source_id,v.run_id,dataset.actor_id,dataset.dataset_id,v.kind,JSON.stringify(keywords),JSON.stringify(inputUrls),dataset.rows.length,records.size,digest([...records.values()]),dataset.usage_usd,dataset.finished_at,scope.user_id])).rows[0];
    for(const r of records.values())await client.query("INSERT INTO kff.acquisition_prospects(organization_id,brand_id,source_id,import_id,platform,kind,remote_id,source_url,parent_url,body,author_name,profile_ref,profile_url,occurred_at,search_keywords,score,score_reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp()+make_interval(days=>$18)) ON CONFLICT(source_id,platform,kind,remote_id) DO UPDATE SET import_id=EXCLUDED.import_id,source_url=EXCLUDED.source_url,parent_url=EXCLUDED.parent_url,body=EXCLUDED.body,author_name=EXCLUDED.author_name,profile_ref=EXCLUDED.profile_ref,profile_url=EXCLUDED.profile_url,occurred_at=EXCLUDED.occurred_at,search_keywords=EXCLUDED.search_keywords,score=EXCLUDED.score,score_reason=EXCLUDED.score_reason,last_seen_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,version=kff.acquisition_prospects.version+1 WHERE (SELECT finished_at FROM kff.acquisition_imports WHERE id=kff.acquisition_prospects.import_id)<=$19::timestamptz",[scope.organization_id,scope.brand_id,v.source_id,imported.id,r.platform,r.kind,r.remote_id,r.source_url,r.parent_url,r.body,r.author_name,r.profile_ref,r.profile_url,r.occurred_at,JSON.stringify(r.search_keywords),r.score,r.score_reason,v.retention_days,dataset.finished_at]);
    await audit(client,scope,'acquisition.provider_imported',imported.id,{source_id:v.source_id,run_id:v.run_id,returned_count:dataset.rows.length,unique_count:records.size,request_id:v.request_id});return {...imported,reused:false};
  });
}
export async function providerWorkspace(client:PoolClient){return {
  sources:(await client.query<Source>('SELECT * FROM kff.acquisition_sources ORDER BY created_at')).rows,
  imports:(await client.query<Import>('SELECT * FROM kff.acquisition_imports ORDER BY created_at DESC LIMIT 100')).rows,
  prospects:(await client.query<ProviderProspect>('SELECT * FROM kff.acquisition_prospects WHERE expires_at>clock_timestamp() ORDER BY score DESC,last_seen_at DESC,id LIMIT 500')).rows,
  totals:(await client.query<{posts:number;comments:number;profiles:number;qualified:number}>("SELECT count(*) FILTER(WHERE kind='POST')::int AS posts,count(*) FILTER(WHERE kind='COMMENT')::int AS comments,count(DISTINCT (source_id,platform,profile_ref)) FILTER(WHERE kind='COMMENT' AND profile_ref IS NOT NULL)::int AS profiles,count(*) FILTER(WHERE kind='COMMENT' AND state='QUALIFIED')::int AS qualified FROM kff.acquisition_prospects WHERE expires_at>clock_timestamp()")).rows[0]
};}
export async function controlProviderProspect(scope:Scope,id:string,raw:unknown){
  requireWrite(scope);z.string().uuid().parse(id);const v=leadControl.parse(raw),hash=digest({id,...v});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['provider-review/'+scope.brand_id+'/'+v.request_id]);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='acquisition.provider_reviewed' AND details->>'request_id'=$1",[v.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求已用于其他处理',409);return old.details.result;}
    const result=(await client.query<ProviderProspect>("UPDATE kff.acquisition_prospects SET state=$2,review_note=$3,version=version+1 WHERE id=$1 AND version=$4 AND kind='COMMENT' AND expires_at>clock_timestamp() RETURNING *",[id,v.state,v.reason,v.expected_version])).rows[0];
    requireCondition(result,'VERSION_CONFLICT','记录已变化或不属于当前品牌',409);
    await audit(client,scope,'acquisition.provider_reviewed',id,{request_id:v.request_id,request_hash:hash,result:{id:result.id,state:result.state,version:result.version}});return {id:result.id,state:result.state,version:result.version};
  });
}
export async function purgeExpiredProviderData(){return transaction(async client=>(await client.query('DELETE FROM kff.acquisition_prospects WHERE expires_at<=clock_timestamp()')).rowCount);}
