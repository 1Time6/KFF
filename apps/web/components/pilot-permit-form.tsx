'use client';
import { useId, type FormEvent } from 'react';
import type { Task } from '@kff/contracts';

export function PilotPermitForm({ task, busy, onSubmit }: { task: Task; busy: boolean; onSubmit(value: Record<string, unknown>): Promise<void> }) {
  const prefix = useId();
  // Mirror of permits.ts:45-46,56. Server precedence is:
  //   inbox -> inbox_page, discovery read -> collection_page,
  //   then message/outreach -> message_acceptance, else write/read defaults.
  // Browser read/inbox tasks were previously computed as 'page_identity' (they carry
  // neither message nor outreach), so every permit for a real read task was rejected
  // with 400 INVALID_INPUT "预期证据与动作不匹配".
  const inbox = task.snapshot.capability_key === 'facebook.inbox.read.browser' && Boolean(task.snapshot.inbox);
  const collectionRead = task.snapshot.capability_key === 'facebook.discovery.read.browser' && Boolean(task.snapshot.collection);
  const expected_evidence = inbox ? 'inbox_page'
    : collectionRead ? 'collection_page'
    : (task.snapshot.message || task.snapshot.outreach) ? 'message_acceptance'
    : task.snapshot.capability_key.includes('.publish.') ? 'published_post_identity_author_content'
    : 'page_identity';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await onSubmit({ task_id: task.id, max_actions: 1, starts_at: new Date().toISOString(), expires_at: new Date(String(form.get('expires_at'))).toISOString(), currency: form.get('currency'), max_cost_minor: form.get('max_cost_minor'), per_action_max_minor: form.get('max_cost_minor'), cost_basis: form.get('cost_basis'), authorization_evidence: form.get('authorization_evidence'), platform_conditions: form.get('platform_conditions'), expected_evidence, stop_rule: 'stop_on_first_unknown_or_failure', confirmation: 'I_CONFIRM_THIS_EXACT_SCOPE' });
  }
  return <form onSubmit={event => void submit(event)} className="permit-form">
    <h3 className="section-label">一次受控试验许可</h3>
    <p className="field-hint">许可固定当前任务、账号、目标、内容和实现版本。提交未知或失败后停止；次数与最大费用预占不会自动返还。</p>
    <div className="field"><label htmlFor={prefix + 'expires'}>到期时间（本机时区，{task.snapshot.outreach?.browser||task.snapshot.message?.browser?'1':'24'} 小时内）</label><input id={prefix + 'expires'} name="expires_at" type="datetime-local" required /></div>
    <div className="form-grid"><div className="field"><label htmlFor={prefix + 'currency'}>费用币种</label><input id={prefix + 'currency'} name="currency" pattern="[A-Z]{3}" maxLength={3} placeholder="例如 CNY" required /></div><div className="field"><label htmlFor={prefix + 'cost'}>单次及总费用上限（最小货币单位）</label><input id={prefix + 'cost'} name="max_cost_minor" pattern="0|[1-9][0-9]{0,14}" inputMode="numeric" placeholder="已核实无费用时可填写 0" required /></div></div>
    <div className="field"><label htmlFor={prefix + 'basis'}>费用依据</label><textarea id={prefix + 'basis'} name="cost_basis" minLength={10} maxLength={500} required /></div>
    <div className="field"><label htmlFor={prefix + 'authorization'}>账号、目标和动作的授权依据</label><textarea id={prefix + 'authorization'} name="authorization_evidence" minLength={10} maxLength={1000} required /></div>
    <div className="field"><label htmlFor={prefix + 'platform'}>已核实的平台权限、版本和测试条件</label><textarea id={prefix + 'platform'} name="platform_conditions" minLength={10} maxLength={1000} required /></div>
    <label className="permit-confirm"><input type="checkbox" required />我确认已获准按以上范围进行这一次试验。</label>
    <button className="button primary" disabled={busy}>保存一次试验许可</button>
  </form>;
}
