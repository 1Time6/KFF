'use client';
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { TemplateVersion, TemplatePreview } from '@kff/contracts';
import type { Workspace } from '@kff/core/service';

const states: Record<string, string> = { DRAFT: '待预演', ALLOWED: '允许使用', DISABLED: '已停用', DEPRECATED: '已弃用' };
const steps: Record<string, string> = { validate_input: '检查输入与版本', verify_identity: '核对实际账号', prepare_content: '准备已审核内容', submit_once: '提交前复核，单次提交', verify_original: '核验原提交的结果' };
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) { const id = useId(); return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>; }
async function api<T>(endpoint: string, input?: unknown): Promise<T> {
  const response = await fetch('/api/' + endpoint, { method: input === undefined ? 'GET' : 'POST', headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), cache: 'no-store' });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '模板记录无法读取'); return data;
}
export function TemplateWorkbench({ data }: { data: Workspace }) {
  const [records, setRecords] = useState<{ versions: TemplateVersion[]; previews: TemplatePreview[] }>({ versions: [], previews: [] });
  const [selectedId, setSelectedId] = useState(''); const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [reason, setReason] = useState('');
  const requests = useRef(new Map<string, string>());
  const requestId = (value: unknown) => { const key = JSON.stringify(value); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; };
  const load = useCallback(async () => { const result = await api<typeof records>('templates'); setRecords(result); setSelectedId(previous => result.versions.some(version => version.id === previous) ? previous : result.versions[0]?.id ?? ''); }, []);
  useEffect(() => { void load().catch(failure => setError(failure instanceof Error ? failure.message : '模板读取失败')); }, [load]);
  const selected = records.versions.find(version => version.id === selectedId);
  const accounts = data.accounts.filter(account => data.capabilities.some(capability => capability.account_id === account.id && capability.capability_key === selected?.capability_key));
  const actualAccount = accounts.find(account => account.id === accountId) ?? accounts[0];
  const capability = data.capabilities.find(value => value.account_id === actualAccount?.id && value.capability_key === selected?.capability_key);
  const latestPreview = records.previews.find(preview => preview.template_version_id === selectedId);
  async function act(operation: () => Promise<void>, message: string) { setBusy(true); setError(''); setNotice(''); try { await operation(); await load(); setNotice(message); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成'); } finally { setBusy(false); } }
  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; const form = new FormData(event.currentTarget);
    await act(async () => { const value = { based_on_version_id: selected.id, name: String(form.get('name')), version_label: String(form.get('version_label')), max_body_length: Number(form.get('max_body_length')), reason: String(form.get('reason')) }; const result = await api<TemplateVersion>('templates', { ...value, request_id: requestId(value) }); setSelectedId(result.id); setReason(''); }, '新版本已保存，请预演后决定是否允许使用');
  }
  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !actualAccount || !capability) return; const form = new FormData(event.currentTarget);
    await act(async () => { const value = { account_id: actualAccount.id, environment_id: String(form.get('environment_id')), capability_id: capability.id, body: String(form.get('body')) }; await api('templates/' + selected.id + '/previews', { ...value, request_id: requestId({ version_id: selected.id, ...value }) }); }, '预演已保存；平台身份与执行授权仍需实际核对');
  }
  async function policy(action: 'ALLOW' | 'DISABLE' | 'DEPRECATE') {
    if (!selected) return;
    await act(async () => { const value = { expected_policy_version: selected.policy_version, action, reason }; await api('templates/' + selected.id + '/policy', { ...value, request_id: requestId({ version_id: selected.id, ...value }) }); }, action === 'DEPRECATE' ? '已弃用此版本；原有结果仍可核验' : action === 'DISABLE' ? '已停用此版本，阻止后续新提交' : '此版本已加入允许使用的集合');
  }
  return <div className="template-workbench">
    {error && <p role="alert" className="alert error">{error}</p>}{notice && <p role="status" className="alert warning">{notice}</p>}
    <section className="panel"><div className="panel-head"><h2>模板版本</h2><button className="text-button" disabled={busy} onClick={() => void act(load, '模板记录已刷新')}>刷新模板记录</button></div>
      <div className="table-scroll"><table aria-label="模板版本列表"><thead><tr><th>模板</th><th>版本</th><th>状态</th><th>输入上限</th></tr></thead><tbody>{records.versions.map(version => <tr key={version.id} className={selectedId === version.id ? 'template-selected' : ''}><td><button className="text-button strong" onClick={() => { setSelectedId(version.id); setReason(''); setNotice(''); }}>{version.name}</button><small>{version.capability_key.startsWith('kff.fixture.') ? '本地合成主页' : 'Facebook 主页'} · {version.capability_key.includes('.publish.') ? '文本发布' : '身份读取'}</small></td><td>{version.version_label}<small>版本 {version.version_number}</small></td><td>{states[version.state]}</td><td>{version.manifest.input.max_body_length}</td></tr>)}</tbody></table></div>
      <div className="panel-footer"><span>当前品牌 · 最多展示最近 200 个版本 · 已批准任务保留原版本</span></div>
    </section>
    {selected && <section className="panel template-detail" aria-label="选中模板版本"><div className="panel-head"><h2>{selected.name}</h2><span>{selected.version_label} · {states[selected.state]}</span></div>
      <div className="template-layout"><div className="template-definition"><h3>此版本的执行步骤</h3><ol>{selected.manifest.steps.map(step => <li key={step}>{steps[step]}</li>)}</ol><p>输入上限 {selected.manifest.input.max_body_length}，{selected.manifest.input.body_required ? '发布内容必填' : '此动作不发布内容'}。</p><p>外部提交发生后结果不确定时，保留原动作并核验。</p><div className="template-hash"><span>版本摘要</span><code>{selected.manifest_hash}</code></div>
        {data.scope.role === 'admin' && <div className="template-policy"><h3>版本使用策略</h3><p className="field-hint">允许模板不会提升账号或平台能力。弃用后需要创建新版本，历史结果与裁定记录保留。</p>{selected.state !== 'DEPRECATED' ? <><Field label="模板策略调整原因"><input value={reason} onChange={event => setReason(event.target.value)} required minLength={5} maxLength={300} disabled={busy} /></Field><div className="contact-actions"><button className="button primary" disabled={busy || reason.trim().length < 5 || selected.state === 'ALLOWED'} onClick={() => void policy('ALLOW')}>允许此版本</button><button className="button subtle" disabled={busy || reason.trim().length < 5 || selected.state === 'DISABLED'} onClick={() => void policy('DISABLE')}>停用此版本</button><button className="button danger" disabled={busy || reason.trim().length < 5} onClick={() => void policy('DEPRECATE')}>弃用此版本</button></div></> : <p>此版本已永久弃用，可从它派生新版本。</p>}</div>}
      </div><div className="template-forms">
        <h3>输入与关联预演</h3><p className="field-hint">预演不连接平台，也不发送或发布。下方分别显示本地检查和未检查条件。</p>
        {data.scope.role !== 'viewer' && <form key={'preview/' + selected.id} onSubmit={event => void preview(event)}><fieldset disabled={busy || !actualAccount || !capability}>
          <Field label="预演账号"><select value={actualAccount?.id ?? ''} required onChange={event => setAccountId(event.target.value)}>{accounts.length ? accounts.map(account => <option key={account.id} value={account.id}>{account.display_name}</option>) : <option value="">尚无匹配账号</option>}</select></Field>
          <Field label="预演环境"><select key={actualAccount?.id} name="environment_id" required defaultValue=""><option value="" disabled>选择绑定环境</option>{data.environments.filter(environment => environment.account_id === actualAccount?.id).map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></Field>
          <Field label="预演输入内容"><textarea name="body" required={selected.manifest.input.body_required} maxLength={selected.manifest.input.max_body_length} rows={3} /></Field><button className="button subtle" disabled={busy || !actualAccount || !capability}>运行输入预演</button>
        </fieldset></form>}
        {latestPreview && <div className="template-preview" role="region" aria-label="模板预演结果"><strong>{latestPreview.can_enable ? '输入与关联检查通过' : '输入与关联需要修正'}</strong>{latestPreview.result.checks.map(check => <div key={check.code}><span className={'template-check ' + check.state.toLowerCase()}>{check.state === 'PASS' ? '已检查' : check.state === 'FAIL' ? '需处理' : '未检查'}</span><p>{check.message}</p></div>)}<small>核对时间：{new Date(latestPreview.created_at).toLocaleString('zh-CN', { hour12: false })}</small></div>}
        {data.scope.role === 'admin' && <details className="template-create"><summary>从此版本派生新版本</summary><form key={'create/' + selected.id} onSubmit={event => void createVersion(event)}><fieldset disabled={busy}>
          <Field label="新模板名称"><input name="name" required maxLength={100} defaultValue={selected.name} /></Field><Field label="新版本标签"><input name="version_label" required maxLength={40} pattern="[A-Za-z0-9._-]{1,40}" placeholder="例如 v2" /></Field><Field label="新版本输入上限"><input name="max_body_length" type="number" min={1} max={5000} step={1} required defaultValue={selected.manifest.input.max_body_length} /></Field><Field label="新版本变更原因"><input name="reason" required minLength={5} maxLength={300} /></Field><button className="button primary" disabled={busy}>保存新模板版本</button>
        </fieldset></form></details>}
      </div></div>
    </section>}
  </div>;
}
