import {z} from 'zod';
import type {TaskSnapshot} from '@kff/contracts';
import {requireCondition,digest} from '@kff/core';
import {assertTemplateSnapshot} from './templates';
import {readBoundedJson} from './discovery';
export async function executeInstagramIdentity(snapshot:TaskSnapshot,hooks:{token:string;signal?:AbortSignal;fetch?:typeof fetch}){
  assertTemplateSnapshot(snapshot);requireCondition(snapshot.capability_key==='instagram.account.read.api'&&!snapshot.is_synthetic&&snapshot.platform_api_version,'INVALID_INPUT','Instagram 身份快照无效');
  const row=z.object({id:z.string()}).parse(await readBoundedJson(await (hooks.fetch??fetch)('https://graph.instagram.com/'+snapshot.platform_api_version+'/me?fields=id',{headers:{Authorization:'Bearer '+hooks.token},redirect:'error',signal:hooks.signal??AbortSignal.timeout(10000)})));
  requireCondition(row.id===snapshot.external_account_id,'ACCOUNT_MISMATCH','Instagram 账号不符');return {remote_id:row.id,actual_account_id:row.id,evidence_kind:'graph_object' as const,observed_at:new Date().toISOString()};
}

export async function executeSocialOutreach(snapshot:TaskSnapshot,actionId:string,hooks:{beforeSubmit():Promise<void>;signal?:AbortSignal;fetch?:typeof fetch;token?:string}){
  assertTemplateSnapshot(snapshot);const s=snapshot.outreach;
  requireCondition(s&&snapshot.adapter_version==='social-outreach-v1'&&digest(snapshot.body)===snapshot.content_hash,'INVALID_INPUT','缺少有效互动快照');
  const fetcher=hooks.fetch??fetch;
  if(snapshot.is_synthetic){
    requireCondition(snapshot.mode==='TEST_ONLY'&&snapshot.capability_key==='kff.fixture.social.reply.api','FORBIDDEN_SCOPE','合成范围不符');
    await hooks.beforeSubmit();
    const row=z.object({id:z.string(),account_id:z.string(),recipient_id:z.string(),action_id:z.string(),content_hash:z.string()}).parse(await readBoundedJson(await fetcher('http://127.0.0.1:4311/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:snapshot.external_account_id,recipient_id:s.author_id,action_id:actionId,body:snapshot.body}),redirect:'error',signal:hooks.signal??AbortSignal.timeout(10000)})));
    requireCondition(row.account_id===snapshot.external_account_id&&row.recipient_id===s.author_id&&row.action_id===actionId&&row.content_hash===snapshot.content_hash,'SUBMISSION_UNCERTAIN','合成回执目标不一致');
    return {remote_id:row.id,actual_account_id:row.account_id,recipient_id:row.recipient_id,content_hash:row.content_hash,evidence_kind:'synthetic_message' as const,observed_at:new Date().toISOString()};
  }
  requireCondition(hooks.token&&snapshot.platform_api_version,'AUTH_EXPIRED','缺少已批准凭据');
  const origin=s.platform==='facebook'?'https://graph.facebook.com':'https://graph.instagram.com';
  const call=async(path:string,method:'GET'|'POST',params:Record<string,unknown>)=>{
    const url=new URL('/'+snapshot.platform_api_version+'/'+path,origin);if(method==='GET')for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
    return readBoundedJson(await fetcher(url,{method,headers:{Authorization:'Bearer '+hooks.token,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(params)}:{}),redirect:'error',signal:hooks.signal?AbortSignal.any([hooks.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)}));
  };
  const me=z.object({id:z.string()}).parse(await call('me','GET',{fields:'id'}));
  requireCondition(me.id===snapshot.external_account_id,'ACCOUNT_MISMATCH','执行凭据不属于指定账号');
  const parent=z.object({id:z.string(),from:z.object({id:z.string()}).optional(),owner:z.object({id:z.string()}).optional()}).parse(await call(s.parent_id,'GET',{fields:s.platform==='facebook'?'id,from':'id,owner'}));
  requireCondition(parent.id===s.parent_id&&(parent.from?.id??parent.owner?.id)===me.id,'SOURCE_NOT_OWNED','原帖子不属于指定账号');
  const comment=z.object({id:z.string(),from:z.object({id:z.string()}),object:z.object({id:z.string()}).optional(),media:z.object({id:z.string()}).optional()}).parse(await call(s.source_object_id,'GET',{fields:s.platform==='facebook'?'id,from,object':'id,from,media'}));
  requireCondition(comment.id===s.source_object_id&&comment.from.id===s.author_id&&(comment.object?.id??comment.media?.id)===s.parent_id,'ACCOUNT_MISMATCH','评论、作者或所属内容与快照不一致');
  await hooks.beforeSubmit();
  const path=s.action==='COMMENT_REPLY'?s.source_object_id+(s.platform==='facebook'?'/comments':'/replies'):snapshot.external_account_id+'/messages';
  const params=s.action==='PRIVATE_REPLY'?{recipient:{comment_id:s.source_object_id},message:{text:snapshot.body}}:{message:snapshot.body};
  const raw=z.object({id:z.string().optional(),message_id:z.string().optional(),recipient_id:z.string().optional()}).parse(await call(path,'POST',params));
  const id=raw.id??raw.message_id;requireCondition(id,'SUBMISSION_UNCERTAIN','平台未返回动作标识');
  // A private reply receipt identifies the API request, not an opened DM service window.
  return {remote_id:id,actual_account_id:me.id,recipient_id:s.author_id,content_hash:snapshot.content_hash,evidence_kind:'graph_message' as const,observed_at:new Date().toISOString()};
}
