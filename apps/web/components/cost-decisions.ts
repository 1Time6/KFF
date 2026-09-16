/**
 * Which reconciliation decisions a cost record currently allows.
 *
 * This mirrors the two server gates in `packages/core/src/costs.ts:reconcileCost`:
 *  - the record must still be pending (`RESERVED` / `PENDING_RECONCILIATION`) for SETTLE, RELEASE or
 *    PENDING; a settled or released record only accepts ADJUST;
 *  - any decision other than PENDING additionally requires the action to be out of flight
 *    (QUEUED / PREPARING / SUBMITTING / SUBMITTED) and its old execution context to be closed.
 * The workspace used to return only the raw state, so the form offered SETTLE and RELEASE for
 * records the server refuses, and a decision selected before a refresh could stay in the form after
 * the record moved on.
 */
export const IN_FLIGHT_ACTION_STATES = ['QUEUED', 'PREPARING', 'SUBMITTING', 'SUBMITTED'] as const;
export const PENDING_COST_STATES = ['RESERVED', 'PENDING_RECONCILIATION'] as const;
export type CostDecision = 'SETTLE' | 'RELEASE' | 'PENDING' | 'ADJUST';

export interface CostDecisionInput {
  /** The cost record's own state. */
  state: string;
  /** The state of the action this reservation belongs to. */
  action_state: string;
  /** Whether any execution context for that action is still open. */
  guardian_unclosed: boolean;
}
export interface CostDecisionOptions {
  allowed_actions: CostDecision[];
  /** Why the useful decisions are unavailable, or null when nothing is restricted. */
  restriction: string | null;
  pending: boolean;
}

export function costDecisionOptions(input: CostDecisionInput): CostDecisionOptions {
  const pending = (PENDING_COST_STATES as readonly string[]).includes(input.state);
  // The in-flight and unclosed gates apply to every terminal decision, including ADJUST on a record
  // that is already closed: the server checks them before it looks at the record's own state.
  const inFlight = (IN_FLIGHT_ACTION_STATES as readonly string[]).includes(input.action_state);
  const blocked = inFlight ? '动作仍在途，保留费用预占，只能继续待核账。' : input.guardian_unclosed ? '旧执行上下文尚未确认关闭，保留费用预占，只能继续待核账。' : null;
  if (blocked) return { allowed_actions: pending ? ['PENDING'] : [], restriction: blocked, pending };
  // A closed record keeps ADJUST: it never releases the reservation again.
  if (!pending) return { allowed_actions: ['ADJUST'], restriction: null, pending: false };
  return { allowed_actions: ['SETTLE', 'RELEASE', 'PENDING'], restriction: null, pending: true };
}

/**
 * Keep the selected decision inside the currently allowed set. A decision chosen before a refresh
 * is corrected rather than submitted: sending it would only earn INVALID_COST_TRANSITION. The
 * first allowed decision is used, so the correction is always something the operator can act on.
 */
export function reconcileDecision(decision: string, options: CostDecisionOptions): { decision: CostDecision; corrected: boolean } {
  if ((options.allowed_actions as readonly string[]).includes(decision)) return { decision: decision as CostDecision, corrected: false };
  return { decision: options.allowed_actions[0], corrected: true };
}
