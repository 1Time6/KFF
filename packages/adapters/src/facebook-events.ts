import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {AppError,requireCondition} from '@kff/core';
import {facebookEvent,type FacebookEvent} from '../../contracts/src/lead';

const object=z.record(z.string(),z.unknown());
const asObject=(value:unknown):Record<string,unknown>=>object.safeParse(value).data??{};
const id=(value:unknown)=>typeof value==='string'&&/^[0-9]{1,128}$/.test(value)?value:null;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length?value.slice(0,max):null;
export function verifyFacebookSignature(bytes:Buffer,signature:string|null,secret:string|undefined) {
  requireCondition(secret&&secret.length>=16,'FACEBOOK_NOT_CONFIGURED','Facebook 回调密钥尚未配置',503);
  requireCondition(signature&&/^sha256=[a-f0-9]{64}$/.test(signature),'INVALID_SIGNATURE','Facebook 回调签名无效',401);
  const expected=createHmac('sha256',secret).update(bytes).digest();
  requireCondition(timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')),'INVALID_SIGNATURE','Facebook 回调签名无效',401);
}
export function facebookChallenge(search:URLSearchParams,token:string|undefined) {
  requireCondition(token&&token.length>=16,'FACEBOOK_NOT_CONFIGURED','Facebook 验证令牌尚未配置',503);
  const supplied=search.get('hub.verify_token')??'';
  requireCondition(search.get('hub.mode')==='subscribe'&&Buffer.byteLength(supplied)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token)),'INVALID_SIGNATURE','Facebook 验证失败',403);
  const challenge=search.get('hub.challenge');requireCondition(challenge&&challenge.length<=1000,'INVALID_INPUT','验证内容无效');return challenge;
}
// Only documented Page messaging/feed shapes are accepted. Missing sender identity is never invented.
export function normalizeFacebookEvents(raw:unknown) {
  const envelope=z.object({object:z.literal('page'),entry:z.array(z.object({id:z.string(),time:z.number().optional(),messaging:z.array(z.unknown()).max(200).optional(),changes:z.array(z.unknown()).max(200).optional()}).passthrough()).max(100)}).parse(raw);
  const events:FacebookEvent[]=[];const ignored:Record<string,number>={};
  const skip=(reason:string)=>{ignored[reason]=(ignored[reason]??0)+1;};
  let count=0;
  for(const entry of envelope.entry){
    const page=id(entry.id);requireCondition(page,'INVALID_INPUT','Page ID 必须为数字字符串');
    for(const rawMessage of entry.messaging??[]){
      if(++count>200)throw new AppError('EVENT_LIMIT_EXCEEDED','单个回调最多处理 200 个事件',413);
      const value=asObject(rawMessage),message=asObject(value.message),sender=asObject(value.sender),recipient=asObject(value.recipient);
      if(!message.mid){skip('UNSUPPORTED_MESSAGING_EVENT');continue;}
      const echo=message.is_echo===true,person=id(echo?recipient.id:sender.id);
      requireCondition((echo?sender.id:recipient.id)===page,'ACCOUNT_MISMATCH','消息 Page 归属与回调不一致');
      if(!person||person===page){skip('MISSING_CUSTOMER_IDENTITY');continue;}
      const timestamp=value.timestamp;requireCondition(typeof timestamp==='number'&&Number.isSafeInteger(timestamp)&&timestamp>0&&timestamp<=Date.now()+300000,'INVALID_INPUT','消息时间无效');
      const attachment=Array.isArray(message.attachments)&&message.attachments.length>0;
      const body=text(message.text,5000)??(attachment?'[客户发送了附件，需要人工查看]':null);
      if(!body){skip('EMPTY_MESSAGE');continue;}
      const referral=asObject(value.referral??message.referral),ad=asObject(referral.ads_context_data);
      const correlation=echo&&typeof message.metadata==='string'&&message.metadata.startsWith('kff:')?z.string().uuid().safeParse(message.metadata.slice(4)).data:undefined;
      events.push(facebookEvent.parse({event_id:String(message.mid),page_id:page,sender_id:person,kind:echo?'ECHO':'MESSAGE',body,display_name:null,occurred_at:new Date(timestamp).toISOString(),has_attachment:attachment,...(correlation?{correlation_id:correlation}:{}),source:{kind:'MESSENGER',page_id:page,source_id:text(referral.source,200),ref:text(referral.ref,300),ad_id:id(referral.ad_id??ad.ad_id)}}));
    }
    for(const rawChange of entry.changes??[]){
      if(++count>200)throw new AppError('EVENT_LIMIT_EXCEEDED','单个回调最多处理 200 个事件',413);
      const change=asObject(rawChange),value=asObject(change.value),from=asObject(value.from);
      if(change.field!=='feed'||!['comment','reaction'].includes(String(value.item))||value.verb!=='add'){skip('UNSUPPORTED_FEED_EVENT');continue;}
      const person=id(from.id);if(!person||person===page){skip('MISSING_CUSTOMER_IDENTITY');continue;}
      const occurred=typeof value.created_time==='number'?value.created_time*1000:entry.time;
      requireCondition(typeof occurred==='number'&&Number.isSafeInteger(occurred)&&occurred>0&&occurred<=Date.now()+300000,'INVALID_INPUT','互动时间无效');
      const comment=value.item==='comment',sourceId=text(comment?value.comment_id:value.post_id,200);
      if(!sourceId){skip('MISSING_SOURCE_ID');continue;}
      events.push(facebookEvent.parse({event_id:(comment?'comment/':'reaction/')+sourceId+(comment?'':'/'+person+'/'+occurred),page_id:page,sender_id:person,kind:comment?'COMMENT':'INTERACTION',body:text(value.message,5000)??(comment?'[无文本评论]':'[Facebook 互动]'),display_name:text(from.name,80),occurred_at:new Date(occurred).toISOString(),has_attachment:false,source:{kind:comment?'COMMENT':'INTERACTION',page_id:page,source_id:sourceId,ref:text(value.post_id,300),ad_id:null}}));
    }
  }
  return {events,ignored};
}
