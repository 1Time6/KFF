import { it, expect } from 'vitest';
import { costDecisionOptions, reconcileDecision, type CostDecisionInput } from '../../apps/web/components/cost-decisions';
import { costDecisionOptions as serverCostDecisionOptions } from '../../packages/core/src/costs';

// The workspace returns the option set from the core rule and the form consumes the web rule. The
// two must agree for every state combination, or the form offers something the server refuses (or
// hides something it accepts).
it('agrees with the option set the workspace returns', () => {
  const states = ['RESERVED', 'PENDING_RECONCILIATION', 'SETTLED', 'RELEASED', 'ADJUSTED'];
  const actionStates = ['QUEUED', 'PREPARING', 'SUBMITTING', 'SUBMITTED', 'VERIFIED_SUCCEEDED', 'BLOCKED', 'CANCELED'];
  for (const state of states) {
    for (const action_state of actionStates) {
      for (const guardian_unclosed of [false, true]) {
        const input = { state, action_state, guardian_unclosed };
        expect(costDecisionOptions(input), JSON.stringify(input)).toEqual(serverCostDecisionOptions(input));
      }
    }
  }
});

const record = (change: Partial<CostDecisionInput> = {}): CostDecisionInput => ({ state: 'PENDING_RECONCILIATION', action_state: 'VERIFIED_SUCCEEDED', guardian_unclosed: false, ...change });

// The server gates, written out as the comparator: a decision is accepted only when the record is
// pending for SETTLE/RELEASE/PENDING, or closed for ADJUST, and only when nothing else is unclosed.
const serverAccepts = (input: CostDecisionInput, decision: string) => {
  const pending = ['RESERVED', 'PENDING_RECONCILIATION'].includes(input.state);
  if (decision === 'ADJUST' ? pending : !pending) return false;
  if (decision !== 'PENDING') {
    if (['QUEUED', 'PREPARING', 'SUBMITTING', 'SUBMITTED'].includes(input.action_state)) return false;
    if (input.guardian_unclosed) return false;
  }
  return true;
};

it('offers exactly the decisions the server accepts', () => {
  const cases: CostDecisionInput[] = [
    record(), record({ state: 'RESERVED' }), record({ state: 'SETTLED' }), record({ state: 'RELEASED' }), record({ state: 'ADJUSTED' }),
    record({ action_state: 'SUBMITTED' }), record({ action_state: 'QUEUED' }), record({ action_state: 'PREPARING' }),
    record({ guardian_unclosed: true }), record({ state: 'SETTLED', action_state: 'SUBMITTED' }),
    record({ state: 'SETTLED', guardian_unclosed: true }),
  ];
  for (const input of cases) {
    const options = costDecisionOptions(input);
    for (const decision of options.allowed_actions) {
      expect(serverAccepts(input, decision), JSON.stringify(input) + ' / ' + decision).toBe(true);
    }
    // Anything the server would accept must be offered, so nothing legal is hidden.
    for (const decision of ['SETTLE', 'RELEASE', 'PENDING', 'ADJUST'] as const) {
      if (serverAccepts(input, decision)) expect(options.allowed_actions, JSON.stringify(input)).toContain(decision);
    }
  }
  // A closed record whose action is still in flight accepts nothing at all, and the form has to say
  // so rather than render an empty picker: the server refuses every decision for it.
  const noOptions = costDecisionOptions(record({ state: 'SETTLED', action_state: 'SUBMITTED' }));
  expect(noOptions.allowed_actions).toEqual([]);
  expect(noOptions.restriction).toContain('在途');
  for (const decision of ['SETTLE', 'RELEASE', 'PENDING', 'ADJUST'] as const) expect(serverAccepts(record({ state: 'SETTLED', action_state: 'SUBMITTED' }), decision)).toBe(false);
  // Otherwise every record has at least one legal decision.
  for (const input of cases) {
    if (input.state === 'SETTLED' && ['QUEUED', 'PREPARING', 'SUBMITTING', 'SUBMITTED'].includes(input.action_state)) continue;
    if (input.state === 'SETTLED' && input.guardian_unclosed) continue;
    expect(costDecisionOptions(input).allowed_actions.length, JSON.stringify(input)).toBeGreaterThan(0);
  }
});

// The audit case: a record still in flight may only stay pending. The old form offered SETTLE and
// RELEASE, which the server refuses with COST_ACTION_IN_FLIGHT.
it('keeps an in-flight action on PENDING with an explanation', () => {
  const options = costDecisionOptions(record({ action_state: 'SUBMITTING' }));
  expect(options.allowed_actions).toEqual(['PENDING']);
  expect(options.restriction).toContain('在途');
  // A reservation is still held, so the record stays pending and is never auto-zeroed.
  expect(options.pending).toBe(true);
  expect(serverAccepts(record({ action_state: 'SUBMITTING' }), 'SETTLE')).toBe(false);
  expect(serverAccepts(record({ action_state: 'SUBMITTING' }), 'RELEASE')).toBe(false);
});

// An open execution context is the other reason a terminal decision is refused.
it('keeps an unclosed execution context on PENDING with an explanation', () => {
  const options = costDecisionOptions(record({ guardian_unclosed: true }));
  expect(options.allowed_actions).toEqual(['PENDING']);
  expect(options.restriction).toContain('关闭');
  expect(serverAccepts(record({ guardian_unclosed: true }), 'RELEASE')).toBe(false);
});

it('offers only ADJUST once a record is closed, and never RELEASE again', () => {
  for (const state of ['SETTLED', 'RELEASED', 'ADJUSTED']) {
    const options = costDecisionOptions(record({ state }));
    expect(options.allowed_actions).toEqual(['ADJUST']);
    expect(options.pending).toBe(false);
    // A closed record is not "restricted": ADJUST is exactly what it allows.
    expect(options.restriction).toBeNull();
  }
});

// A decision captured before a refresh must not be submitted after the record moved on; it is
// corrected into the new allowed set instead.
it('corrects a stale decision into the current allowed set', () => {
  const inFlight = costDecisionOptions(record({ action_state: 'SUBMITTED' }));
  expect(reconcileDecision('SETTLE', inFlight)).toEqual({ decision: 'PENDING', corrected: true });
  expect(reconcileDecision('RELEASE', inFlight)).toEqual({ decision: 'PENDING', corrected: true });
  expect(reconcileDecision('PENDING', inFlight)).toEqual({ decision: 'PENDING', corrected: false });
  // The other direction: a record settled by someone else only accepts ADJUST.
  const closed = costDecisionOptions(record({ state: 'SETTLED' }));
  expect(reconcileDecision('SETTLE', closed)).toEqual({ decision: 'ADJUST', corrected: true });
  expect(reconcileDecision('PENDING', closed)).toEqual({ decision: 'ADJUST', corrected: true });
  expect(reconcileDecision('ADJUST', closed)).toEqual({ decision: 'ADJUST', corrected: false });
  // An empty or unknown value is corrected rather than submitted as-is.
  expect(reconcileDecision('', closed)).toEqual({ decision: 'ADJUST', corrected: true });
  // The corrected decision is always one the server accepts for that record.
  expect(serverAccepts(record({ state: 'SETTLED' }), reconcileDecision('SETTLE', closed).decision)).toBe(true);
  expect(serverAccepts(record({ action_state: 'SUBMITTED' }), reconcileDecision('SETTLE', inFlight).decision)).toBe(true);
});
