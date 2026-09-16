import type { Capability } from '@kff/contracts';

/**
 * The task modal's single source of truth for "which capabilities can be run from here".
 *
 * Context-bound actions (discovery / inbox / comment reply / messenger reply) need a lead, comment
 * or conversation snapshot that this form never collects, so the server always refuses a task that
 * selects one. Those actions keep their own entry points in the lead and inbox workbenches.
 *
 * The rule used to exist in three places with two different meanings: the dropdown filtered by this
 * whitelist, while modal initialisation and the account switch only excluded `.discovery.` and
 * `.inbox.`. An account whose first capability was a Messenger or comment reply therefore opened
 * the modal with an empty "action" box, or with a capability that has no option in the list at all.
 */
export const TASK_MODAL_CAPABILITY_KEYS = [
  'facebook.page.read.api',
  'facebook.page.publish.api',
  'instagram.account.read.api',
  'kff.fixture.page.read.browser',
  'kff.fixture.page.publish.browser',
] as const;

/** Whether this account may run this capability from the generic task modal. */
export function isTaskModalCapability(capability: Pick<Capability, 'account_id' | 'capability_key'>, accountId: string) {
  return capability.account_id === accountId
    && (TASK_MODAL_CAPABILITY_KEYS as readonly string[]).includes(capability.capability_key);
}

/** The capabilities the task modal may offer for this account, in the order the server listed them. */
export function taskModalCapabilities(capabilities: readonly Capability[], accountId: string): Capability[] {
  return accountId ? capabilities.filter(capability => isTaskModalCapability(capability, accountId)) : [];
}

/**
 * The capability the modal should start on for this account. It is always a member of the rendered
 * options or empty, so the form can never submit a capability the operator cannot see. Keeping the
 * current selection is allowed only while it is still offered for the selected account.
 */
export function resolveTaskModalCapability(
  capabilities: readonly Capability[],
  accountId: string,
  current = '',
): { capability_id: string; reason: 'RETAINED' | 'DEFAULTED' | 'CLEARED' | 'NONE' } {
  const available = taskModalCapabilities(capabilities, accountId);
  if (available.some(capability => capability.id === current)) return { capability_id: current, reason: 'RETAINED' };
  if (available.length) return { capability_id: available[0].id, reason: current ? 'CLEARED' : 'DEFAULTED' };
  return { capability_id: '', reason: 'NONE' };
}
