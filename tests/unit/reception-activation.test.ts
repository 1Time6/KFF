import { it, expect } from 'vitest';
import { receptionActivationLabels, receptionActivationReason, type ReceptionStatusInput } from '../../packages/core/src/reception-queue';

// A healthy conversation: active browser connection with auto reply, live account, available agent
// and one unanswered inbound message.
const active: ReceptionStatusInput = {
  handling_mode: 'AI', channel_kind: 'FACEBOOK_BROWSER_MESSENGER',
  connection: { transport: 'BROWSER', state: 'ACTIVE', auto_reply: true },
  account: { state: 'ACTIVE', outbound_paused: false },
  brand_paused: false, organization_paused: false, agent_status: 'ONLINE',
  last_inbound_sequence: 4, last_answered_sequence: 3,
  last_inbound: { direction: 'INBOUND', message_kind: 'MESSAGE' },
  customer: { lead_status: 'NEW', stage: 'INQUIRY' },
};

// Selecting AI mode and actually running are different facts, and the five states the operator
// meets must each be reported accurately instead of all looking like "AI mode is on".
it('reports each reason reception is not running, and only the healthy case as active', () => {
  expect(receptionActivationReason(active)).toEqual({ reason: 'ACTIVE', active: true });
  const cases: [string, Partial<ReceptionStatusInput>][] = [
    ['AUTO_REPLY_OFF', { connection: { transport: 'BROWSER', state: 'ACTIVE', auto_reply: false } }],
    ['CONNECTION_PAUSED', { connection: { transport: 'BROWSER', state: 'PAUSED', auto_reply: true } }],
    ['NO_PENDING_INBOUND', { last_inbound_sequence: 3, last_answered_sequence: 3 }],
    ['NO_PENDING_INBOUND', { last_inbound: undefined }],
    ['NO_PENDING_INBOUND', { last_inbound: { direction: 'OUTBOUND', message_kind: 'MESSAGE' } }],
    ['ACCOUNT_UNAVAILABLE', { account: { state: 'DISABLED', outbound_paused: false } }],
    ['ACCOUNT_UNAVAILABLE', { account: undefined }],
    ['OUTBOUND_PAUSED', { account: { state: 'ACTIVE', outbound_paused: true } }],
    ['OUTBOUND_PAUSED', { brand_paused: true }],
    ['OUTBOUND_PAUSED', { organization_paused: true }],
    ['AGENT_UNAVAILABLE', { agent_status: 'DRAINING' }],
    ['AGENT_UNAVAILABLE', { agent_status: 'REVOKED' }],
    ['AGENT_UNAVAILABLE', { agent_status: 'QUARANTINED' }],
    ['CHANNEL_MISMATCH', { channel_kind: 'FACEBOOK_MESSENGER' }],
    ['CONNECTION_NOT_CONFIGURED', { connection: undefined }],
    ['HANDLING_MODE_NOT_AI', { handling_mode: 'HUMAN' }],
    ['CUSTOMER_CLOSED', { customer: { lead_status: 'BLOCKED', stage: 'OPTED_OUT' } }],
    ['CUSTOMER_CLOSED', { customer: { lead_status: 'HANDOFF_COMPLETE', stage: 'HANDOFF' } }],
    ['CUSTOMER_CLOSED', { customer: undefined }],
  ];
  for (const [expected, change] of cases) {
    const status = receptionActivationReason({ ...active, ...change });
    expect(status.reason, JSON.stringify(change)).toBe(expected);
    expect(status.active).toBe(false);
  }
});

// The auto-reply case is the one that misled the operator: the mode is legitimately AI, and the
// account switch is the reason nothing runs. Reporting it must not be an excuse to flip the switch.
it('names the account-level switch as the blocker without turning it on', () => {
  const input = { ...active, connection: { ...active.connection!, auto_reply: false } };
  const status = receptionActivationReason(input);
  expect(status.reason).toBe('AUTO_REPLY_OFF');
  expect(receptionActivationLabels[status.reason]).toContain('自动回复');
  // The resolver is pure: evaluating it cannot change the input it was given.
  expect(input.connection.auto_reply).toBe(false);
  expect(receptionActivationReason(input)).toEqual(status);
});

// A real browser connection is still allowed to be in AI mode; it stays a manual-approval path and
// is reported as active reception so the operator is not told something false either way.
it('keeps a real browser connection on the same rule as a synthetic one', () => {
  const real = { ...active, connection: { transport: 'BROWSER', state: 'ACTIVE', auto_reply: true } };
  expect(receptionActivationReason(real)).toEqual({ reason: 'ACTIVE', active: true });
  expect(receptionActivationReason({ ...real, connection: { transport: 'API', state: 'ACTIVE', auto_reply: true } }).reason).toBe('CHANNEL_MISMATCH');
});

it('describes every reason the operator can be shown', () => {
  const reasons: ReceptionStatusInput[] = [
    active,
    { ...active, connection: { transport: 'BROWSER', state: 'ACTIVE', auto_reply: false } },
    { ...active, connection: { transport: 'BROWSER', state: 'PAUSED', auto_reply: true } },
    { ...active, last_inbound_sequence: 1, last_answered_sequence: 9 },
    { ...active, handling_mode: 'PAUSED' },
    { ...active, agent_status: 'REVOKED' },
    { ...active, customer: { lead_status: 'BLOCKED', stage: 'OPTED_OUT' } },
  ];
  for (const input of reasons) {
    const { reason } = receptionActivationReason(input);
    expect(receptionActivationLabels[reason]).toBeTruthy();
    expect(receptionActivationLabels[reason].length).toBeGreaterThan(4);
  }
});
