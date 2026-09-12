'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import type {Scope} from '@kff/contracts';
import type {InboxConversation} from '../../../packages/contracts/src/inbox';
import type {conversationReception} from '@kff/core/lead-reception';
import {businessRequest,businessTime} from './business-ui';
import {modeNames,leadNames,actionNames} from './lead-ui';
type Reception=Awaited<ReturnType<typeof conversationReception>>;
export function ReceptionControls({conversation,role,onSaved}:{conversation:InboxConversation;role:Scope['role'];onSaved:()=>Promise<void>}){
  const [data,setData]=useState<Reception|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const pending=useRef<{key:string;path:string;payload:Record<string,unknown>}|null>(null);
  const load=useCallback(async()=>{setData(await businessRequest<Reception>('conversations/'+conversation.id+'/reception'));},[conversation.id]);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const result=await businessRequest<Reception>('conversations/'+conversation.id+'/reception',undefined,controller.signal);setData(result);}catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'接待状态暂时无法读取');}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void tick(),5000);}};void tick();return()=>{controller.abort();clearTimeout(timer);};},[conversation.id]);
  async function perform(path:string,value:Record<string,unknown>,success:string){
    if(busy)return;setBusy(true);setError('');setNotice('');
    // The pending payload retains its original control version across refreshes after a lost response.
    const key=JSON.stringify({path,...value});if(pending.current?.key!==key)pending.current={key,path,payload:{...value,request_id:crypto.randomUUID(),expected_version:conversation.control_version}};
    try{await businessRequest(path,pending.current.payload);pending.current=null;setNotice(success);await Promise.all([load(),onSaved()]);}
    catch(failure){if(failure&&typeof failure==='object'&&'status' in failure)pending.current=null;setError(failure instanceof Error?failure.message:'操作未完成，请保留原内容重试');}finally{setBusy(false);}
  }
  async function reply(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,fields=new FormData(form),referral=fields.get('refer_whatsapp')==='on';await perform('conversations/'+conversation.id+'/replies',{body:String(fields.get('body')??'').trim(),refer_whatsapp:referral,fixture_scenario:'normal'},'人工回复已入队，确认回执后显示为已发送。');}
  const unsafe=data?.replies.some(row=>['SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME'].includes(row.state));
  return <div className="lead-reception" aria-label="接待控制">
    <div className="conversation-context"><strong>{modeNames[conversation.handling_mode]}</strong><span>{leadNames[conversation.lead_status]}</span></div>
    {error&&<p className="alert warning" role="alert">{error}</p>}{notice&&<p role="status" className="business-success">{notice}</p>}
    {unsafe&&<p className="alert warning">有正在提交或结果未知的回复。接管可阻止后续自动发送；请先核验原提交，再发下一条。</p>}
    {role!=='viewer'&&<><form className="business-form" aria-label="切换接待方式" onSubmit={event=>{event.preventDefault();const fields=new FormData(event.currentTarget);void perform('conversations/'+conversation.id+'/controls',{mode:String(fields.get('mode')),reason:String(fields.get('reason'))},'接待方式已更新。');}}><label>接待方式<select name="mode" defaultValue="HUMAN"><option value="HUMAN">人工接管</option><option value="PAUSED">暂停接待</option><option value="AI">恢复自动接待</option></select></label><label>切换原因<input name="reason" required maxLength={500}/></label><button className="button subtle" disabled={busy}>保存接待方式</button></form>
      <form className="business-form" aria-label="人工回复" onSubmit={event=>void reply(event)}><label className="business-wide">回复内容<textarea name="body" maxLength={2000} rows={3} placeholder="输入回复；发送时将接管此会话"/></label><label className="business-wide"><input name="refer_whatsapp" type="checkbox" disabled={data?.destination?.state!=='ACTIVE'}/> 使用本账号的 WhatsApp 引流话术</label><p className="muted business-wide">{data?.destination?.state==='ACTIVE'?`目的地：${data.destination.name} · +${data.destination.phone}（${data.destination.account_id?'账号专用':'品牌默认'}）`:'没有可用的 WhatsApp 目的地，请先配置。'}</p><button className="button primary" disabled={busy||unsafe||conversation.opted_out||['IGNORED','BLOCKED','HANDOFF_COMPLETE'].includes(conversation.lead_status)}>接管并发送回复</button></form>
      {data?.jobs.some(row=>row.state==='DEAD')&&<button className="button subtle" disabled={busy||unsafe} onClick={()=>void perform('conversations/'+conversation.id+'/retry-reception',{},'已为最新未回答私信重新安排接待。')}>重试最新自动接待</button>}
    </>}
    {!!data?.jobs.length&&<details className="reception-history"><summary>自动接待判断</summary>{data.jobs.map(job=><article key={job.id}><strong>{actionNames[job.state]??job.state} · {job.result?.model==='LOCAL_RULES'?'本地规则预演':job.result?.model==='OPENAI_COMPATIBLE'?'模型接口':`尝试 ${job.attempts} 次`}</strong><p>{job.result?.decision?.reason??job.result?.reason??job.error_code??'等待 Worker 处理'}</p>{job.result?.decision&&<small>{actionNames[job.result.decision.action]} · {job.result.decision.intent} · 置信度 {Math.round(job.result.decision.confidence*100)}%</small>}</article>)}</details>}
    {!!data?.replies.length&&<details className="reception-history" open><summary>回复发送进度</summary>{data.replies.map(row=><article key={row.id}><strong>{row.actor_kind==='AI'?'自动接待':'人工'} · {actionNames[row.state]??row.state}</strong><p>{row.body}</p><small>{businessTime(row.created_at)}{row.error_code?' · '+row.error_code:''}</small><Link href={'/runs?run='+row.run_id}>查看执行与核验 →</Link>{role==='admin'&&conversation.is_synthetic&&row.state==='UNKNOWN_OUTCOME'&&<button className="button subtle" disabled={busy} onClick={()=>void perform('runs/'+row.run_id+'/reconciliation',{},'原提交核验已完成，请查看最新结果。')}>核验原提交</button>}</article>)}</details>}
    {!!data?.referrals.length&&<div className="reception-history"><h3>WhatsApp 引流记录</h3><p className="muted">发送邀请与客户已联系分别记录。客户结果由销售核实后登记。</p>{data.referrals.map(row=><ReferralResult key={row.id+'/'+row.version} row={row} writable={role!=='viewer'} onSaved={async()=>{await Promise.all([load(),onSaved()]);}}/>)}</div>}
  </div>;
}
function ReferralResult({row,writable,onSaved}:{row:Reception['referrals'][number];writable:boolean;onSaved:()=>Promise<void>}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);const request=useRef<{key:string;id:string}|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');const fields=new FormData(event.currentTarget),payload={expected_version:row.version,result:fields.get('result'),reason:fields.get('reason')},key=JSON.stringify(payload);if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};try{await businessRequest('whatsapp-referrals/'+row.id+'/result',{...payload,request_id:request.current.id});await onSaved();}catch(failure){setError(failure instanceof Error?failure.message:'结果未保存');}finally{setBusy(false);}}
  return <article><strong>{actionNames[row.state]??row.state} · {row.actor_kind==='AI'?'自动':'人工'}引流</strong><p>{row.body}</p><small>{businessTime(row.sent_at)}</small>{writable&&row.state==='REFERRED'&&<form className="business-form" aria-label="记录 WhatsApp 客户结果" onSubmit={event=>void submit(event)}><label>客户结果<select name="result"><option value="CONFIRMED">已核实客户联系 WhatsApp</option><option value="DECLINED">客户未添加或拒绝</option></select></label><label>核实依据<input name="reason" required maxLength={500}/></label><button className="button subtle" disabled={busy}>保存引流结果</button>{error&&<p role="alert">{error}</p>}</form>}</article>;
}
