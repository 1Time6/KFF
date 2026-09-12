'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import type {publicChatInfo} from '@kff/core/inbox';
import type {InboundMessageInput,InboxMessage,MessagePage} from '../../../packages/contracts/src/inbox';
import {businessRequest,businessTime} from './business-ui';

type ChatInfo=Awaited<ReturnType<typeof publicChatInfo>>;
export default function VisitorChat({channelId}:{channelId:string}){
  const path='public/chat/'+channelId;
  const [info,setInfo]=useState<ChatInfo|null>(null),[active,setActive]=useState(false),[expires,setExpires]=useState(''),[messages,setMessages]=useState<InboxMessage[]>([]);
  const [body,setBody]=useState(''),[name,setName]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<InboundMessageInput|null>(null),[hasMore,setHasMore]=useState(false);
  const after=useRef('0'),loading=useRef(false),sending=useRef(false);
  const append=useCallback((incoming:InboxMessage[])=>setMessages(previous=>[...previous,...incoming.filter(item=>!previous.some(old=>old.id===item.id))].sort((a,b)=>a.sequence-b.sequence)),[]);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    if(loading.current)return;loading.current=true;
    try{const result=await businessRequest<MessagePage & {expires_at:string}>(path+'/messages?after='+after.current,undefined,signal);after.current=result.next_after;setHasMore(result.has_more);setExpires(result.expires_at);append(result.messages);}
    catch(failure){if(failure instanceof Error&&failure.name!=='AbortError'){setError(failure.message);if('status' in failure&&failure.status===401)setActive(false);}}
    finally{loading.current=false;}
  },[path,append]);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.all([businessRequest<ChatInfo>(path,undefined,controller.signal),businessRequest<{active:boolean;expires_at:string|null}>(path+'/sessions',undefined,controller.signal)]).then(([channel,session])=>{setInfo(channel);setActive(session.active);setExpires(session.expires_at??'');}).catch(failure=>{if(failure.name!=='AbortError')setError(failure.message);});
    return()=>controller.abort();
  },[path]);
  useEffect(()=>{if(!active)return;const controller=new AbortController();void refresh(controller.signal);const timer=setInterval(()=>void refresh(controller.signal),5000);return()=>{controller.abort();clearInterval(timer);};},[active,refresh]);
  async function begin(){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try{const session=await businessRequest<{created:boolean;expires_at:string}>(path+'/sessions',{});if(session.created){after.current='0';setMessages([]);setPending(null);setBody('');}setExpires(session.expires_at);setActive(true);}
    catch(failure){setError(failure instanceof Error?failure.message:'暂时无法开始咨询');}finally{setBusy(false);sending.current=false;}
  }
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(sending.current)return;sending.current=true;setBusy(true);setError('');setNotice('');
    const input=pending??{client_message_id:crypto.randomUUID(),body:body.trim(),display_name:name.trim()||null,client_sent_at:new Date().toISOString()};setPending(input);
    try{const result=await businessRequest<{status:'STORED';message:InboxMessage}>(path+'/messages',input);append([result.message]);setBody('');setPending(null);setNotice('消息已保存');void refresh();}
    catch(failure){setError(failure instanceof Error?failure.message:'暂未收到保存确认，请使用原消息重试');if(failure instanceof Error&&'status' in failure&&failure.status===401)setActive(false);}
    finally{setBusy(false);sending.current=false;}
  }
  async function end(){setBusy(true);setError('');try{await businessRequest(path+'/end',{});setActive(false);setMessages([]);setExpires('');setNotice('咨询会话已结束，已保存的消息保留在客服记录中。');}catch(failure){setError(failure instanceof Error?failure.message:'会话未结束');}finally{setBusy(false);}}
  return <main className="visitor-page"><div className="visitor-shell"><header className="visitor-header"><span className="visitor-mark">K</span><div><p>KFF · 在线咨询</p><h1>{info?.name??'咨询入口'}</h1></div>{info?.is_synthetic&&<span className="badge neutral">测试咨询</span>}</header>
    <div className="visitor-intro"><h2>有什么可以帮您？</h2><p>留下您的问题，我们会在此保留咨询记录。</p>{info?.state==='PAUSED'&&<p role="status">此入口已暂停接收新咨询。</p>}</div>
    {error&&<div className="visitor-alert" role="alert">{error}{pending&&<p>原消息仍保留。请按原消息重试，确认后再继续发送。</p>}</div>}{notice&&<p className="business-success" role="status">{notice}</p>}
    {!active&&<div className="visitor-start">{pending&&<p>上条消息尚未收到确认。开始新会话会清空当前输入，原有记录不会删除。</p>}<p>本浏览器的会话有效期为 {info?.session_hours??'—'} 小时。结束或过期后重新咨询会建立独立身份。</p><button className="button primary" disabled={busy||!info||info.state==='PAUSED'} onClick={()=>void begin()}>开始咨询</button></div>}
    {active&&<><ol className="message-stream visitor-stream" aria-label="我的咨询记录">{messages.length===0&&<li className="visitor-placeholder">您的首条消息将开启这次咨询。</li>}{messages.map(message=><li key={message.id}><div className="message-bubble"><p>{message.body}</p></div><small>{businessTime(message.received_at)} · 已保存</small></li>)}</ol>
      {hasMore&&<button className="button subtle" onClick={()=>void refresh()}>加载后续记录</button>}
      <form className="visitor-compose" aria-label="发送咨询" onSubmit={event=>void send(event)}>{messages.length===0&&<label>您的称呼（选填）<input value={name} onChange={event=>setName(event.target.value)} maxLength={80} disabled={busy||!!pending||messages.length>0} autoComplete="nickname" placeholder="如何称呼您"/></label>}<label>咨询内容<textarea aria-label="咨询内容" value={body} onChange={event=>setBody(event.target.value)} rows={4} maxLength={5000} required disabled={busy||!!pending} placeholder="请描述您想了解的内容"/></label><div><small>{body.length} / 5000</small><button className="button primary" disabled={busy||(!pending&&!body.trim())||info?.state==='PAUSED'}>{busy?'正在保存…':pending?'按原消息重试':'发送咨询'}</button></div></form>
      <footer className="visitor-footer"><small>会话有效至 {businessTime(expires)}</small><button className="text-button" disabled={busy||!!pending} onClick={()=>void end()}>结束此会话</button></footer>
    </>}
    <p className="visitor-footnote">由 KFF 提供咨询与记录服务</p>
  </div></main>;
}
