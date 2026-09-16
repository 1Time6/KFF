'use client';
import { useEffect, useState } from 'react';
import type { Workspace } from '@kff/core/service';
import type { browserInboxWorkspace, BrowserInboxMonitor } from '@kff/core/browser-inbox';
import { businessRequest, businessTime } from './business-ui';
import { useRequestKey } from './use-request-key';

type State = Awaited<ReturnType<typeof browserInboxWorkspace>>;
export function BrowserInboxSetup({ data }: { data: Workspace }) {
  const [state, setState] = useState<State | null>(null), [environmentId, setEnvironmentId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requestKey = useRequestKey();
  const [modeChoice,setModeChoice]=useState<'FIXED'|'RECENT_ACCEPTED'|null>(null);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => { try { const result = await businessRequest<State>('browser-inbox'); if (!stopped) setState(result); } catch (failure) { if (!stopped) setError(failure instanceof Error ? failure.message : '收件监控读取失败'); } finally { if (!stopped) timer = setTimeout(() => void load(), 5000); } };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const environments = data.environments.filter(e => data.accounts.some(a => a.id === e.account_id && a.platform === 'facebook' && (a.is_synthetic ? e.browser_configuration?.driver === 'native' : a.account_type === 'profile' && e.browser_configuration?.driver === 'adspower')));
  const selected = environments.find(e => e.id === environmentId), monitor = state?.monitors.find(m => m.account_id === selected?.account_id);
  const real = Boolean(selected && data.accounts.some(a=>a.id===selected.account_id&&!a.is_synthetic));
  const locked = Boolean(monitor && (monitor.current_task_id || monitor.scan_requested || monitor.state === 'ACTIVE'));
  const readMode=modeChoice??(monitor?.binding.target?'FIXED':'RECENT_ACCEPTED');
  async function act(endpoint: string, payload: Record<string, unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await businessRequest(endpoint, { request_id: requestKey.forPayload({ endpoint, ...payload }), ...payload }); requestKey.confirmed(); setState(await businessRequest<State>('browser-inbox')); setNotice(message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成'); } finally { setBusy(false); }
  }
  const control = (m: BrowserInboxMonitor, action: 'SCAN' | 'START' | 'PAUSE') => act('browser-inbox/monitors/' + m.id + '/control', { expected_version: m.version, action }, action === 'PAUSE' ? '收件监控已暂停' : action === 'START' ? '收件监控已启动' : '已安排收件读取');
  return <details className="business-box channel-settings"><summary>浏览器收件 <span>{state?.monitors.length ?? 0} 个监控</span></summary>
    <p className="muted">读取可见文字消息，重复读取会自动去重。可指定一个会话，或从聊天列表发现最近的已接受会话；会逐条核对发送者主页。目前仅支持中文界面，不自动接受消息请求。</p>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {state?.monitors.map(m => <section className="business-box" key={m.id} aria-label={'收件监控 ' + m.id}>
      <h3>{data.accounts.find(a => a.id === m.account_id)?.display_name ?? '账号'}</h3>{m.binding.target&&<p>指定会话：{m.binding.target.display_name} · {m.binding.target.thread_id}</p>}
      {m.binding.discovery&&<p>发现最近已接受会话 · 每次最多 {m.binding.discovery.max_threads} 个；仅本次可见窗口。</p>}
      {m.binding.discovery&&state.reads.find(r=>r.monitor_id===m.id)&&(()=>{const d=state.reads.find(r=>r.monitor_id===m.id)!.discovery;return <p className="muted">最近发现：核实 {d.threads.length} 个会话，{d.skipped.length} 个需人工查看，{d.unparsed_rows} 个列表项未识别。{d.empty_list?'当前列表明确显示没有聊天。':d.window_limited?'本次仅取得部分结果。':''}</p>;})()}
      <p>{m.current_task_id ? '收件执行中或等待关闭确认' : m.scan_requested ? '等待收件读取' : m.state === 'ACTIVE' ? '持续收件中' : '已暂停'} · 每 {m.interval_seconds} 秒检查 · 每页最多 {m.page_size} 条</p>
      <p className="muted">最近读取：{m.last_polled_at ? businessTime(m.last_polled_at) : '尚未读取'}{m.last_error_code ? ' · 停止原因：' + m.last_error_code : ''}</p>
      {m.last_error_code==='MESSENGER_SETUP_REQUIRED'&&<p role="alert">Messenger 要求本人完成加密聊天设置。请在该账号的原 AdsPower 窗口处理，PIN 不用填写到 KFF。</p>}
      {data.scope.role === 'admin' && <div className="button-row">
        <button className="button" disabled={busy || Boolean(m.current_task_id) || m.scan_requested || m.state === 'ACTIVE'} onClick={() => void control(m, 'SCAN')}>读取一次</button>
        <button className="button" disabled={busy || Boolean(m.current_task_id) || m.scan_requested || m.state === 'ACTIVE'} onClick={() => void control(m, 'START')}>持续收件</button>
        <button className="button subtle" disabled={busy || m.state === 'PAUSED' && !m.scan_requested && !m.current_task_id} onClick={() => void control(m, 'PAUSE')}>暂停收件</button>
      </div>}
    </section>)}
    {data.scope.role === 'admin' && <form aria-label="配置浏览器收件" className="business-form" key={environmentId + ':' + (monitor?.version ?? 0)} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void act('browser-inbox/monitors', { environment_id: environmentId, ...(real?readMode==='FIXED'?{target:{thread_id:fields.get('thread_id'),peer_id:fields.get('peer_id'),display_name:fields.get('display_name')}}:{discovery:{strategy:'RECENT_ACCEPTED',max_threads:Number(fields.get('max_threads'))}}:{}), expected_version: monitor?.version ?? 0, interval_seconds: Number(fields.get('interval_seconds')), page_size: Number(fields.get('page_size')), raw_retention_hours: Number(fields.get('raw_retention_hours')) }, '收件监控已保存并保持暂停');
    }}>
      <label>收件环境<select value={environmentId} onChange={event => {setEnvironmentId(event.target.value);setModeChoice(null);}} required><option value="" disabled>选择已配置的 Facebook 环境</option>{environments.map(e => <option key={e.id} value={e.id}>{data.accounts.find(a => a.id === e.account_id)?.display_name} · {e.name}</option>)}</select></label>
      {real&&<label>读取范围<select value={readMode} onChange={e=>setModeChoice(e.target.value as 'FIXED'|'RECENT_ACCEPTED')} disabled={locked}><option value="RECENT_ACCEPTED">发现最近已接受的会话</option><option value="FIXED">指定一个已接受会话</option></select></label>}
      {real&&readMode==='RECENT_ACCEPTED'&&<><label>每次会话上限<input name="max_threads" type="number" min={1} max={3} defaultValue={monitor?.binding.discovery?.max_threads??3} required disabled={locked}/></label><p className="muted business-wide">按当前聊天列表顺序核对，合计受消息上限约束。未接受请求或无法明确核实身份的会话会停下或标记待查看；会话类型仍需核对，读到新消息不会自动生成发送权限。</p></>}
      {real&&readMode==='FIXED'&&<><label>会话 ID<input name="thread_id" pattern="[0-9]{1,128}" defaultValue={monitor?.binding.target?.thread_id} required disabled={locked}/></label><label>发送者个人主页 ID<input name="peer_id" pattern="[0-9]{1,128}" defaultValue={monitor?.binding.target?.peer_id} required disabled={locked}/></label><label>发送者显示名称<input name="display_name" maxLength={80} defaultValue={monitor?.binding.target?.display_name} required disabled={locked}/></label><p className="muted business-wide">先在 Facebook 核对并接受该会话。读取时会再次核对账号身份与每条消息的发送者主页。</p></>}
      <label>检查间隔（秒）<input type="number" name="interval_seconds" min={10} max={3600} defaultValue={monitor?.interval_seconds ?? 60} required disabled={locked}/></label>
      <label>每页消息上限<input type="number" name="page_size" min={1} max={50} defaultValue={monitor?.page_size ?? 25} required disabled={locked}/></label>
      <label>未入库回执保留（小时）<input type="number" name="raw_retention_hours" min={1} max={24} defaultValue={monitor?.raw_retention_hours ?? 1} required disabled={locked}/></label>
      <button className="button primary" disabled={busy || !selected || locked}>{monitor ? '更新收件监控' : '保存收件监控'}</button>
      {!environments.length && <p className="muted business-wide">先在环境中心配置 Facebook 浏览器环境。</p>}
    </form>}
  </details>;
}
