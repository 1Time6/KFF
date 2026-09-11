'use client';
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { CostBalance, CostWorkspace, Scope } from '@kff/contracts';

const names: Record<string, string> = { RESERVED: '费用已预占', PENDING_RECONCILIATION: '待核账', SETTLED: '已结算', RELEASED: '零费用已释放', LIMIT_SET: '预算已登记', ADJUSTED: '差异已调整' };
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) { const id = useId(); return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>; }
function amount(value: string | null, balance?: CostBalance) {
  if (value === null) return '尚未登记';
  if (balance?.minor_unit_exponent === null || balance?.minor_unit_exponent === undefined) return value + ' 最小单位';
  const negative = value.startsWith('-'); const digits = (negative ? value.slice(1) : value).padStart(balance.minor_unit_exponent + 1, '0');
  const precision = balance.minor_unit_exponent;
  return (negative ? '-' : '') + (precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits);
}
async function api<T>(endpoint: string, input?: unknown): Promise<T> {
  const response = await fetch('/api/' + endpoint, { method: input === undefined ? 'GET' : 'POST', headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), cache: 'no-store' });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '费用记录暂时无法读取'); return data;
}

export function CostLedger({ role }: { role: Scope['role'] }) {
  const [records, setRecords] = useState<CostWorkspace | null>(null); const [currency, setCurrency] = useState('');
  const [actionId, setActionId] = useState(''); const [decision, setDecision] = useState('SETTLE');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>());
  const requestId = (value: unknown) => { const key = JSON.stringify(value); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; };
  const load = useCallback(async () => setRecords(await api<CostWorkspace>('costs')), []);
  useEffect(() => { void load().catch(failure => setError(failure instanceof Error ? failure.message : '无法加载费用')); }, [load]);
  const existing = records?.balances.find(row => row.currency === currency); const selected = records?.reservations.find(row => row.action_id === actionId);
  const pending = selected && ['RESERVED', 'PENDING_RECONCILIATION'].includes(selected.state);
  async function act(operation: () => Promise<void>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); await load(); setNotice(message); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成'); } finally { setBusy(false); }
  }
  async function saveBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await act(async () => {
      const value = { expected_version: existing?.version ?? 0, currency, minor_unit_exponent: Number(form.get('exponent')), precision_source: String(form.get('precision_source')), limit_minor: String(form.get('limit')), reason: String(form.get('reason')) };
      await api('cost-budgets', { ...value, request_id: requestId(value) });
    }, '预算已保存');
  }
  async function saveReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; const form = new FormData(event.currentTarget);
    await act(async () => {
      const value = { expected_version: selected.version, decision, actual_cost_minor: decision === 'PENDING' ? null : decision === 'RELEASE' ? '0' : String(form.get('actual')), evidence_ref: String(form.get('evidence_ref')), note: String(form.get('note')), confirmation: 'I_RECONCILED_THIS_COST' };
      await api('costs/' + selected.action_id + '/reconciliation', { ...value, request_id: requestId({ action_id: selected.action_id, ...value }) });
      setActionId('');
    }, '核账记录已保存，试验次数保持不变');
  }
  return <section className="panel cost-ledger" aria-label="费用与预算">
    <div className="panel-head"><h2>费用与预算</h2><button className="text-button" disabled={busy} onClick={() => void act(load, '费用记录已刷新')}>刷新费用记录</button></div>
    <p className="cost-intro">各币种分别记账。待核账费用保留预占，实际金额不会按零计算。此处保存费用依据，付款由对应渠道处理。</p>
    {error && <p className="form-error cost-message" role="alert">{error}</p>}{notice && <p className="cost-message" role="status">{notice}</p>}
    {records ? <>
      {records.balances.length ? <div className="table-scroll"><table aria-label="币种预算"><thead><tr><th>币种</th><th>预算</th><th>预占</th><th>已确认费用</th><th>待核账</th><th>剩余预算</th></tr></thead><tbody>{records.balances.map(row => <tr key={row.currency}><td><strong>{row.currency}</strong><small>{row.minor_unit_exponent === null ? '记账精度待登记' : '小数位数 ' + row.minor_unit_exponent}</small></td><td>{amount(row.limit_minor, row)}</td><td>{amount(row.held_minor, row)}</td><td>{amount(row.confirmed_minor, row)}</td><td>{row.pending_count} 项</td><td>{amount(row.available_minor, row)}</td></tr>)}</tbody></table></div> : <p className="cost-intro">尚未登记预算。受控试验需要先确定币种、精度和费用上限。</p>}
      {role === 'admin' && <details className="cost-form-section"><summary>登记或调整预算</summary><form onSubmit={event => void saveBudget(event)}><fieldset disabled={busy}>
        <div className="form-grid"><Field label="预算币种代码"><input value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())} required pattern="[A-Z]{3}" maxLength={3} placeholder="按费用依据填写，如 USD" /></Field><Field label="币种小数位数"><input key={currency + (existing?.version ?? 0)} name="exponent" type="number" min={0} max={6} step={1} required defaultValue={existing?.minor_unit_exponent ?? ''} readOnly={existing?.minor_unit_exponent != null} /></Field></div>
        <p className="field-hint">小数位数为 2 时，100 个最小单位记为 1.00；为 0 时记为 100。已有账目沿用原精度。</p>
        <Field label="币种精度依据"><input key={'source/' + currency + (existing?.version ?? 0)} name="precision_source" required minLength={5} maxLength={300} defaultValue={existing?.precision_source ?? ''} /></Field>
        <Field label="预算上限（最小单位）"><input key={'limit/' + currency + (existing?.version ?? 0)} name="limit" required pattern="0|[1-9][0-9]{0,14}" inputMode="numeric" defaultValue={existing?.limit_minor ?? ''} /></Field>
        <Field label="预算设置原因"><input name="reason" required minLength={5} maxLength={300} /></Field><button className="button primary" disabled={busy}>保存预算</button>
      </fieldset></form></details>}
      <div className="panel-head cost-subhead"><h2>动作费用</h2><span>最近 200 条</span></div>
      {records.reservations.length ? <div className="table-scroll"><table aria-label="动作费用"><thead><tr><th>任务 / 动作</th><th>币种</th><th>原预占</th><th>实际费用</th><th>费用状态</th></tr></thead><tbody>{records.reservations.map(row => { const balance = records.balances.find(value => value.currency === row.currency); return <tr key={row.action_id}><td><strong>{row.title}</strong><small className="mono">{row.action_id.slice(0, 8)}</small></td><td>{row.currency}</td><td>{amount(row.reserved_minor, balance)}</td><td>{row.actual_cost_minor === null ? '待核账' : amount(row.actual_cost_minor, balance)}</td><td>{names[row.state]}</td></tr>; })}</tbody></table></div> : <p className="cost-intro">尚无动作费用预占。</p>}
      {role === 'admin' && records.reservations.length > 0 && <div className="cost-form-section">
        <Field label="选择核账动作"><select disabled={busy} value={actionId} onChange={event => { setActionId(event.target.value); const row = records.reservations.find(value => value.action_id === event.target.value); setDecision(row && ['SETTLED', 'RELEASED'].includes(row.state) ? 'ADJUST' : 'SETTLE'); setNotice(''); }}><option value="">选择一条费用记录</option>{records.reservations.map(row => <option key={row.action_id} value={row.action_id}>{row.title} · {row.action_id.slice(0, 8)} · {row.currency} · {names[row.state]}</option>)}</select></Field>
        {selected && <form key={selected.action_id} onSubmit={event => void saveReconciliation(event)}><fieldset disabled={busy}>
          <p className="field-hint cost-basis">原费用依据：{selected.cost_basis}。记录版本 {selected.version}。</p>
          <Field label="核账处理"><select value={decision} onChange={event => setDecision(event.target.value)}>{pending ? <><option value="SETTLE">按实际费用结算</option><option value="RELEASE">确认零费用并释放预占</option><option value="PENDING">保留预占，继续待核账</option></> : <option value="ADJUST">调整已确认费用</option>}</select></Field>
          {['SETTLE', 'ADJUST'].includes(decision) ? <Field label={'实际费用总额（' + selected.currency + ' 最小单位）'}><input name="actual" required pattern="0|[1-9][0-9]{0,14}" inputMode="numeric" /></Field> : <p className="field-hint">{decision === 'RELEASE' ? '仅在确认实际总费用为零后释放预占。' : '实际费用保持未知，继续保留原预占。'}</p>}
          <Field label="账单或核查依据"><input name="evidence_ref" required maxLength={300} /></Field><Field label="核账说明"><textarea name="note" required minLength={10} maxLength={1000} rows={3} /></Field>
          <label className="contact-checkbox"><input type="checkbox" required />已核对本动作的费用依据与处理结果</label>
          <button className="button primary" disabled={busy}>保存核账记录</button>
          <p className="field-hint cost-limit">在途动作须先结束并确认执行上下文已关闭。费用核账保留原试验次数和动作结果；差异调整填写更正后的总额。</p>
        </fieldset></form>}
      </div>}
      <details className="cost-event-section"><summary>费用事件 · 最近 {records.entries.length} 条</summary><div className="table-scroll"><table aria-label="费用事件"><thead><tr><th>记录</th><th>币种</th><th>依据</th><th>时间</th></tr></thead><tbody>{records.entries.map(row => <tr key={row.id}><td>{names[row.event_type]}<small className="mono">{row.id.slice(0, 8)}</small></td><td>{row.currency}</td><td className="cost-evidence">{row.details.evidence_ref ?? row.details.reason ?? '动作费用预占'}</td><td>{new Date(row.created_at).toLocaleString('zh-CN', { hour12: false })}</td></tr>)}</tbody></table></div></details>
      <div className="panel-footer"><span>仅当前品牌 · 余额包含全部账目，明细展示最近 200 条</span></div>
    </> : <p className="cost-intro">正在读取费用台账…</p>}
  </section>;
}
