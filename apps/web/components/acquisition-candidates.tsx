'use client';
import {useRef,useState,type FormEvent} from 'react';
import type {Account} from '@kff/contracts';
import type {CandidateRecord,unifiedAcquisitionCandidates} from '../../../packages/core/src/acquisition-candidates';
import {businessRequest,businessTime} from './business-ui';

type Candidates=ReturnType<typeof unifiedAcquisitionCandidates>;
type Post=(path:string,payload:Record<string,unknown>,message:string)=>Promise<void>;
type Environment={id:string;account_id:string;name:string;browser_configured:boolean};
const states={NEW:'待筛选',QUALIFIED:'值得跟进',DISMISSED:'已排除',OPTED_OUT:'已退出'};
export function AcquisitionCandidates({data,accounts,environments,admin,write,busy,post,onPrepare,onMonitorPrepared}:{data:Candidates;accounts:Account[];environments:Environment[];admin:boolean;write:boolean;busy:boolean;post:Post;onPrepare:(id:string)=>void;onMonitorPrepared:(id:string)=>Promise<void>}){
 const [search,setSearch]=useState(''),[platform,setPlatform]=useState('ALL'),[source,setSource]=useState('ALL'),[status,setStatus]=useState('ALL'),[kind,setKind]=useState('COMMENT'),[minScore,setMinScore]=useState(0),[synthetic,setSynthetic]=useState(false);
 const groups=data.groups.map(group=>({...group,records:group.records.filter(r=>(synthetic||!r.synthetic)&&(platform==='ALL'||r.platform===platform)&&(source==='ALL'||r.source_label===source)&&(status==='ALL'||r.state===status)&&(kind==='ALL'||r.kind===kind)&&r.score>=minScore&&[r.body,r.author??'',...r.keywords].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()))})).filter(g=>g.records.length);
 const accountName=(id:string|null)=>id?accounts.find(a=>a.id===id)?.display_name??'原账号':'外部公开来源';
 return <section className="business-box acquisition-section" aria-label="统一线索筛选">
  <h2>统一线索筛选</h2><p>浏览器和 Apify 的评论使用同一套规则排序。在这里核对原文、来源和状态，再准备后续动作。</p>
  <div className="acquisition-inline">
   <label>搜索内容或公开标识<input value={search} onChange={e=>setSearch(e.target.value)}/></label>
   <label>平台<select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="ALL">全部平台</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label>
   <label>采集来源<select value={source} onChange={e=>setSource(e.target.value)}><option value="ALL">全部来源</option>{['账号浏览器','Apify','Meta API','数据服务','合成验证'].map(s=><option key={s}>{s}</option>)}</select></label>
   <label>记录类型<select value={kind} onChange={e=>setKind(e.target.value)}><option value="COMMENT">评论候选</option><option value="POST">帖子背景</option><option value="ALL">全部记录</option></select></label>
   <label>筛选状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">全部状态</option>{Object.entries(states).map(([s,label])=><option key={s} value={s}>{label}</option>)}</select></label>
   <label>统一评分至少<input type="number" min={0} max={100} value={minScore} onChange={e=>setMinScore(Number(e.target.value))}/></label>
   <label><input type="checkbox" checked={synthetic} onChange={e=>setSynthetic(e.target.checked)}/> 包含合成验证</label>
  </div>
  <p>当前筛选：{groups.length} 组、{groups.reduce((n,g)=>n+g.records.length,0)} 条来源记录。相同公开资料链接归在一组；名字相同不会合并，未核实标识保留在原来源。分组不产生私信联系资格。</p>
  <p className="muted">最多覆盖当前品牌 200 条账号线索和 500 条外部记录，已过期数据不展示。规则分数供人工筛选，不代表购买概率；原记录和审核历史保留。</p>
  <div className="acquisition-scroll"><table aria-label="统一来源候选列表"><thead><tr><th>公开标识与所属账号</th><th>原文和来源</th><th>统一评分</th><th>审核与下一步</th></tr></thead><tbody>{groups.flatMap(g=>g.records.map((r,index)=><tr key={r.key}>
   <td>{index===0&&<><strong>{r.author??'身份待核实'}</strong><small>{g.identity_basis==='PUBLIC_PROFILE_LINK'?'公开资料链接一致':g.identity_basis==='SOURCE_SCOPED_ID'?'仅按原来源标识分组':'无法跨记录核实身份'} · 本组 {g.records.length} 条</small>{g.has_opted_out&&<small>本组有退出记录，请先核实适用范围。</small>}</>}{r.profile_url&&<small><a href={r.profile_url} target="_blank" rel="noreferrer">公开资料</a></small>}<small>{accountName(r.account_id)}</small><small>{r.platform} · {r.source_label}</small></td>
   <td><details><summary>{r.body.slice(0,110)||'未返回原文'}</summary><p style={{whiteSpace:'pre-wrap'}}>{r.body}</p></details><a href={r.source_url} target="_blank" rel="noreferrer">查看原始来源</a>{r.parent_url&&<small><a href={r.parent_url} target="_blank" rel="noreferrer">查看所属帖子</a></small>}<small>{r.time_kind==='DISPLAYED_TIME'?r.source_time+'（页面时间，时区未取得）':businessTime(r.source_time)}</small></td>
   <td><strong>{r.score}</strong><small>{r.score_reason}</small><small>原来源评分：{r.source_score} · {r.keywords.join('、')||'主题待核对'}</small></td>
   <td><strong>{states[r.state]}</strong>{write&&r.kind==='COMMENT'&&<CandidateReview key={r.key+'/'+r.version} record={r} busy={busy} post={post}/>} {write&&r.can_prepare_public_reply&&!g.has_opted_out&&<button className="button small" onClick={()=>onPrepare(r.id)}>核对公开回复草稿</button>}{r.origin==='PROSPECT'&&r.kind==='COMMENT'&&<><small>需用指定账号重新核实原评论，随后才能准备公开回复。</small>{admin&&r.platform==='facebook'&&r.state==='QUALIFIED'&&!g.has_opted_out&&<CandidateVerification key={r.key+'/'+r.version} record={r} accounts={accounts} environments={environments} onSaved={onMonitorPrepared}/>}</>}<small>保留至 {businessTime(r.expires_at)}</small></td>
  </tr>))}</tbody></table>{!groups.length&&<p>没有符合当前筛选的来源记录。</p>}</div>
 </section>;
}
function CandidateVerification({record:r,accounts,environments,onSaved}:{record:CandidateRecord;accounts:Account[];environments:Environment[];onSaved:(id:string)=>Promise<void>}){
 const [selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef<{key:string;request_id:string}|null>(null);
 const choices=accounts.filter(a=>a.platform==='facebook'&&a.account_type==='profile'&&!a.is_synthetic&&environments.some(e=>e.account_id===a.id&&e.browser_configured)),account=choices.find(a=>a.id===selected)??choices[0];
 async function prepare(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!account||busy)return;const f=new FormData(event.currentTarget),value={expected_version:r.version,account_id:account.id,environment_id:f.get('environment'),comment_order:f.get('comment_order')},key=JSON.stringify(value);if(pending.current?.key!==key)pending.current={key,request_id:crypto.randomUUID()};setBusy(true);setError('');try{const result=await businessRequest<{monitor_id:string}>('acquisition/prospects/'+r.id+'/browser-verification',{...value,request_id:pending.current.request_id});pending.current=null;await onSaved(result.monitor_id);}catch(failure){setError(failure instanceof Error?failure.message:'核对来源未准备成功');}finally{setBusy(false);}}
 return <details><summary>用指定账号核对评论</summary><form aria-label="准备外部评论的浏览器核对" onSubmit={e=>void prepare(e)}><label>读取账号<select value={account?.id??''} onChange={e=>setSelected(e.target.value)}>{choices.map(a=><option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label><label>账号环境<select key={account?.id} name="environment" required>{environments.filter(e=>e.account_id===account?.id&&e.browser_configured).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>读取范围<select name="comment_order" defaultValue="VISIBLE_WINDOW"><option value="VISIBLE_WINDOW">当前可见评论窗口（单页）</option><option value="NEWEST">由新到旧的第一页</option></select></label><p className="muted">将准备一个暂停的只读监控。核对来源后扫描一次，找到同一条评论再审核；这一步不会发送内容。</p><button className="button small" disabled={busy||!account}>准备来源核对</button>{error&&<p role="alert">{error}</p>}</form></details>;
}
function CandidateReview({record:r,busy,post}:{record:CandidateRecord;busy:boolean;post:Post}){
 return <details><summary>审核此来源记录</summary><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void post('acquisition/'+(r.origin==='LEAD'?'leads':'prospects')+'/'+r.id+'/control',{expected_version:r.version,state:f.get('state'),reason:f.get('reason')},'已保存本条来源记录的审核。');}}><label>判断<select name="state" defaultValue={r.state}>{Object.entries(states).map(([s,label])=><option key={s} value={s}>{label}</option>)}</select></label><label>依据<input name="reason" minLength={5} maxLength={500} required/></label><button className="button small" disabled={busy}>保存审核</button></form></details>;
}
