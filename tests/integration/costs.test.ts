import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { configureBudget, reserveCostForAction, markCostPending, reconcileCost, costWorkspace } from '../../packages/core/src/costs';
import { createTask, approveTask, enqueueTask, stopRun } from '../../packages/core/src/service';
import { dispatchOne, claimCommand, beginSubmission, acceptReport } from '../../packages/core/src/execution';
import { recordQuiescence } from '../../packages/core/src/reconciliation';
import type { Scope } from '../../packages/contracts/src/index';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent = { id: localIds.agent, organization_id: scope.organization_id, brand_id: scope.brand_id, status: 'ONLINE' };
const budget = (currency = 'USD', limit = '100', exponent = 2) => configureBudget(scope, { request_id: randomUUID(), expected_version: 0, currency, minor_unit_exponent: exponent, precision_source: 'Synthetic currency precision fixture', limit_minor: limit, reason: 'Isolated expense test budget' });
async function queued() {
  const task = await createTask(scope, { title: 'Synthetic cost ledger test', account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.publish, body: 'Local accounting scenario', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, task.id, { decision: 'APPROVED', snapshot_hash: task.snapshot_hash }); const run = await enqueueTask(scope, task.id);
  const action = (await query('SELECT id FROM kff.actions WHERE run_id=$1', [run.id]))[0]; return { task, run, action_id: action.id as string };
}
const reserve = (action: string, amount = '75', currency = 'USD') => scoped(scope, client => reserveCostForAction(client, action, { permit_id: null, currency, reserved_minor: amount, cost_basis: 'Synthetic estimated cost; no actual bill' }));
const settleInput = (version: number, amount: string) => ({ request_id: randomUUID(), expected_version: version, decision: 'SETTLE' as const, actual_cost_minor: amount, evidence_ref: 'synthetic-invoice/' + randomUUID(), note: 'Synthetic complete bill fixture; no real billing occurs', confirmation: 'I_RECONCILED_THIS_COST' as const });
beforeAll(async () => {
  const name = (await query('SELECT current_database() AS name'))[0].name;
  if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Isolated database required');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.content_versions,kff.audit_events,kff.cost_budgets,kff.cost_reservations,kff.cost_entries CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=now() WHERE id=$1", [localIds.agent]);
  await query("UPDATE kff.environments SET state='IDLE'");
  await query('UPDATE kff.organizations SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); await query('UPDATE kff.accounts SET outbound_paused=false');
});
afterAll(closePool);

it('requires an explicit budget even when the proposed maximum cost is zero', async () => {
  const action = await queued(); await expect(reserve(action.action_id, '0')).rejects.toMatchObject({ code: 'BUDGET_UNCONFIGURED' });
  expect((await query('SELECT count(*)::int AS count FROM kff.cost_reservations'))[0].count).toBe(0);
});
it('deduplicates budget configuration and rejects stale versions or reinterpretation of currency precision', async () => {
  const input = { request_id: randomUUID(), expected_version: 0, currency: 'USD', minor_unit_exponent: 2, precision_source: 'Synthetic precision fixture', limit_minor: '100', reason: 'Synthetic configuration' };
  const rows = await Promise.all(Array.from({ length: 4 }, () => configureBudget(scope, input))); expect(new Set(rows.map(row => row.id)).size).toBe(1);
  await expect(configureBudget(scope, { ...input, limit_minor: '101' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(configureBudget(scope, { ...input, request_id: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  await expect(configureBudget(scope, { ...input, request_id: randomUUID(), expected_version: 1, minor_unit_exponent: 0 })).rejects.toMatchObject({ code: 'CURRENCY_PRECISION_CONFLICT' });
});
it('does not overbook a shared budget under concurrent actions', async () => {
  await budget(); const actions = await Promise.all(Array.from({ length: 6 }, queued));
  const result = await Promise.allSettled(actions.map(action => reserve(action.action_id, '40')));
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(2);
  for (const entry of result) if (entry.status === 'rejected') expect(entry.reason).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  expect((await costWorkspace(scope)).balances[0]).toMatchObject({ held_minor: '80', available_minor: '20', pending_count: 2 });
});
it('reserves one action once and rejects changed repeated amounts', async () => {
  await budget(); const action = await queued(); const rows = await Promise.all(Array.from({ length: 8 }, () => reserve(action.action_id)));
  expect(rows.every(row => row.action_id === action.action_id)).toBe(true);
  expect((await query("SELECT count(*)::int AS count FROM kff.cost_entries WHERE event_type='RESERVED'"))[0].count).toBe(1);
  await expect(reserve(action.action_id, '76')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(scoped(scope, client => reserveCostForAction(client, action.action_id, { permit_id: null, currency: 'USD', reserved_minor: '75', cost_basis: 'Different source cannot replace the approved estimate' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('retains the complete estimate while actual cost is unknown and records the pending transition once', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id);
  await Promise.all(Array.from({ length: 3 }, () => scoped(scope, client => markCostPending(client, action.action_id, 'SYNTHETIC_CONNECTION_LOSS'))));
  const workspace = await costWorkspace(scope); expect(workspace.reservations[0]).toMatchObject({ state: 'PENDING_RECONCILIATION', actual_cost_minor: null, version: 2 });
  expect(workspace.balances[0]).toMatchObject({ held_minor: '75', confirmed_minor: '0', available_minor: '25', pending_count: 1 });
  expect((await query("SELECT count(*)::int AS count FROM kff.cost_entries WHERE event_type='PENDING_RECONCILIATION'"))[0].count).toBe(1);
  const second = await queued(); await expect(reserve(second.action_id, '30')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
});
it('refuses to settle an in-flight action or to label a null amount as a settlement', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id);
  await expect(reconcileCost(scope, action.action_id, settleInput(1, '0'))).rejects.toMatchObject({ code: 'COST_ACTION_IN_FLIGHT' });
  await expect(query("UPDATE kff.cost_reservations SET state='SETTLED',actual_cost_minor=NULL,version=version+1 WHERE action_id=$1", [action.action_id])).rejects.toMatchObject({ code: '23514' });
});
it('settles and adjusts with immutable events while a repeated earlier settlement cannot overwrite the adjustment', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id); await stopRun(scope, action.run.id, 'Cancel synthetic preparation');
  const input = settleInput(1, '50'); await reconcileCost(scope, action.action_id, input); await reconcileCost(scope, action.action_id, input);
  await reconcileCost(scope, action.action_id, { ...settleInput(2, '60'), decision: 'ADJUST' }); await reconcileCost(scope, action.action_id, input);
  expect((await costWorkspace(scope)).balances[0]).toMatchObject({ held_minor: '0', confirmed_minor: '60', available_minor: '40', pending_count: 0 });
  await expect(reconcileCost(scope, action.action_id, { ...input, actual_cost_minor: '51' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await query("SELECT count(*)::int AS count FROM kff.cost_entries WHERE event_type IN ('SETTLED','ADJUSTED')"))[0].count).toBe(2);
  await expect(query("UPDATE kff.cost_entries SET details='{}' WHERE id=$1", [input.request_id])).rejects.toThrow('IMMUTABLE_COST_EVENT');
});
it('records an over-estimate bill truthfully and blocks new reservations when the budget is exceeded', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id); await stopRun(scope, action.run.id, 'End synthetic cost scenario');
  await reconcileCost(scope, action.action_id, settleInput(1, '120'));
  expect((await costWorkspace(scope)).balances[0]).toMatchObject({ confirmed_minor: '120', available_minor: '-20' });
  const second = await queued(); await expect(reserve(second.action_id, '1')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
});
it('rechecks an existing reservation against the current budget without double counting it', async () => {
  await budget(); const first = await queued(); const second = await queued();
  await reserve(first.action_id, '50'); await reserve(second.action_id, '50');
  await reserve(second.action_id, '50');
  await stopRun(scope, first.run.id, 'Synthetic first action is finished');
  await reconcileCost(scope, first.action_id, settleInput(1, '75'));
  await expect(reserve(second.action_id, '50')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  expect((await costWorkspace(scope)).balances[0]).toMatchObject({ held_minor: '50', confirmed_minor: '75', available_minor: '-25' });
});
it('releases only an explicitly reconciled zero, and never reopens the same action reservation', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id); await stopRun(scope, action.run.id, 'Synthetic canceled action');
  await reconcileCost(scope, action.action_id, { ...settleInput(1, '0'), decision: 'RELEASE' });
  expect((await costWorkspace(scope)).balances[0]).toMatchObject({ held_minor: '0', confirmed_minor: '0', available_minor: '100' });
  await expect(reserve(action.action_id)).rejects.toMatchObject({ code: 'COST_ALREADY_FINAL' });
});
it('separates currencies and stores configured zero-decimal precision without floating point', async () => {
  await budget('JPY', '999999999999999', 0); await budget('USD', '100', 2);
  const action = await queued(); await reserve(action.action_id, '999999999999999', 'JPY');
  const balances = (await costWorkspace(scope)).balances;
  expect(balances.find(value => value.currency === 'JPY')).toMatchObject({ minor_unit_exponent: 0, held_minor: '999999999999999', available_minor: '0' });
  expect(balances.find(value => value.currency === 'USD')).toMatchObject({ minor_unit_exponent: 2, held_minor: '0', available_minor: '100' });
});
it('requires guardian closure for unknown actions and leaves execution isolation intact after cost settlement', async () => {
  await budget(); const action = await queued(); await reserve(action.action_id); expect(await dispatchOne()).toBe(true);
  const command = (await claimCommand(agent))!; await beginSubmission(agent, command.id);
  await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'UNKNOWN_OUTCOME', diagnostic: { step: 'synthetic-cost-test' } });
  await expect(reconcileCost(scope, action.action_id, settleInput(2, '30'))).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
  await recordQuiescence(agent, command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: action.action_id, closed_at: new Date().toISOString(), proof_sha256: 'a'.repeat(64) });
  await reconcileCost(scope, action.action_id, settleInput(2, '30'));
  expect((await query('SELECT state FROM kff.actions WHERE id=$1', [action.action_id]))[0].state).toBe('UNKNOWN_OUTCOME');
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [localIds.environment]))[0].state).toBe('QUARANTINED');
});
it('keeps budgets and cost records scoped and disallows viewer mutations', async () => {
  await budget(); const foreign = { ...scope, brand_id: randomUUID() }; expect((await costWorkspace(foreign)).balances).toHaveLength(0);
  await expect(configureBudget({ ...scope, role: 'viewer' }, { request_id: randomUUID(), expected_version: 1, currency: 'USD', minor_unit_exponent: 2, precision_source: 'Test rule', limit_minor: '200', reason: 'Unauthorized change' })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
});
