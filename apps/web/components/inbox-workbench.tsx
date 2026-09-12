'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import type {Workspace} from '@kff/core/service';
import type {inboxWorkspace,inboxConversation} from '@kff/core/inbox';
import type {InboxMessage,SiteChannel} from '../../../packages/contracts/src/inbox';
import {businessRequest,businessTime,stageNames} from './business-ui';
import {useRequestKey} from './use-request-key';
import {FacebookSetup} from './facebook-setup';
import {WhatsappSetup} from './whatsapp-setup';
import {ReceptionControls} from './reception-controls';
import {modeNames} from './lead-ui';

type InboxData=Awaited<ReturnType<typeof inboxWorkspace>>;
type ConversationData=Awaited<ReturnType<typeof inboxConversation>>;
export function InboxWorkbench({data}:{data:Workspace}) {
  const requestKey=useRequestKey();
  const [inbox,setInbox]=useState<InboxData|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useState('');
  const refresh=useCallback(async()=>{setInbox(await businessRequest<InboxData>('inbox'));},[]);
  useEffect(()=>{
    let closed=false;let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const result=await businessRequest<InboxData>('inbox');if(!closed)setInbox(result);}catch(failure){if(!closed)setError(failure instanceof Error?failure.message:'收件箱暂时无法读取');}finally{if(!closed)timer=setTimeout(()=>void load(),5000);}};
    setSelected(new URLSearchParams(window.location.search).get('conversation')??'');void load();return()=>{closed=true;clearTimeout(timer);};
  },[]);
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget,fields=new FormData(form);setBusy(true);setError('');
    const payload={name:fields.get('name'),is_synthetic:fields.get('kind')==='test',session_hours:Number(fields.get('session_hours')),reply_window_hours:Number(fields.get('reply_window_hours')),sessions_per_minute:Number(fields.get('sessions_per_minute')),messages_per_minute:Number(fields.get('messages_per_minute'))};
    try{await businessRequest('site-channels',{request_id:requestKey.forPayload(payload),...payload});requestKey.confirmed();form.reset();await refresh();}
    catch(failure){setError(failure instanceof Error?failure.message:'入口未保存');}finally{setBusy(false);}
  }
  if(!inbox)return <p role="status">{error||'正在读取收件箱…'}</p>;
  const conversations=inbox.conversations.filter(row=>(row.display_name??'匿名访客').includes(search)||row.channel_name.includes(search));
  return <div className="business-workbench">
    {error&&<div className="alert warning" role="alert">{error}<button onClick={()=>void refresh().then(()=>setError('')).catch(failure=>setError(failure.message))}>重新读取</button></div>}
    <div className="business-counts"><div><span>咨询客户</span><strong>{inbox.counts.customers}</strong></div><div><span>会话</span><strong>{inbox.counts.conversations}</strong></div><div><span>收到消息</span><strong>{inbox.counts.inbound_messages}</strong></div></div>
    <FacebookSetup data={data} onReceived={refresh}/>
    <WhatsappSetup data={data}/>
    <details className="business-box channel-settings"><summary>站内咨询入口 <span>{inbox.channels.length} 个</span></summary>
      {inbox.channels.length===0&&<p className="muted">创建入口后，访客可在独立咨询页面发送消息。</p>}
      <div className="channel-list">{inbox.channels.map(channel=><ChannelCard key={channel.id} channel={channel} admin={data.scope.role==='admin'} onSaved={refresh}/>)}</div>
      {data.scope.role==='admin'&&<form aria-label="新增咨询入口" className="business-form" onSubmit={event=>void create(event)}><h3>新增咨询入口</h3>
        <label>入口名称<input name="name" required maxLength={80} placeholder="例如：产品咨询"/></label>
        <label>入口类型<select aria-label="入口类型" name="kind" defaultValue="test"><option value="test">测试咨询入口</option><option value="owned">正式咨询入口</option></select></label>
        <label>访客会话有效期（小时）<input name="session_hours" type="number" required min={1} max={720} defaultValue={168}/></label>
        <label>每次咨询回复窗口（小时）<input name="reply_window_hours" type="number" required min={1} max={168} defaultValue={24}/></label>
        <label>入口每分钟新会话上限<input name="sessions_per_minute" type="number" required min={1} max={1000} defaultValue={60}/></label>
        <label>入口每分钟消息上限<input name="messages_per_minute" type="number" required min={1} max={10000} defaultValue={300}/></label>
        <p className="business-wide muted">每个访客每分钟最多发送 20 条；规则保存后固定，暂停入口可阻止新收件。</p>
        <button className="button primary" disabled={busy}>{busy?'正在保存…':'创建咨询入口'}</button>
      </form>}
    </details>
    <div className="business-columns"><section className="business-box business-list" aria-label="会话列表"><div className="business-box-head"><h2>最近会话</h2><span>最多显示 200 条</span></div><label className="business-search">查找会话<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="客户称呼或入口"/></label>
      {!conversations.length&&<div className="business-empty">等待第一条咨询<br/><small>访客主动发来消息后，在这里建立会话和客户。</small></div>}
      {conversations.map(row=><button className={'conversation-item '+(selected===row.id?'selected':'')} key={row.id} onClick={()=>setSelected(row.id)}><span className="conversation-avatar">{(row.display_name??'访客').slice(0,1)}</span><span><strong>{row.display_name??'匿名访客'}</strong><small>{row.channel_name} · {stageNames[row.stage]}</small><small>{businessTime(row.last_message_at)}</small></span><em>{row.last_sequence}</em></button>)}
    </section>
    {selected?<ConversationPanel key={selected} id={selected} role={data.scope.role}/>:<div className="business-box business-empty">选择会话，查看客户消息与服务窗口。</div>}
    </div>
  </div>;
}
function ChannelCard({channel,admin,onSaved}:{channel:SiteChannel;admin:boolean;onSaved:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function control(event:FormEvent<HTMLFormElement>){event.preventDefault();const fields=new FormData(event.currentTarget);setBusy(true);setError('');try{await businessRequest('site-channels/'+channel.id+'/controls',{request_id:crypto.randomUUID(),expected_version:channel.version,state:channel.state==='ACTIVE'?'PAUSED':'ACTIVE',reason:fields.get('reason')});await onSaved();}catch(failure){setError(failure instanceof Error?failure.message:'未能更新入口');}finally{setBusy(false);}}
  return <article className="channel-card"><div><strong>{channel.name}</strong><span className={'badge '+(channel.state==='ACTIVE'?'green':'neutral')}>{channel.state==='ACTIVE'?'接收咨询':'已暂停'}</span><p>{channel.is_synthetic?'测试咨询':'正式咨询'} · 会话 {channel.session_hours} 小时 · 回复窗口 {channel.reply_window_hours} 小时</p><Link href={'/chat/'+channel.id} target="_blank" rel="noreferrer">打开访客咨询页 ↗</Link></div>
    {admin&&<form onSubmit={event=>void control(event)} aria-label={'控制入口 '+channel.name}><label>调整入口状态的原因<input name="reason" required maxLength={300}/></label><button className="button subtle" disabled={busy}>{channel.state==='ACTIVE'?'暂停入口':'恢复入口'}</button>{error&&<p role="alert">{error}</p>}</form>}
  </article>;
}
function ConversationPanel({id,role}:{id:string;role:Workspace['scope']['role']}){
  const [detail,setDetail]=useState<ConversationData|null>(null),[messages,setMessages]=useState<InboxMessage[]>([]),[error,setError]=useState('');
  const after=useRef('0'),loading=useRef(false);
  const refresh=useCallback(async(signal?:AbortSignal)=>{if(loading.current)return;loading.current=true;try{const result=await businessRequest<ConversationData>('conversations/'+id+'?after='+after.current,undefined,signal);after.current=result.next_after;setDetail(result);setMessages(previous=>[...previous,...result.messages.filter(item=>!previous.some(old=>old.id===item.id))]);setError('');}catch(failure){if(!(failure instanceof Error&&failure.name==='AbortError'))setError(failure instanceof Error?failure.message:'会话暂时无法读取');}finally{loading.current=false;}},[id]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);const timer=setInterval(()=>void refresh(controller.signal),5000);return()=>{controller.abort();clearInterval(timer);};},[refresh]);
  return <section className="business-box conversation-panel" aria-label="会话详情">
    {detail&&<><div className="business-box-head"><div><h2>{detail.conversation.display_name??'匿名访客'}</h2><p>{detail.conversation.channel_name} · {detail.conversation.is_synthetic?'测试咨询':detail.conversation.channel_id?'站内咨询':'Facebook 咨询'} · {modeNames[detail.conversation.handling_mode]}</p></div><Link href={'/customers?customer='+detail.conversation.customer_id}>客户档案 →</Link></div>
      <div className="conversation-context"><span>负责人：{detail.conversation.owner_user_id?.slice(0,8)??'待分配'}</span><span>客服窗口截至 {businessTime(detail.conversation.reply_window_expires_at)}</span>{detail.conversation.opted_out&&<strong>客户已退出，停止新联系</strong>}</div></>}
    {error&&<p role="alert" className="alert warning">{error}</p>}
    <ol className="message-stream" aria-label="已保存的客户消息">{messages.map(message=><li key={message.id} className={message.direction==='INBOUND'?'':'outgoing'}><div className="message-bubble"><p>{message.body}</p></div><small>#{message.sequence} · {businessTime(message.received_at)} · {message.direction==='INBOUND'?'客户消息':message.direction==='EXTERNAL_OUTBOUND'?'Facebook 原生人工回复':message.actor_kind==='AI'?'自动接待 · 已确认发送':'人工回复 · 已确认发送'}</small></li>)}</ol>
    <div className="conversation-footer"><button className="button subtle" onClick={()=>void refresh()}>{detail?.has_more?'加载后续消息':'刷新消息'}</button>{detail?.conversation.channel_kind!=='FACEBOOK_MESSENGER'&&<p>{detail?.conversation.channel_id?'此入口用于收取咨询和记录跟进。':'评论和互动保留为潜客来源，收到主动私信后可进行接待。'}</p>}</div>
    {detail?.conversation.channel_kind==='FACEBOOK_MESSENGER'&&<ReceptionControls conversation={detail.conversation} role={role} onSaved={()=>refresh()}/>}
  </section>;
}
