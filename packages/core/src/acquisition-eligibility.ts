import type {CollectionRecord} from '@kff/contracts';
import {facebookPublicPostUrl,type MonitorInput} from '../../contracts/src/acquisition';
import {publicationAge} from '../../contracts/src/publication-time';

export function publicReplyEligibility(lead:{state:string;score:number;config:MonitorInput;fields:CollectionRecord['fields'];source_url:string;source_object_id:string;expires_at:string;author_suppressed?:boolean},now=new Date().toISOString()){
  const d=lead.config.discovery,reasons:string[]=[];
  if(d.provider!=='LOCAL_BROWSER'||d.browser?.template!=='facebook-comments-dom-v1')reasons.push('此来源尚不是可核对的浏览器公开评论');
  if(lead.state!=='QUALIFIED'||lead.score<=0)reasons.push('需先人工审核为值得跟进');
  if(lead.author_suppressed||lead.state==='OPTED_OUT')reasons.push('作者已退出联系');
  if(!(Date.parse(lead.expires_at)>Date.parse(now)))reasons.push('来源观察已到期');
  const author=lead.fields.author_id;
  if(author?.kind!=='VALUE'||!/^[0-9]{1,128}$/.test(String(author.value)))reasons.push('缺少可核实作者 ID，不能按姓名补齐');
  const comment=/^facebook:comment:([0-9]{1,80})$/.exec(lead.source_object_id);
  if(!facebookPublicPostUrl.safeParse(d.target).success||!comment||lead.source_url!==d.target+'?comment_id='+comment[1])reasons.push('评论 ID 与原帖子链接不一致');
  if(lead.fields.message?.kind!=='VALUE'||!String(lead.fields.message.value).trim())reasons.push('原评论正文缺失');
  if(lead.fields.created_time?.kind!=='DISPLAYED_TIME')reasons.push('原评论页面时间缺失');
  if(d.max_age_days!==undefined&&publicationAge(lead.fields.created_time,now,d.max_age_days)!=='RECENT')reasons.push('发布时间超期或仍待核对');
  return {can_prepare:reasons.length===0,reasons,scope:'仅用于准备公开回复草稿；发送时仍核对账号、环境、目标版本及许可。公开作者不等于 Messenger 收件人。'};
}
