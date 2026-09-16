import {z} from 'zod';
import {scoped} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {facebookPublicPostUrl,browserCommentOrder} from '../../contracts/src/acquisition';
import {createMonitor} from './acquisition';
import {digest,requireCondition} from './index';
import {audit,requireAdmin} from './service';
import type {ProviderProspect} from './acquisition-provider';

const input=z.object({request_id:z.string().uuid(),expected_version:z.number().int().positive(),account_id:z.string().uuid(),environment_id:z.string().uuid(),comment_order:browserCommentOrder}).strict();
export async function prepareProviderBrowserVerification(scope:Scope,id:string,raw:unknown){
 requireAdmin(scope);z.string().uuid().parse(id);const v=input.parse(raw),hash=digest({id,...v});
 const before=await scoped(scope,async client=>{
  const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='acquisition.provider_verification_prepared' AND details->>'verification_request_id'=$1",[v.request_id])).rows[0];
  if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','此核对请求已有不同内容',409);return {old:old.details.result,prospect:null};}
  const p=(await client.query<ProviderProspect>('SELECT * FROM kff.acquisition_prospects WHERE id=$1 AND expires_at>clock_timestamp()',[id])).rows[0];
  requireCondition(p&&p.version===v.expected_version,'VERSION_CONFLICT','外部来源已变化或到期，请重新审核',409);
  requireCondition(p.platform==='facebook'&&p.kind==='COMMENT'&&p.state==='QUALIFIED'&&p.body.trim(),'SOURCE_NOT_QUALIFIED','先人工核对这条 Facebook 评论为值得跟进',409);
  const binding=(await client.query("SELECT a.id FROM kff.accounts a JOIN kff.environments e ON e.account_id=a.id WHERE a.id=$1 AND e.id=$2 AND a.platform='facebook' AND a.account_type='profile' AND NOT a.is_synthetic AND e.browser_configuration->>'driver'='adspower'",[v.account_id,v.environment_id])).rows[0];
  requireCondition(binding,'FORBIDDEN_SCOPE','请选择当前品牌已配置的真实账号及其 AdsPower 环境',403);
  return {old:null,prospect:p};
 });
 if(before.old)return before.old;
 const p=before.prospect!;let source:string|undefined;
 try{const u=new URL(p.parent_url??'');u.hash='';u.search='';u.pathname=u.pathname.replace(/\/?$/,'/');source=facebookPublicPostUrl.parse(u.href);}catch{requireCondition(false,'SOURCE_UNSUPPORTED','原来源不是当前支持的固定帖子或 Reel，保留原记录待核对',409);}
 const monitor=await createMonitor(scope,{request_id:v.request_id,title:'核对 Apify 评论 '+p.remote_id.slice(0,80),account_id:v.account_id,discovery:{platform:'facebook',provider:'LOCAL_BROWSER',strategy:'COMMENTS',browser:{environment_id:v.environment_id,template:'facebook-comments-dom-v1',comment_order:v.comment_order},target:source!,keywords:[p.body.trim().slice(0,100)],exclusions:[],processing_basis:'对已人工筛选的 Apify 评论重新进行只读核对；以浏览器取得的原文、作者和来源为准。此步骤不授予互动或私信许可。'},interval_minutes:60,max_records:10,max_pages:1,page_size:10,retention_days:14});
 const result={monitor_id:monitor.id,account_id:v.account_id,environment_id:v.environment_id,source_url:source,source_comment_id:p.remote_id,prospect_id:id,prospect_version:p.version,status:'PAUSED_REVIEW_SOURCE',read_queued:false};
 return scoped(scope,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['provider-verification/'+scope.brand_id+'/'+v.request_id]);
  const old=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='acquisition.provider_verification_prepared' AND details->>'verification_request_id'=$1",[v.request_id])).rows[0];
  if(old){requireCondition(old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','核对请求已变化',409);return old.details.result;}
  await audit(client,scope,'acquisition.provider_verification_prepared',monitor.id,{verification_request_id:v.request_id,request_hash:hash,result});return result;
 });
}
