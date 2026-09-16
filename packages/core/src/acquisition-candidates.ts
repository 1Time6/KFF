import type {CollectionRecord} from '@kff/contracts';
import {discoveryIsSynthetic,type MonitorInput} from '../../contracts/src/acquisition';
import type {ProviderProspect} from './acquisition-provider';
import {scoreAcquisitionText} from './acquisition-scoring';
import {publicReplyEligibility} from './acquisition-eligibility';

export interface CandidateLeadInput {
 id:string;account_id:string;monitor_id:string;version:number;state:ProviderProspect['state'];score:number;reason:string;
 config:MonitorInput;source_object_id:string;source_url:string;fields:CollectionRecord['fields'];
 observed_at:string;expires_at:string;publication_age:string;author_suppressed?:boolean;
}
export interface CandidateRecord {
 key:string;origin:'LEAD'|'PROSPECT';id:string;version:number;state:ProviderProspect['state'];
 platform:'facebook'|'instagram';kind:'POST'|'COMMENT';source_label:string;synthetic:boolean;account_id:string|null;monitor_id:string|null;
 source_object_id:string;source_url:string;parent_url:string|null;body:string;author:string|null;profile_url:string|null;identity_key:string;
 identity_basis:'PUBLIC_PROFILE_LINK'|'SOURCE_SCOPED_ID'|'RECORD_ONLY';source_score:number;score:number;score_reason:string;keywords:string[];
 source_time:string|null;time_kind:'DISPLAYED_TIME'|'EXACT'|'UNKNOWN';publication_age:string;observed_at:string;expires_at:string;
 can_prepare_public_reply:boolean;
}
function text(fields:CollectionRecord['fields'],key:keyof CollectionRecord['fields']){return fields[key]?.kind==='VALUE'?String(fields[key].value):null;}
export function facebookPublicProfileId(value:string|null){
 if(!value)return null;
 try{const u=new URL(value);if(u.protocol!=='https:'||!['www.facebook.com','facebook.com'].includes(u.hostname)||u.port||u.username||u.password||u.hash)return null;
  if(u.pathname==='/profile.php'&&[...u.searchParams.keys()].length===1&&/^[0-9]{1,128}$/.test(u.searchParams.get('id')??''))return u.searchParams.get('id');
  if(u.search)return null;return /^\/(?:people\/[^/]+\/)?([0-9]{1,128})\/?$/.exec(u.pathname)?.[1]??null;
 }catch{return null;}
}
function rank(body:string,kind:CandidateRecord['kind'],keywords:string[],exclusions:string[]=[],context:string[]=[]){
 if(kind==='POST')return {score:0,matched:keywords,reason:'帖子保留作来源背景；评论候选按统一规则排序。'};
 return scoreAcquisitionText(body,{keywords,exclusions},context);
}
export function unifiedAcquisitionCandidates(leads:readonly CandidateLeadInput[],prospects:readonly ProviderProspect[]){
 const records:CandidateRecord[]=leads.map(l=>{
  const d=l.config.discovery,synthetic=discoveryIsSynthetic(d),body=text(l.fields,'message')??'',author=text(l.fields,'author_id'),kind=d.strategy==='COMMENTS'?'COMMENT' as const:'POST' as const;
  const publicId=!synthetic&&d.platform==='facebook'&&d.provider==='LOCAL_BROWSER'&&['facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1'].includes(d.browser?.template??'')&&author&&/^[0-9]{1,128}$/.test(author)?author:null;
  const key='lead:'+l.id,ranked=rank(body,kind,d.keywords,d.exclusions),sourceTime=l.fields.created_time;
  const score=d.max_age_days!==undefined&&l.publication_age==='OLDER'?{...ranked,score:0,reason:`原始发布时间已超出最近 ${d.max_age_days} 天；${ranked.reason}`}:
   d.max_age_days!==undefined&&l.publication_age==='UNKNOWN'&&ranked.score?{...ranked,reason:`发布时间待核对；${ranked.reason}`}:ranked;
  return {key,origin:'LEAD',id:l.id,version:l.version,state:l.state,platform:d.platform,kind,source_label:synthetic?'合成验证':d.provider==='LOCAL_BROWSER'?'账号浏览器':d.provider==='META_API'?'Meta API':'数据服务',synthetic,account_id:l.account_id,monitor_id:l.monitor_id,source_object_id:l.source_object_id,source_url:l.source_url,parent_url:kind==='COMMENT'?d.target:null,body,author,profile_url:publicId?'https://www.facebook.com/'+publicId+'/':null,identity_key:publicId?'facebook:public-profile:'+publicId:author?[synthetic?'synthetic':d.provider,d.platform,l.account_id,author].join(':'):key,identity_basis:publicId?'PUBLIC_PROFILE_LINK':author?'SOURCE_SCOPED_ID':'RECORD_ONLY',source_score:l.score,score:score.score,score_reason:score.reason,keywords:score.matched,source_time:sourceTime&&'value' in sourceTime?String(sourceTime.value):null,time_kind:sourceTime?.kind==='DISPLAYED_TIME'?'DISPLAYED_TIME':sourceTime?.kind==='VALUE'?'EXACT':'UNKNOWN',publication_age:l.publication_age,observed_at:l.observed_at,expires_at:l.expires_at,can_prepare_public_reply:!synthetic&&publicReplyEligibility(l).can_prepare};
 });
 for(const p of prospects){
  const profile=p.platform==='facebook'?facebookPublicProfileId(p.profile_url):null,publicId=profile&&(!p.profile_ref||p.profile_ref===profile)?profile:null,key='prospect:'+p.id,score=rank(p.body,p.kind,p.search_keywords,[],p.search_keywords);
  records.push({key,origin:'PROSPECT',id:p.id,version:p.version,state:p.state,platform:p.platform,kind:p.kind,source_label:'Apify',synthetic:false,account_id:null,monitor_id:null,source_object_id:p.remote_id,source_url:p.source_url,parent_url:p.parent_url,body:p.body,author:p.author_name??p.profile_ref,profile_url:p.profile_url,identity_key:publicId?'facebook:public-profile:'+publicId:p.profile_ref?['APIFY',p.source_id,p.platform,p.profile_ref].join(':'):key,identity_basis:publicId?'PUBLIC_PROFILE_LINK':p.profile_ref?'SOURCE_SCOPED_ID':'RECORD_ONLY',source_score:p.score,score:score.score,score_reason:score.reason,keywords:score.matched,source_time:p.occurred_at,time_kind:p.occurred_at?'EXACT':'UNKNOWN',publication_age:p.occurred_at?'UNRESTRICTED':'UNKNOWN',observed_at:p.last_seen_at,expires_at:p.expires_at,can_prepare_public_reply:false});
 }
 const grouped=new Map<string,{key:string;identity_basis:CandidateRecord['identity_basis'];records:CandidateRecord[];score:number;has_opted_out:boolean}>();
 for(const record of records){const g=grouped.get(record.identity_key)??{key:record.identity_key,identity_basis:record.identity_basis,records:[],score:0,has_opted_out:false};g.records.push(record);g.score=Math.max(g.score,record.score);g.has_opted_out ||= record.state==='OPTED_OUT';grouped.set(g.key,g);}
 return {rule_version:'kff.unified-comment-screening.v1',groups:[...grouped.values()].sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key)),record_count:records.length,group_count:grouped.size,bounded_source_limits:{leads:200,prospects:500},scope:'当前品牌未到期来源的有限展示窗口；按同一公开链接或来源内标识分组，不创建或合并 Messenger 联系人。'};
}
