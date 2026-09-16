'use client';
import {useState} from 'react';
import type {providerWorkspace} from '@kff/core/acquisition-provider';
import {businessTime} from './business-ui';

type Data=Awaited<ReturnType<typeof providerWorkspace>>;
type Post=(path:string,payload:Record<string,unknown>,message:string)=>Promise<void>;
const labels={NEW:'待筛选',QUALIFIED:'值得跟进',DISMISSED:'已排除',OPTED_OUT:'已退出'};
export function AcquisitionProviderPanel({data,admin,write,busy,connected,post}:{data:Data;admin:boolean;write:boolean;busy:boolean;connected:boolean;post:Post}){
  const [kind,setKind]=useState('COMMENT'),[search,setSearch]=useState(''),[status,setStatus]=useState('ALL');
  const rows=data.prospects.filter(r=>r.kind===kind&&(status==='ALL'||r.state===status)&&[r.body,r.author_name??'',...r.search_keywords].join(' ').toLowerCase().includes(search.toLowerCase()));
  return <section className="business-box acquisition-section" aria-label="真实外部数据">
    <h2>真实外部数据与线索</h2><p>Apify 数据保存在当前品牌的数据库中。公开来源的发现与筛选无需绑定 Facebook 主页；后续联系需单独核实身份和触达依据。</p>
    <div className="business-counts acquisition-provider-counts"><div><span>真实帖子</span><strong>{data.totals.posts}</strong></div><div><span>真实评论</span><strong>{data.totals.comments}</strong></div><div><span>评论者标识去重</span><strong>{data.totals.profiles}</strong></div><div><span>人工标记值得跟进</span><strong>{data.totals.qualified}</strong></div></div>
    {admin&&<details open={!data.sources.length}><summary>连接数据源 / 导入采集批次</summary>
      <div className="acquisition-inline"><button className="button" disabled={busy||!connected} onClick={()=>void post('acquisition/sources/apify',{},'Apify 账号已验证并登记到当前品牌。')}>{data.sources.length?'重新验证 Apify 连接':'登记 Apify 数据源'}</button>{!connected&&<span>先配置 Apify 连接。</span>}{data.sources.map(s=><span key={s.id}>{s.display_name} · 已验证</span>)}</div>
      <form className="acquisition-grid" aria-label="导入 Apify 已完成批次" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void post('acquisition/imports/apify',{source_id:f.get('source'),run_id:String(f.get('run')??'').trim().replace(/^apify-run:/,''),kind:f.get('kind'),retention_days:Number(f.get('retention'))},'批次已入库；重复导入同一运行不会增加记录。');}}>
        <label>数据源<select name="source" required>{data.sources.map(s=><option key={s.id} value={s.id}>{s.display_name}</option>)}</select></label>
        <label>数据类型<select name="kind"><option value="FACEBOOK_POSTS">Facebook 关键词帖子</option><option value="FACEBOOK_COMMENTS">Facebook 评论</option><option value="INSTAGRAM_COMMENTS">Instagram 评论</option></select></label>
        <label>Apify Run ID<input name="run" required maxLength={27} placeholder="已成功结束的运行 ID"/></label>
        <label>保存天数<input name="retention" type="number" min={1} max={30} defaultValue={14} required/></label>
        <button className="button primary" disabled={busy||!data.sources.length}>导入已完成结果</button><p>先导入关键词帖子，再导入对应评论，可保留主题依据。此操作只读取已有结果，不启动付费抓取。</p>
      </form>
    </details>}
    <div className="acquisition-inline"><label>数据类别<select value={kind} onChange={e=>setKind(e.target.value)}><option value="COMMENT">评论线索</option><option value="POST">关键词帖子</option></select></label><label>搜索真实数据<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="关键词、留言、公开昵称"/></label><label>筛选状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">全部</option>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div>
    <p>显示 {rows.length} 条（最多展示最近优先的 500 条）。分数仅用于筛选；“PM”是向原发布者发出的请求。评论者标识不作为 Messenger 收件人使用。</p>
    <div className="acquisition-scroll"><table><thead><tr><th>原文与来源</th><th>公开资料 / 时间</th><th>主题与筛选依据</th><th>状态 / 处理</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><details><summary>{r.body.slice(0,120)||'来源未返回文本'}</summary><p style={{whiteSpace:'pre-wrap'}}>{r.body}</p></details><small><a href={r.source_url} target="_blank" rel="noreferrer">查看{r.kind==='POST'?'原帖':'原评论'}</a>{r.parent_url&&<> · <a href={r.parent_url} target="_blank" rel="noreferrer">查看原帖</a></>}</small></td><td>{r.author_name||'未返回昵称'}{r.profile_url&&<small><a href={r.profile_url} target="_blank" rel="noreferrer">公开资料</a></small>}<small>{businessTime(r.occurred_at)}</small></td><td>{r.search_keywords.join('、')||'主题待核实'} · {r.score} 分<small>{r.score_reason}</small></td><td>{labels[r.state]}{r.review_note&&<small>{r.review_note}</small>}{write&&r.kind==='COMMENT'&&<details><summary>筛选处理</summary><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void post('acquisition/prospects/'+r.id+'/control',{expected_version:r.version,state:f.get('state'),reason:f.get('reason')},'筛选状态已保存。');}}><label>处理状态<select name="state" defaultValue={r.state}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label>筛选备注<input name="reason" required minLength={5} maxLength={500}/></label><button className="button" disabled={busy}>保存筛选</button></form></details>}<small>保存至 {businessTime(r.expires_at)}</small></td></tr>)}</tbody></table>{!rows.length&&<p>暂无符合筛选条件的真实记录。</p>}</div>
    <details><summary>已入库批次（{data.imports.length}）</summary><div className="acquisition-scroll"><table><thead><tr><th>来源类型</th><th>Run ID</th><th>返回 / 去重</th><th>运行费用</th><th>入库时间</th></tr></thead><tbody>{data.imports.map(i=><tr key={i.id}><td>{i.kind==='FACEBOOK_POSTS'?'Facebook 帖子':i.kind==='FACEBOOK_COMMENTS'?'Facebook 评论':'Instagram 评论'}</td><td><a href={'https://console.apify.com/actors/runs/'+i.provider_run_id} target="_blank" rel="noreferrer">{i.provider_run_id}</a></td><td>{i.returned_count} / {i.unique_count}</td><td>{i.usage_usd===null?'未返回':'$'+Number(i.usage_usd).toFixed(5)}</td><td>{businessTime(i.created_at)}</td></tr>)}</tbody></table></div></details>
  </section>;
}
