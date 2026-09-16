'use client';
import { useEffect, useState } from 'react';
import type { BrowserConfiguration, EnvironmentResult } from '../../../packages/contracts/src/environment';

interface Row {
  id: string; name: string; profile_key: string; state: string; configuration_version: number; browser_configuration: BrowserConfiguration | null;
  display_name: string; external_id: string; agent_name: string; agent_online: boolean; agent_status: string;
  browser_status: string; browser_version: string | null; browser_error_code: string | null; browser_checked_at: string | null;
  command_id: string | null; command_state: string | null; operation: string | null; stop_requested: boolean | null;
  platform: string; account_type: string; is_synthetic: boolean;
  identity_result: EnvironmentResult | null; identity_check_state: string | null;
}
const states: Record<string, string> = { IDLE: '空闲', BUSY: '已占用', QUARANTINED: '等待关闭核实', DISABLED: '已禁用', UNASSESSED: '未检查', STARTING: '启动中', RUNNING: '运行中', CLOSED: '已关闭', UNKNOWN: '关闭状态未知', QUEUED: '等待 Agent', FAILED: '未完成' };
async function api<T>(endpoint: string, value?: unknown): Promise<T> {
  const response = await fetch('/api/' + endpoint, { method: value === undefined ? 'GET' : 'POST', headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value), cache: 'no-store' });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '环境操作暂时不可用'); return data;
}

export function EnvironmentWorkbench({ admin, search }: { admin: boolean; search: string }) {
  const [rows, setRows] = useState<Row[]>([]); const [error, setError] = useState(''); const [notice, setNotice] = useState<{ message: string; commandId?: string | null } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; let pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const data = await api<Row[]>('browser-environments'); if (active) setRows(data); } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : '环境读取失败'); } finally { pending = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 4000); return () => { active = false; clearInterval(timer); };
  }, []);
  async function act(endpoint: string, value: unknown, message: string, watchCommandId?: string | null) {
    setBusy(true); setError(''); setNotice(null);
    try { const result = await api<{ id?: string }>(endpoint, value); setRows(await api<Row[]>('browser-environments')); setNotice({ message, commandId: endpoint.endsWith('/operations') ? result.id : watchCommandId }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '环境操作失败'); }
    finally { setBusy(false); }
  }
  const operation = notice?.commandId ? rows.find(row => row.command_id === notice.commandId) : undefined;
  const noticeMessage = operation?.command_state === 'CLOSED' ? (operation.operation === 'CHECK' ? '环境检查完成，浏览器已确认关闭' : '登录窗口已确认关闭；登录状态仍需核验') : operation?.command_state === 'FAILED' ? '环境操作未完成，请查看该环境的状态与错误信息' : notice?.message;
  const visibleRows = rows.filter(row => (row.name + row.display_name).toLowerCase().includes(search.toLowerCase()));
  return <div className="form-body">
    <p className="muted">登录窗口在绑定的电脑打开。检查浏览器会验证语言和时区；Facebook 个人账号还会读取当前身份入口与个人主页，记录登录状态和操作身份。</p>
    {error && <p className="form-error" role="alert">{error}</p>}{noticeMessage && <p role="status">{noticeMessage}</p>}
    <div className="table-scroll" role="region" aria-label="环境状态与操作，可横向滚动" tabIndex={0}><table aria-label="浏览器环境列表"><thead><tr><th>环境与账号</th><th>执行电脑</th><th>浏览器</th><th>账号核验</th><th>操作</th></tr></thead><tbody>
      {visibleRows.map(row => {
        const occupied = ['BUSY', 'QUARANTINED'].includes(row.state) || ['QUEUED', 'RUNNING', 'QUARANTINED'].includes(row.command_state ?? '');
        return <tr key={row.id}><td><strong>{row.name}</strong><p>{row.display_name}</p><small>配置 v{row.configuration_version} · {states[row.state] ?? row.state}</small></td>
          <td>{row.agent_name}<p>{row.agent_online ? 'Agent 在线' : 'Agent 离线'}</p></td>
          <td>{row.browser_configuration?.driver === 'adspower' ? 'AdsPower · ' + row.browser_configuration.provider_profile_id : row.browser_configuration ? '原生持久 Profile' : '待配置'}<p>{states[row.browser_status] ?? row.browser_status}</p>{row.browser_version && <small>浏览器 {row.browser_version}</small>}{row.browser_checked_at && <p><small>环境检查 {new Date(row.browser_checked_at).toLocaleString()}</small></p>}{row.browser_error_code && <p>{row.browser_error_code}</p>}</td>
          <td><IdentityStatus row={row} /><small>消息收发与采集按各自动作验收</small></td>
          <td>{admin && <div className="toolbar-actions">
            <button className="button small subtle" disabled={busy || occupied || row.state === 'DISABLED' || !row.browser_configuration} onClick={() => void act('environments/' + row.id + '/operations', { operation: 'CHECK', expected_version: row.configuration_version, request_id: crypto.randomUUID() }, '环境检查已排队，结果将由 Agent 回传')}>{row.account_type === 'profile' && row.platform === 'facebook' && !row.is_synthetic ? '检查浏览器与身份' : '检查浏览器'}</button>
            <button className="button small" disabled={busy || occupied || row.state === 'DISABLED' || !row.browser_configuration} onClick={() => void act('environments/' + row.id + '/operations', { operation: 'OPEN_LOGIN', expected_version: row.configuration_version, request_id: crypto.randomUUID() }, '登录窗口已排队；可在执行电脑登录，完成后关闭窗口')}>打开登录窗口</button>
            {occupied && !['QUEUED', 'RUNNING', 'QUARANTINED'].includes(row.command_state ?? '') ? <span>任务占用，请在运行记录处理</span> : occupied ? <button className="button small subtle" disabled={busy || !!row.stop_requested} onClick={() => void act('environments/' + row.id + '/controls', { action: 'STOP', expected_version: row.configuration_version }, '已请求关闭；收到关闭证明后才释放占用', row.command_id)}>{row.stop_requested ? '等待关闭证明' : '停止环境操作'}</button> : <button className="button small subtle" disabled={busy} onClick={() => void act('environments/' + row.id + '/controls', { action: row.state === 'DISABLED' ? 'ENABLE' : 'DISABLE', expected_version: row.configuration_version }, '环境状态已更新')}>{row.state === 'DISABLED' ? '启用' : '禁用'}</button>}
          </div>}</td></tr>;
      })}
    </tbody></table></div>
    {admin && visibleRows.map(row => <EnvironmentConfiguration key={row.id + ':' + row.configuration_version} row={row} busy={busy} save={configuration => act('environments/' + row.id + '/configuration', { expected_version: row.configuration_version, configuration }, '配置已保存；旧任务需要按新版本重新创建和审核')} />)}
  </div>;
}
function IdentityStatus({ row }: { row: Row }) {
  const identity = row.identity_result?.identity;
  if (row.identity_check_state === 'CLOSED' && identity) return <>登录状态：核验时已登录<p>操作身份：{identity.display_name}</p><p><small>{identity.operating_identity_id} · 个人账号</small></p><p><small>核验于 {new Date(identity.observed_at).toLocaleString()}</small></p></>;
  if (['QUEUED', 'RUNNING', 'QUARANTINED'].includes(row.identity_check_state ?? '')) return <>身份核验尚未完成<p>等待本机检查与关闭回执</p></>;
  if (row.identity_result?.outcome === 'BLOCKED') return <>身份核验未通过<p>{row.identity_result.error_code === 'LOGIN_REQUIRED' ? '需要在此环境登录' : row.identity_result.error_code === 'ACCOUNT_MISMATCH' ? '当前操作身份与登记账号不符' : row.identity_result.error_code}</p></>;
  return <>登录状态：尚未核验<p>操作身份：尚未核验</p></>;
}
function EnvironmentConfiguration({ row, busy, save }: { row: Row; busy: boolean; save(configuration: BrowserConfiguration): Promise<void> }) {
  const [driver, setDriver] = useState<'native' | 'adspower'>(row.browser_configuration?.driver ?? 'adspower');
  const occupied = ['BUSY', 'QUARANTINED'].includes(row.state) || ['QUEUED', 'RUNNING', 'QUARANTINED'].includes(row.command_state ?? '');
  return <details className="panel"><summary>配置：{row.name}</summary><form className="form-body" onSubmit={event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save({ driver, provider_profile_id: driver === 'adspower' ? String(form.get('provider_profile_id')) : null, login_account_id: String(form.get('login_account_id')), operating_identity_id: row.external_id, locale: String(form.get('locale')), timezone_id: String(form.get('timezone_id')), proxy_ref: driver === 'native' && form.get('proxy_ref') ? String(form.get('proxy_ref')) : null });
  }}><fieldset disabled={busy || occupied}><div className="form-grid">
    <label>环境类型<select value={driver} onChange={event => setDriver(event.target.value as 'native' | 'adspower')}><option value="adspower">AdsPower</option><option value="native">原生持久 Profile</option></select></label>
    {driver === 'adspower' && <label>AdsPower Profile ID<input name="provider_profile_id" defaultValue={row.browser_configuration?.provider_profile_id ?? ''} pattern="[A-Za-z0-9_\-]+" required maxLength={100} /></label>}
    <label>登录账户 ID<input name="login_account_id" defaultValue={row.browser_configuration?.login_account_id ?? row.external_id} pattern="[0-9]+" maxLength={128} required /></label>
    <label>实际操作身份<input value={row.external_id} readOnly /></label>
    <label>语言<input name="locale" defaultValue={row.browser_configuration?.locale ?? 'en-US'} required maxLength={40} /></label>
    <label>时区<input name="timezone_id" defaultValue={row.browser_configuration?.timezone_id ?? 'America/New_York'} required maxLength={80} /></label>
    {driver === 'native' && <label>本机代理配置引用（可留空）<input name="proxy_ref" defaultValue={row.browser_configuration?.proxy_ref ?? ''} placeholder="KFF_BROWSER_PROXY_US01" /></label>}
  </div><p className="muted">{driver === 'adspower' ? '代理及底层指纹在 AdsPower 配置。此处登记预期语言和时区供检查；API 密钥只保存在执行电脑。' : '目录由 Agent 管理。配置代理引用后，缺少代理或连接失败时停止，不自动改为直连。'}</p><button className="button" type="submit">保存环境配置</button></fieldset></form></details>;
}
