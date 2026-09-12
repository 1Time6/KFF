'use client';
import {useCallback,useEffect,useState,type FormEvent} from 'react';
import Link from 'next/link';
import type {Workspace} from '@kff/core/service';
import type {customerWorkspace,customerDetail} from '@kff/core/inbox';
import {customerStages} from '../../../packages/contracts/src/inbox';
import {businessRequest,businessTime,stageNames} from './business-ui';
import {useRequestKey} from './use-request-key';

type CustomerData=Awaited<ReturnType<typeof customerWorkspace>>;
type CustomerDetail=Awaited<ReturnType<typeof customerDetail>>;
export function CustomerWorkbench({data}:{data:Workspace}){
  const [list,setList]=useState<CustomerData|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[search,setSearch]=useState('');
  const refresh=useCallback(async()=>{try{setList(await businessRequest<CustomerData>('customers'));setError('');}catch(failure){setError(failure instanceof Error?failure.message:'客户档案暂时无法读取');}},[]);
  useEffect(()=>{setSelected(new URLSearchParams(window.location.search).get('customer')??'');void refresh();},[refresh]);
  return <div className="business-workbench">{error&&<p className="alert warning" role="alert">{error}</p>}<div className="business-toolbar"><p>客户来源于主动咨询；同名访客保留各自身份。</p><button className="button subtle" onClick={()=>void refresh()}>刷新客户</button></div>
    <div className="business-columns"><section className="business-box business-list" aria-label="客户列表"><div className="business-box-head"><h2>客户档案</h2><span>最近 200 位</span></div><label className="business-search">查找客户<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="客户称呼"/></label>
      {list?.customers.filter(customer=>(customer.display_name??'匿名访客').includes(search)).map(customer=><button key={customer.id} className={'conversation-item '+(selected===customer.id?'selected':'')} onClick={()=>setSelected(customer.id)}><span className="conversation-avatar">{(customer.display_name??'访客').slice(0,1)}</span><span><strong>{customer.display_name??'匿名访客'}</strong><small>{stageNames[customer.stage]} · {customer.owner_user_id?'已分配':'待分配'}</small><small>{businessTime(customer.updated_at)}</small></span></button>)}
      {list?.customers.length===0&&<div className="business-empty">还没有客户。访客发来首条咨询后自动建档。</div>}
    </section>{selected&&list?<CustomerPanel key={selected} id={selected} members={list.members} scope={data.scope} onSaved={refresh}/>:<div className="business-box business-empty">选择客户，查看来源、会话和跟进记录。</div>}</div>
  </div>;
}
function CustomerPanel({id,members,scope,onSaved}:{id:string;members:CustomerData['members'];scope:Workspace['scope'];onSaved:()=>Promise<void>}){
  const requestKey=useRequestKey();
  const [detail,setDetail]=useState<CustomerDetail|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{try{setDetail(await businessRequest<CustomerDetail>('customers/'+id));setError('');}catch(failure){setError(failure instanceof Error?failure.message:'客户暂时无法读取');}},[id]);
  useEffect(()=>{void refresh();},[refresh]);
  async function save(event:FormEvent<HTMLFormElement>,note=false){
    event.preventDefault();if(!detail)return;const form=event.currentTarget,fields=new FormData(form);setBusy(true);setError('');setNotice('');
    const payload=note?{text:fields.get('note')}:{expected_version:detail.customer.version,display_name:String(fields.get('display_name')??'').trim()||null,owner_user_id:fields.get('owner')||null,stage:fields.get('stage'),reason:fields.get('reason')};
    try{await businessRequest('customers/'+id+(note?'/notes':''),{request_id:requestKey.forPayload({note,...payload}),...payload});requestKey.confirmed();if(note)form.reset();await refresh();await onSaved();setNotice(note?'跟进备注已保存':'客户档案已保存');}
    catch(failure){setError(failure instanceof Error?failure.message:'修改未保存');}finally{setBusy(false);}
  }
  return <section className="business-box customer-panel" aria-label="客户详情">{error&&<div className="alert warning" role="alert">{error}<button onClick={()=>void refresh()}>刷新后重新核对</button></div>}{notice&&<p role="status" className="business-success">{notice}</p>}
    {detail&&<><div className="business-box-head"><div><h2>{detail.customer.display_name??'匿名访客'}</h2><p>首次咨询 {businessTime(detail.customer.created_at)}</p></div><span className="badge neutral">{stageNames[detail.customer.stage]}</span></div>
      <div className="customer-origin"><p><strong>建档来源</strong> KFF 站内主动咨询</p><p><strong>获客来源</strong> 未知</p><p><strong>支付核实</strong> {detail.payment_summary.real||detail.payment_summary.test?`真实付款 ${detail.payment_summary.real} 笔 · 测试记录 ${detail.payment_summary.test} 笔`:'尚无记录'}</p><small>成交、交付阶段为人工标记；款项核实和交付证据分别记录。</small></div>
      <div className="customer-links">{scope.role!=='viewer'&&<Link href={'/orders?customer='+id}>为此客户创建订单 →</Link>}{detail.conversations.map(conversation=><Link key={conversation.id} href={'/inbox?conversation='+conversation.id}>{conversation.channel_name} · {conversation.last_sequence} 条消息 →</Link>)}</div>
      {detail.orders.length>0&&<div className="customer-links" aria-label="客户关联订单">{detail.orders.map(order=><Link key={order.id} href={'/orders?order='+order.id}>订单 {order.id.slice(0,8)} · {order.state==='CANCELED'?'已取消':order.payment_state==='VERIFIED_PAID'?'已付款':order.payment_state==='VERIFIED_TEST_PAID'?'测试付款已核实':'待核实'} →</Link>)}</div>}
      <form key={detail.customer.version} className="business-form" aria-label="编辑客户档案" onSubmit={event=>void save(event)}><label>客户称呼<input name="display_name" maxLength={80} defaultValue={detail.customer.display_name??''} disabled={scope.role==='viewer'}/></label><label>客户阶段<select aria-label="客户阶段" name="stage" defaultValue={detail.customer.stage} disabled={scope.role==='viewer'}>{customerStages.map(stage=><option key={stage} value={stage}>{stageNames[stage]}</option>)}</select></label>
        <label>负责人<select aria-label="负责人" name="owner" defaultValue={detail.customer.owner_user_id??''} disabled={scope.role==='viewer'}><option value="">待分配</option>{members.filter(member=>member.role!=='viewer').map(member=><option key={member.user_id} value={member.user_id}>{member.user_id===scope.user_id?'我':member.user_id.slice(0,8)} · {member.role==='admin'?'管理员':'操作员'}</option>)}</select></label>
        {scope.role!=='viewer'&&<><label>档案修改依据<input name="reason" required maxLength={500} placeholder="说明阶段或负责人变化的依据"/></label><small className="business-wide">选择退出会停止已绑定身份的新联系。修改回其他阶段不会自动恢复联系资格。</small><button className="button primary" disabled={busy}>保存客户档案</button></>}
      </form>
      {scope.role!=='viewer'&&<form className="customer-note" aria-label="新增跟进备注" onSubmit={event=>void save(event,true)}><label>跟进备注<textarea aria-label="跟进备注" name="note" required maxLength={2000} rows={3} placeholder="记录本次沟通与下一步安排"/></label><button className="button subtle" disabled={busy}>保存跟进备注</button></form>}
      <div className="customer-timeline"><h3>跟进时间线</h3><ol>{detail.events.map(event=><li key={event.id}><strong>{event.event_type==='INQUIRY'?'收到主动咨询':event.event_type==='NOTE'?'跟进备注':'更新客户档案'}</strong><time>{businessTime(event.created_at)}</time>{event.event_type==='NOTE'&&<p>{event.details.text}</p>}{event.event_type==='PROFILE_UPDATED'&&<p>{event.details.reason} · {stageNames[event.details.result.stage]}</p>}</li>)}</ol><p className="muted">显示最近 200 条记录。</p></div>
    </>}
  </section>;
}
