import { it, expect } from 'vitest';
import type { Capability } from '@kff/contracts';
import { TASK_MODAL_CAPABILITY_KEYS, isTaskModalCapability, resolveTaskModalCapability, taskModalCapabilities } from '../../apps/web/components/task-capabilities';

const capability = (id: string, account_id: string, capability_key: string) => ({ id, account_id, capability_key, revision: 1, adapter_version: 'v1', evidence_state: 'IMPLEMENTED_TEST_ONLY', mode: 'TEST_ONLY', is_synthetic: true, description: '', last_verified_at: null }) as Capability;
const inbox = capability('c-inbox', 'a1', 'facebook.inbox.read.browser');
const messenger = capability('c-messenger', 'a1', 'facebook.messenger.reply.browser');
const comment = capability('c-comment', 'a1', 'facebook.comment.reply.browser');
const discovery = capability('c-discovery', 'a1', 'facebook.discovery.read.browser');
const pageRead = capability('c-read', 'a1', 'kff.fixture.page.read.browser');
const pagePublish = capability('c-publish', 'a1', 'kff.fixture.page.publish.browser');
const otherAccount = capability('c-other', 'a2', 'facebook.page.read.api');

// Context-bound actions require a lead, comment or conversation snapshot this form never collects,
// so they must never become an option in the generic task modal.
it('offers only the capabilities the task modal can actually run', () => {
  const offered = taskModalCapabilities([messenger, comment, discovery, inbox, pageRead, pagePublish, otherAccount], 'a1');
  expect(offered.map(value => value.capability_key)).toEqual(['kff.fixture.page.read.browser', 'kff.fixture.page.publish.browser']);
  expect(TASK_MODAL_CAPABILITY_KEYS).not.toContain('facebook.messenger.reply.browser');
  for (const bound of [messenger, comment, discovery, inbox]) expect(isTaskModalCapability(bound, 'a1')).toBe(false);
  // Another account's capability is never offered, even when the key would qualify.
  expect(isTaskModalCapability(otherAccount, 'a1')).toBe(false);
  expect(isTaskModalCapability(otherAccount, 'a2')).toBe(true);
});

// The defect: initialisation and the account switch chose the first capability that merely was not
// discovery or inbox, so an account whose first capability was a Messenger or comment reply opened
// the modal with a capability that has no option in the rendered list.
it('never selects a capability that is not in the rendered options', () => {
  // The pre-fix rule, kept here as the failing side of the comparison. It is exactly what
  // workbench.tsx used for initialisation and for the account switch.
  const previousRule = (pool: Capability[], accountId: string) =>
    pool.find(value => value.account_id === accountId && !value.capability_key.includes('.discovery.') && !value.capability_key.includes('.inbox.'))?.id ?? '';
  // The order that triggered it: a context-bound reply capability comes first.
  const order = [messenger, comment, inbox, pageRead, pagePublish];
  const offered = taskModalCapabilities(order, 'a1').map(value => value.id);
  // The old rule selected a capability the dropdown never rendered, so the action box opened empty.
  expect(previousRule(order, 'a1')).toBe(messenger.id);
  expect(offered).not.toContain(previousRule(order, 'a1'));
  // The current rule selects one of the rendered options.
  const opened = resolveTaskModalCapability(order, 'a1', '');
  expect(opened.capability_id).toBe(pageRead.id);
  expect(opened.reason).toBe('DEFAULTED');
  expect(offered).toContain(opened.capability_id);
  // An account the old rule would have driven to an empty box is now cleared, not left hidden.
  expect(resolveTaskModalCapability([messenger, comment], 'a1', previousRule([messenger, comment], 'a1'))).toEqual({ capability_id: '', reason: 'NONE' });
});

it('keeps a selection that is still offered and clears one that is not', () => {
  const all = [pageRead, pagePublish];
  expect(resolveTaskModalCapability(all, 'a1', pagePublish.id)).toEqual({ capability_id: pagePublish.id, reason: 'RETAINED' });
  // Switching account drops a selection the new account cannot run.
  expect(resolveTaskModalCapability([pageRead, otherAccount], 'a2', pageRead.id)).toEqual({ capability_id: otherAccount.id, reason: 'CLEARED' });
  // An account with only context-bound capabilities submits nothing at all.
  expect(resolveTaskModalCapability([messenger, comment, inbox], 'a1', '')).toEqual({ capability_id: '', reason: 'NONE' });
  expect(resolveTaskModalCapability([messenger, comment, inbox], 'a1', messenger.id)).toEqual({ capability_id: '', reason: 'NONE' });
  expect(resolveTaskModalCapability(all, '', pageRead.id)).toEqual({ capability_id: '', reason: 'NONE' });
});

// Whatever the operator can see, the resolver must be able to select: the two share one rule.
it('agrees with the rendered options for every account and ordering', () => {
  const accounts = ['a1', 'a2'];
  const pool = [messenger, comment, discovery, inbox, pageRead, pagePublish, otherAccount];
  for (const account of accounts) {
    const offered = taskModalCapabilities(pool, account).map(value => value.id);
    const resolved = resolveTaskModalCapability(pool, account, '');
    expect(offered.includes(resolved.capability_id) || resolved.capability_id === '').toBe(true);
    for (const candidate of pool) {
      const kept = resolveTaskModalCapability(pool, account, candidate.id);
      expect(offered.includes(kept.capability_id) || kept.capability_id === '').toBe(true);
    }
  }
});
