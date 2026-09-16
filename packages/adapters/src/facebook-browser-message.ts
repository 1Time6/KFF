import type {ActionReport,AgentCommand} from '@kff/contracts';
import {AppError,digest,requireCondition} from '@kff/core';
import {openManagedBrowser} from './browser-profile';
import {assertTemplateSnapshot} from './templates';
import {inspectFacebookProfileIdentity} from './facebook-browser-identity';
import {readFacebookInboxThread} from './facebook-browser-inbox';
import {inspectFacebookInboxDom} from './facebook-inbox-dom';
import {inspectFacebookMessageResult} from './facebook-message-result-dom';
import type {ExecutorHooks} from './fixture';

export async function executeFacebookBrowserMessage(command:AgentCommand,root:string,hooks:ExecutorHooks):Promise<Omit<ActionReport,'event_id'|'command_id'>>{
  const snapshot=command.snapshot,context=snapshot.message?.browser,environment=snapshot.browser_environment;
  requireCondition(!snapshot.is_synthetic&&snapshot.mode==='CONTROLLED_PILOT'&&snapshot.capability_key==='facebook.messenger.reply.browser'&&snapshot.adapter_version==='facebook-browser-messenger-v1'&&snapshot.message?.actor_kind==='HUMAN'&&context?.display_name&&context.trigger_content_hash&&environment?.account_type==='profile'&&environment.configuration.driver==='adspower'&&!snapshot.credential_ref&&!snapshot.platform_api_version&&!snapshot.collection&&!snapshot.inbox&&!snapshot.outreach,'FORBIDDEN_SCOPE','真实浏览器回复需要固定人工试验快照');
  requireCondition(process.env.KFF_ENABLE_LIVE==='true','LIVE_DISABLED','真实发送未启用');
  requireCondition(digest(snapshot)===command.snapshot_hash&&digest(snapshot.body)===snapshot.content_hash,'APPROVAL_STALE','回复快照已变化');assertTemplateSnapshot(snapshot);hooks.assertControlled();
  const managed=await openManagedBrowser(root,environment,false);
  let intent=false,step='facebook-message-identity';
  try{
    hooks.onContext(managed.context);const page=await managed.context.newPage();page.setDefaultTimeout(10000);
    await inspectFacebookProfileIdentity(page,snapshot.external_account_id);hooks.assertControlled();
    const request={binding:{environment,account_version:snapshot.account_version!,target:{thread_id:context.thread_id,peer_id:context.peer_id,display_name:context.display_name}},template:'facebook-inbox-dom-v1' as const,cursor:null,limit:50};
    const incoming=await readFacebookInboxThread(page,request,hooks.assertControlled,value=>{step=value;});
    requireCondition(incoming.at(-1)?.message_id===context.last_seen_message_id&&incoming.some(m=>m.direction==='INBOUND'&&m.message_id===context.trigger_remote_message_id&&digest(m.body)===context.trigger_content_hash),'INBOUND_SUPERSEDED','来信或最后消息已变化，请重新收件');
    const initial=await page.evaluate(inspectFacebookInboxDom),fingerprint=digest(initial.rows.map(r=>({id:r.message_id,body:r.body,name:r.display_name,direction:r.direction})));
    const editor=page.getByRole('textbox',{name:'发消息给'+context.display_name,exact:true}),source='https://www.facebook.com/messages/e2ee/t/'+context.thread_id+'/';
    requireCondition(await editor.count()===1&&!(await editor.innerText()).trim(),'DRAFT_PRESENT','原会话已有草稿，请先人工处理');
    const current=async()=>{hooks.assertControlled();requireCondition(page.url()===source,'MESSAGE_IDENTITY_MISMATCH','会话地址已变化');const latest=await page.evaluate(inspectFacebookInboxDom);requireCondition(!latest.invalid&&digest(latest.rows.map(r=>({id:r.message_id,body:r.body,name:r.display_name,direction:r.direction})))===fingerprint,'INBOUND_SUPERSEDED','会话内容已变化，请重新收件');};
    try{
      step='facebook-message-prepare';await editor.fill(snapshot.body);await current();
      const send=page.getByRole('region',{name:'串文编辑框',exact:true}).getByRole('button',{name:'按 Enter 键发送',exact:true});
      requireCondition(await send.count()===1&&await send.isVisible()&&await send.isEnabled(),'NEEDS_HUMAN','发送入口不可用');
      requireCondition((await editor.innerText()).trim()===snapshot.body,'APPROVAL_STALE','编辑框正文与批准内容不同');
      await hooks.beforeSubmit();intent=true;step='facebook-message-submit';await current();
      requireCondition((await editor.innerText()).trim()===snapshot.body,'SUBMISSION_UNCERTAIN','提交前正文发生变化');
      requireCondition(await send.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'SUBMISSION_UNCERTAIN','发送按钮被遮挡');
      await send.click({force:true,timeout:10000});step='facebook-message-verify';
      const input={before_ids:initial.rows.map(r=>r.message_id),body:snapshot.body};
      let remoteId:string|undefined;
      for(const deadline=Date.now()+15000;Date.now()<deadline;){hooks.assertControlled();requireCondition(page.url()===source,'SUBMISSION_UNCERTAIN','发送后会话已变化');const result=await page.evaluate(inspectFacebookMessageResult,input);if(!result.invalid&&result.matches.length===1){remoteId=result.matches[0].message_id;break;}await page.waitForTimeout(250);}
      requireCondition(remoteId,'SUBMISSION_UNCERTAIN','未取得唯一的新消息标识和可见发送状态');
      await inspectFacebookProfileIdentity(page,snapshot.external_account_id);hooks.assertControlled();
      return {outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:remoteId,thread_id:context.thread_id,recipient_id:context.peer_id,actual_account_id:snapshot.external_account_id,content_hash:snapshot.content_hash,evidence_kind:'browser_message',observed_at:new Date().toISOString()},diagnostic:{step:'facebook-message-verified',browser_version:managed.context.browser()?.version()}};
    }finally{if(!intent&&page.url()===source&&(await editor.innerText().catch(()=>'' )).trim()===snapshot.body)await editor.fill('');}
  }catch(error){const code=error instanceof AppError?error.code:'EXECUTOR_ERROR';return {outcome:intent?'UNKNOWN_OUTCOME':code==='STOP_REQUESTED'?'CANCELED':code==='NEEDS_HUMAN'?'NEEDS_HUMAN':'BLOCKED',error_code:code,diagnostic:{step}};}
  finally{await managed.close();hooks.onContext(null);}
}
