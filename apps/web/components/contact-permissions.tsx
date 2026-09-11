'use client';
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Account, Scope } from '@kff/contracts';
import type { z } from 'zod';
import type { contactPolicy } from '@kff/contracts';

interface Target { id: string; account_id: string; remote_id: string; opted_out: boolean; version: number }
interface Permission { id: string; target_id: string; purpose: 'customer_service' | 'marketing'; revoked_at: string | null; policy: z.infer<typeof contactPolicy> }
interface Records { targets: Target[]; permissions: Permission[] }
const reasonNames: Record<string, string> = { CONTACT_OPTED_OUT: '目标已退出联系', ACCOUNT_UNAVAILABLE: '账号尚未连接或已停用', STOP_REQUESTED: '账号、品牌或组织已暂停', CONTACT_BASIS_REVOKED: '依据已撤销', CONTACT_BASIS_STALE: '退出或重新同意后，旧依据已失效', CONTACT_PURPOSE_MISMATCH: '依据用途不匹配', CONTACT_SOURCE_UNKNOWN: '来源用途尚未核实', CONTACT_SOURCE_DENIED: '来源不允许此用途', CONTACT_BASIS_EXPIRED: '依据尚未生效或已到期', CONTACT_WINDOW_UNKNOWN: '联系窗口规则尚未核实', CONTACT_WINDOW_EXPIRED: '联系窗口已到期', CONTACT_SELECTION_STALE: '先前选择已失效' };
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) { const id = useId(); return <div className="field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>; }
async function api<T>(endpoint: string, value?: unknown): Promise<T> {
  const response = await fetch('/api/' + endpoint, { method: value === undefined ? 'GET' : 'POST', headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value), cache: 'no-store' });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? '联系记录暂时无法读取'); return body;
}
export function ContactPermissions({ account, role }: { account: Account; role: Scope['role'] }) {
  const [records, setRecords] = useState<Records>({ targets: [], permissions: [] }); const [targetId, setTargetId] = useState(''); const [permissionId, setPermissionId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [reason, setReason] = useState('');
  const [basis, setBasis] = useState<'inbound_inquiry' | 'explicit_consent'>('inbound_inquiry'); const [purpose, setPurpose] = useState<'customer_service' | 'marketing'>('customer_service');
  const [windowRule, setWindowRule] = useState<'EXPLICIT_END' | 'NOT_REQUIRED' | 'UNKNOWN'>('EXPLICIT_END');
  const [review, setReview] = useState<{ basis_eligible: boolean; reason_codes: string[] } | null>(null);
  const requests = useRef(new Map<string, string>());
  const requestId = (value: unknown) => { const key = JSON.stringify(value); if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; };
  const load = useCallback(async () => { const value = await api<Records>('contacts'); setRecords({ targets: value.targets.filter(target => target.account_id === account.id), permissions: value.permissions }); }, [account.id]);
  useEffect(() => { void load().catch(failure => setError(failure instanceof Error ? failure.message : '无法加载记录')); }, [load]);
  const target = records.targets.find(value => value.id === targetId); const permissions = records.permissions.filter(value => value.target_id === targetId);
  async function act(operation: () => Promise<void>) { setBusy(true); setError(''); setReview(null); try { await operation(); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成'); } finally { setBusy(false); } }
  async function savePermission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const date = (key: string) => new Date(String(form.get(key))).toISOString();
    await act(async () => {
      const value = { target_id: targetId, resume_opt_out: form.get('resume') === 'on', policy: { basis_type: basis, purpose, source_type: 'manual_record', source_ref: String(form.get('source_ref')), source_observed_at: date('observed_at'), source_use_status: form.get('confirmed') === 'on' ? 'CONFIRMED' : 'UNKNOWN', starts_at: date('starts_at'), expires_at: date('expires_at'), policy_ref: String(form.get('policy_ref')), window_rule: windowRule, window_expires_at: windowRule === 'EXPLICIT_END' ? date('window_expires_at') : null, evidence_note: String(form.get('evidence_note')) } };
      const permission = await api<Permission>('contacts/permissions', { ...value, request_id: requestId(value) }); setPermissionId(permission.id);
    });
  }
  return <div className="form-body contact-manager">
    <p className="field-hint">记录联系依据和退出状态。发送还需完成对应渠道、内容审核、预算与执行检查。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    <form className="contact-target-create" onSubmit={event => { event.preventDefault(); const remoteId = String(new FormData(event.currentTarget).get('remote_id')); void act(async () => { const created = await api<Target>('contacts', { account_id: account.id, channel: account.is_synthetic ? 'synthetic' : 'facebook_messenger', remote_id: remoteId }); setTargetId(created.id); setPermissionId(''); }); }}>
      <Field label="目标在此账号下的标识"><input name="remote_id" required maxLength={160} pattern={account.is_synthetic ? '[A-Za-z0-9_:+.@\\-]{1,160}' : '[0-9]{1,128}'} disabled={busy || role === 'viewer'} /></Field>
      <button className="button subtle" disabled={busy || role === 'viewer'}>登记联系目标</button>
    </form>
    <Field label="查看联系目标"><select disabled={busy} value={targetId} onChange={event => { setTargetId(event.target.value); setPermissionId(''); setReview(null); }}><option value="">选择已登记目标</option>{records.targets.map(value => <option key={value.id} value={value.id}>{value.remote_id}</option>)}</select></Field>
    {target && <>
      <div className="contact-target-state"><strong>{target.opted_out ? '已退出联系' : '尚未记录退出'}</strong><button className="text-button" disabled={busy} onClick={() => void act(load)}>刷新记录</button></div>
      {role === 'admin' && <details className="contact-grant" open={permissions.length === 0}>
        <summary>登记新的联系依据</summary>
        <form onSubmit={event => void savePermission(event)}><fieldset disabled={busy}>
          <div className="form-grid"><Field label="联系依据类型"><select value={basis} onChange={event => { const next = event.target.value as typeof basis; setBasis(next); if (next === 'inbound_inquiry') { setPurpose('customer_service'); setWindowRule('EXPLICIT_END'); } }}><option value="inbound_inquiry">客户主动咨询</option><option value="explicit_consent">明确同意</option></select></Field><Field label="本次用途"><select value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)}><option value="customer_service">客户服务</option><option value="marketing" disabled={basis === 'inbound_inquiry'}>营销联系</option></select></Field></div>
          <Field label="依据记录编号或出处"><input name="source_ref" required maxLength={300} /></Field><Field label="依据发生时间"><input name="observed_at" type="datetime-local" required /></Field>
          <div className="form-grid"><Field label="依据生效时间"><input name="starts_at" type="datetime-local" required /></Field><Field label="依据到期时间"><input name="expires_at" type="datetime-local" required /></Field></div>
          <Field label="渠道规则出处或版本"><input name="policy_ref" required maxLength={160} /></Field><Field label="联系窗口规则"><select value={windowRule} onChange={event => setWindowRule(event.target.value as typeof windowRule)} disabled={basis === 'inbound_inquiry'}><option value="EXPLICIT_END">具有明确到期时间</option><option value="NOT_REQUIRED">已核实此用途不要求窗口</option><option value="UNKNOWN">尚未核实</option></select></Field>
          {windowRule === 'EXPLICIT_END' && <Field label="联系窗口到期时间"><input name="window_expires_at" type="datetime-local" required /></Field>}
          <Field label="依据说明"><textarea name="evidence_note" required minLength={10} maxLength={1000} rows={3} /></Field>
          <label className="contact-checkbox"><input name="confirmed" type="checkbox" />已核对来源用途与渠道规则</label>
          {target.opted_out && basis === 'explicit_consent' && <label className="contact-checkbox"><input name="resume" type="checkbox" />这是退出后新的明确同意，据此恢复联系</label>}
          <button className="button primary" disabled={busy}>保存联系依据</button>
        </fieldset></form>
      </details>}
      <Field label="检查哪条联系依据"><select value={permissionId} disabled={busy} onChange={event => { setPermissionId(event.target.value); setReview(null); }}><option value="">选择已登记依据</option>{permissions.map(value => <option key={value.id} value={value.id}>{value.policy.source_ref} · {value.purpose === 'marketing' ? '营销联系' : '客户服务'}{value.revoked_at ? ' · 已撤销' : ''}</option>)}</select></Field>
      <button className="button subtle" disabled={busy || !permissionId} onClick={() => void act(async () => { const permission = permissions.find(value => value.id === permissionId)!; setReview(await api('contacts/eligibility', { target_id: targetId, permission_id: permissionId, purpose: permission.purpose })); })}>检查选中依据</button>
      {review && <div className="contact-review" role="status"><strong>{review.basis_eligible ? '检查时的联系依据满足要求' : '联系依据不满足要求'}</strong>{review.reason_codes.map(code => <p key={code}>{reasonNames[code] ?? '依据已变化，请核对记录'}</p>)}<small>检查结果仅反映当前记录，发送前须再次核对。</small></div>}
      {role !== 'viewer' && <div className="contact-exit"><Field label="退出或撤销原因"><input value={reason} onChange={event => setReason(event.target.value)} maxLength={300} disabled={busy} /></Field><div className="contact-actions"><button className="button danger" disabled={busy || !reason.trim() || target.opted_out} onClick={() => void act(async () => { const value = { expected_version: target.version, reason }; await api('contacts/' + target.id + '/exit', { ...value, request_id: requestId({ target: target.id, ...value }) }); })}>记录退出</button>{role === 'admin' && <button className="button subtle" disabled={busy || !permissionId || !reason.trim() || Boolean(permissions.find(value => value.id === permissionId)?.revoked_at)} onClick={() => void act(async () => { await api('contacts/permissions/' + permissionId + '/revoke', { reason }); })}>撤销选中依据</button>}</div></div>}
    </>}
    <p className="field-hint contact-limit">展示最近登记的最多 200 条记录。此入口登记和检查依据，不会发送消息。</p>
  </div>;
}
