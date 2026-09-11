'use client';
import { cloneElement, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { AdjudicationRecord, Run, Scope, Task } from '@kff/contracts';

const decisions: Record<string, string> = { CONFIRMED_SUCCESS: '人工确认成功', CONFIRMED_FAILURE: '人工确认失败', INCONCLUSIVE: '证据不足，继续待人工' };
const sources: Record<string, string> = { owned_fixture: '本地合成页人工复核', platform_ui: '原生平台界面人工复核', platform_support: '平台支持的书面结论' };
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) { const id = useId(); return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>; }
function localTime() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
export function ActionAdjudication({ run, task, records, role, onSaved }: { run: Run; task: Task; records: AdjudicationRecord[]; role: Scope['role']; onSaved(): Promise<void> }) {
  const [version, setVersion] = useState(run.adjudication_version ?? 0); const [expectedState, setExpectedState] = useState(run.action_state);
  const [decision, setDecision] = useState('INCONCLUSIVE'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>());
  const requestId = (value: unknown) => { const key = JSON.stringify(value); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; };
  const eligible = ['UNKNOWN_OUTCOME', 'NEEDS_HUMAN'].includes(run.action_state ?? '');
  const stale = version !== run.adjudication_version || expectedState !== run.action_state;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice('');
    try {
      const value = { snapshot_hash: task.snapshot_hash, expected_version: version, expected_state: expectedState, decision, evidence: { source: String(form.get('source')), external_account_id: String(form.get('actual_account_id')), content_hash: task.snapshot.content_hash, remote_id: String(form.get('remote_id')).trim() || null, observed_at: new Date(String(form.get('observed_at'))).toISOString(), reference: String(form.get('reference')), failure_basis: decision === 'CONFIRMED_FAILURE' ? String(form.get('failure_basis')) : null, matched_original_submission: decision !== 'INCONCLUSIVE' && form.get('matched') === 'on' }, reason: String(form.get('reason')), confirmation: 'I_REVIEWED_THIS_ORIGINAL_ACTION' };
      const response = await fetch('/api/runs/' + run.id + '/adjudications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, request_id: requestId(value) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? '裁定未保存');
      await onSaved(); setNotice('人工裁定已保存。原动作未重新执行。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '裁定未保存'); } finally { setBusy(false); }
  }
  if (!records.length && (!eligible || role !== 'admin')) return null;
  return <section className="adjudication-panel" aria-label="人工复核与裁定">
    <h3 className="section-label">人工复核与裁定</h3>
    {records.map(record => <article className="adjudication-record" key={record.id}><div><strong>{decisions[record.decision]}</strong><span>第 {record.result_version} 次裁定</span></div><p>{record.reason}</p><dl><div><dt>证据来源</dt><dd>{sources[record.evidence.source]}</dd></div><div><dt>依据</dt><dd>{record.evidence.reference}</dd></div>{record.evidence.remote_id && <div><dt>远端对象</dt><dd>{record.evidence.remote_id}</dd></div>}<div><dt>裁定人 / 记录时间</dt><dd>{record.reviewer_id.slice(0, 8)} · {new Date(record.created_at).toLocaleString('zh-CN', { hour12: false })}</dd></div></dl></article>)}
    {notice && <p role="status" className="adjudication-notice">{notice}</p>}{error && <p role="alert" className="form-error">{error}</p>}
    {eligible && role === 'admin' && <details className="adjudication-form"><summary>登记新的人工裁定</summary>
      <p className="field-hint">核查此账号、内容版本和原提交的结果。“没有查到”只能记为证据不足。最终裁定还需要旧执行上下文已经关闭。</p>
      {stale && <div className="adjudication-stale"><p>结果或裁定记录已更新，请先核对上方最新记录。</p><button type="button" className="button subtle" disabled={busy} onClick={() => { setVersion(run.adjudication_version ?? 0); setExpectedState(run.action_state); setDecision('INCONCLUSIVE'); setError(''); }}>载入最新裁定状态</button></div>}
      <form key={version} onSubmit={event => void submit(event)}><fieldset disabled={busy || stale}>
        <Field label="本次裁定"><select value={decision} onChange={event => setDecision(event.target.value)}><option value="INCONCLUSIVE">证据不足，继续待人工</option><option value="CONFIRMED_SUCCESS">有匹配证据，确认成功</option><option value="CONFIRMED_FAILURE">有平台最终依据，确认失败</option></select></Field>
        <Field label="结果证据来源"><select name="source">{task.snapshot.is_synthetic ? <option value="owned_fixture">本地合成页人工复核</option> : <><option value="platform_ui">原生平台界面人工复核</option><option value="platform_support">平台支持的书面结论</option></>}</select></Field>
        <Field label="证据中实际账号的标识"><input name="actual_account_id" required pattern="[0-9]{1,128}" inputMode="numeric" /></Field>
        <p className="field-hint">指定账号：{task.snapshot.external_account_id}<br />内容版本：{task.snapshot.content_hash}</p>
        {task.snapshot.body && <div className="content-preview"><label>需要核对的原内容</label><p>{task.snapshot.body}</p></div>}
        <Field label="证据中的远端对象 ID"><input name="remote_id" required={decision === 'CONFIRMED_SUCCESS'} maxLength={160} /></Field>
        {decision === 'CONFIRMED_FAILURE' && <Field label="平台最终失败依据"><select name="failure_basis" required defaultValue=""><option value="" disabled>选择已核实的最终结论</option><option value="FINAL_PLATFORM_REJECTION">平台明确最终拒绝了原提交</option><option value="FINAL_PLATFORM_CANCELLATION">平台明确最终取消了原提交</option></select></Field>}
        <Field label="证据核查时间"><input name="observed_at" type="datetime-local" step={1} required defaultValue={localTime()} /></Field>
        <Field label="结果证据出处或记录编号"><input name="reference" required maxLength={300} /></Field>
        <Field label="人工裁定原因"><textarea name="reason" required minLength={10} maxLength={1500} rows={3} /></Field>
        {decision !== 'INCONCLUSIVE' && <label className="contact-checkbox"><input name="matched" type="checkbox" required />已核对账号、内容、时间和对象，证据确实属于原提交</label>}
        <label className="contact-checkbox"><input type="checkbox" required />我已核对以上证据，并确认本次人工裁定</label>
        <button className="button primary" disabled={busy || stale}>保存人工裁定</button>
        <p className="field-hint adjudication-limit">裁定不自动重发、释放环境隔离或处理费用。人工复核记录保留其证据来源，不提升平台自动执行能力。</p>
      </fieldset></form>
    </details>}
  </section>;
}
