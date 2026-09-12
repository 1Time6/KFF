import {z} from 'zod';
import type {TaskSnapshot,AgentCommand} from '@kff/contracts';
import {AppError,digest,requireCondition} from '@kff/core';
import {FacebookPageAdapter} from './facebook';
import {assertTemplateSnapshot} from './templates';

export class FacebookMessengerAdapter {
  private page:FacebookPageAdapter;
  constructor(private options:{version:string;pageToken:string;fetch?:typeof fetch;signal?:AbortSignal;assertControlled?:()=>void}){this.page=new FacebookPageAdapter(options);}
  validateInput(snapshot:TaskSnapshot){
    assertTemplateSnapshot(snapshot);
    requireCondition(!snapshot.is_synthetic&&snapshot.capability_key==='facebook.messenger.reply.api'&&snapshot.adapter_version==='facebook-messenger-v1'&&snapshot.message,'INVALID_INPUT','不是受支持的 Facebook 私信快照');
    requireCondition(snapshot.body.trim().length>0&&snapshot.body.length<=2000&&digest(snapshot.body)===snapshot.content_hash,'INVALID_INPUT','私信内容与快照不一致');
    requireCondition(snapshot.message.contact.account_id===snapshot.account_id&&snapshot.message.contact.channel==='facebook_messenger'&&/^[0-9]{1,128}$/.test(snapshot.message.contact.remote_id),'ACCOUNT_MISMATCH','收件人与账号绑定无效');
    requireCondition(snapshot.platform_api_version===this.options.version,'VERSION_CONFLICT','Graph API 版本与任务不符');
  }
  async execute(snapshot:TaskSnapshot,beforeSubmit:()=>Promise<void>,actionId?:string){
    this.validateInput(snapshot);const page=z.object({id:z.string()}).parse(await this.page.graph('me','GET',{fields:'id,name'}));requireCondition(page.id===snapshot.external_account_id,'ACCOUNT_MISMATCH','实际主页与指定账号不一致');
    requireCondition(actionId&&z.string().uuid().safeParse(actionId).success,'INVALID_INPUT','缺少持久动作标识');
    const recipient=snapshot.message!.contact.remote_id;
    await beforeSubmit();
    const response=z.object({recipient_id:z.string(),message_id:z.string().min(1).max(200)}).parse(await this.page.graph(snapshot.external_account_id+'/messages','POST',{messaging_type:'RESPONSE',recipient:JSON.stringify({id:recipient}),message:JSON.stringify({text:snapshot.body,metadata:'kff:'+actionId})}));
    requireCondition(response.recipient_id===recipient,'SUBMISSION_UNCERTAIN','平台响应的收件人与任务不符');
    // Send API acceptance confirms this request, not delivery, reading or adding a WhatsApp contact.
    return {remote_id:response.message_id,actual_account_id:snapshot.external_account_id,recipient_id:recipient,content_hash:snapshot.content_hash,evidence_kind:'graph_message' as const,observed_at:new Date().toISOString()};
  }
}
export async function executeFixtureMessage(command:AgentCommand,hooks:{beforeSubmit():Promise<void>;assertControlled():void;signal?:AbortSignal},origin='http://127.0.0.1:4311'){
  const snapshot=command.snapshot;assertTemplateSnapshot(snapshot);
  requireCondition(snapshot.is_synthetic&&snapshot.mode==='TEST_ONLY'&&snapshot.capability_key==='kff.fixture.messenger.reply.api'&&snapshot.message&&snapshot.adapter_version==='fixture-messenger-v1','FORBIDDEN_SCOPE','合成私信执行范围无效');
  requireCondition(new URL(origin).origin===origin&&new URL(origin).hostname==='127.0.0.1','FORBIDDEN_SCOPE','合成私信仅允许本地服务器');
  hooks.assertControlled();
  if(snapshot.fixture_scenario==='slow')await new Promise(resolve=>setTimeout(resolve,1500));
  hooks.assertControlled();await hooks.beforeSubmit();hooks.assertControlled();
  const response=await fetch(origin+'/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:snapshot.external_account_id,recipient_id:snapshot.message.contact.remote_id,action_id:command.action_id,body:snapshot.body}),redirect:'error',signal:hooks.signal?AbortSignal.any([hooks.signal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000)});
  requireCondition(response.ok,'REMOTE_ERROR','合成服务器未确认提交');
  const result=z.object({id:z.string(),account_id:z.string(),recipient_id:z.string(),action_id:z.string(),body:z.string(),content_hash:z.string()}).parse(await response.json());
  requireCondition(result.account_id===snapshot.external_account_id&&result.recipient_id===snapshot.message.contact.remote_id&&result.action_id===command.action_id&&digest(result.body)===snapshot.content_hash&&result.content_hash===snapshot.content_hash,'SUBMISSION_UNCERTAIN','合成消息证据与任务不符');
  if(snapshot.fixture_scenario==='lost_after_submit')throw new AppError('SUBMISSION_UNCERTAIN','合成场景：发送后未收到确认');
  return {remote_id:result.id,actual_account_id:result.account_id,recipient_id:result.recipient_id,content_hash:result.content_hash,evidence_kind:'synthetic_message' as const,observed_at:new Date().toISOString()};
}
