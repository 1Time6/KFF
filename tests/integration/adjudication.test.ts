import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { createTask, approveTask, enqueueTask, runDetail, workspace } from '../../packages/core/src/service';
import { dispatchOne, claimCommand, beginSubmission, acceptReport } from '../../packages/core/src/execution';
import { adjudicateAction } from '../../packages/core/src/adjudication';
import { recordQuiescence, reconcileSynthetic, releaseQuarantine } from '../../packages/core/src/reconciliation';
import { configureBudget, reserveCostForAction, costWorkspace } from '../../packages/core/src/costs';
import { adjudicationInput, type Scope } from '../../packages/contracts/src/index';
import { assertTransition } from '../../packages/core/src/index';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent = { id: localIds.agent, organization_id: scope.organization_id, brand_id: scope.brand_id, status: 'ONLINE' };
async function unknown(submitted = true, withCost = false) {
  const task = await createTask(scope, { title: 'Synthetic human adjudication', account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.publish, body: 'Original synthetic publication content', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, task.id, { decision: 'APPROVED', snapshot_hash: task.snapshot_hash }); const run = await enqueueTask(scope, task.id);
  const actionId = (await query('SELECT id FROM kff.actions WHERE run_id=$1', [run.id]))[0].id as string;
  if (withCost) {
    await configureBudget(scope, { request_id: randomUUID(), expected_version: 0, currency: 'QAA', minor_unit_exponent: 0, precision_source: 'Synthetic whole unit fixture', limit_minor: '100', reason: 'Synthetic human review cost check' });
    await scoped(scope, client => reserveCostForAction(client, actionId, { permit_id: null, currency: 'QAA', reserved_minor: '50', cost_basis: 'Synthetic estimate; no real billing' }));
  }
  expect(await dispatchOne()).toBe(true); const command = (await claimCommand(agent))!;
  if (submitted) await beginSubmission(agent, command.id);
  const report = { event_id: randomUUID(), command_id: command.id, outcome: submitted ? 'UNKNOWN_OUTCOME' as const : 'NEEDS_HUMAN' as const, diagnostic: { step: 'synthetic-human-review' } };
  await acceptReport(agent, report); return { task, run, actionId, command, report };
}
const close = (value: Awaited<ReturnType<typeof unknown>>) => recordQuiescence(agent, value.command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: value.command.id, action_id: value.actionId, closed_at: new Date().toISOString(), proof_sha256: 'a'.repeat(64) });
function decision(value: Awaited<ReturnType<typeof unknown>>, result: 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'INCONCLUSIVE' = 'CONFIRMED_SUCCESS') {
  return adjudicationInput.parse({ request_id: randomUUID(), expected_version: 0, expected_state: value.report.outcome, snapshot_hash: value.task.snapshot_hash, decision: result, evidence: { source: 'owned_fixture', external_account_id: value.task.snapshot.external_account_id, content_hash: value.task.snapshot.content_hash, remote_id: result === 'CONFIRMED_SUCCESS' ? 'synthetic_' + randomUUID() : null, observed_at: new Date().toISOString(), reference: 'synthetic-human-review/' + randomUUID(), failure_basis: result === 'CONFIRMED_FAILURE' ? 'FINAL_PLATFORM_REJECTION' : null, matched_original_submission: result !== 'INCONCLUSIVE' }, reason: 'Isolated synthetic evidence review; no actual platform conclusion', confirmation: 'I_REVIEWED_THIS_ORIGINAL_ACTION' });
}
beforeAll(async () => {
  const name = (await query('SELECT current_database() AS name'))[0].name;
  if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Isolated database required');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.content_versions,kff.audit_events,kff.cost_budgets CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=now() WHERE id=$1", [agent.id]);
  await query("UPDATE kff.environments SET state='IDLE'");
  await query('UPDATE kff.organizations SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); await query('UPDATE kff.accounts SET outbound_paused=false');
});
afterAll(closePool);

it('keeps inconclusive findings pending instead of counting a failure or permitting a resubmission', async () => {
  const value = await unknown();
  await expect(adjudicateAction(scope, value.run.id, decision(value))).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
  await adjudicateAction(scope, value.run.id, decision(value, 'INCONCLUSIVE'));
  expect((await runDetail(scope, value.run.id)).run).toMatchObject({ action_state: 'NEEDS_HUMAN', adjudication_version: 1 });
  expect((await workspace(scope)).totals).toMatchObject({ unknown: 1, failed: 0, verified: 0 });
  await expect(releaseQuarantine(scope, value.run.id)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  expect((await enqueueTask(scope, value.task.id)).id).toBe(value.run.id);
  expect(await dispatchOne()).toBe(false);
});
it('records a manual success without re-execution, cost settlement, capability promotion or automatic isolation release', async () => {
  const value = await unknown(true, true); await close(value);
  const input = decision(value); const record = await adjudicateAction(scope, value.run.id, input);
  const detail = await runDetail(scope, value.run.id);
  expect(record).toMatchObject({ reviewer_id: scope.user_id, result_version: 1, result_state: 'VERIFIED_SUCCEEDED' });
  expect(detail.run.receipt).toMatchObject({ evidence_kind: 'human_review', adjudication_id: input.request_id });
  expect(detail.attempts).toHaveLength(1); expect(detail.adjudications).toHaveLength(1);
  expect((await costWorkspace(scope)).reservations[0]).toMatchObject({ state: 'PENDING_RECONCILIATION', actual_cost_minor: null });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [localIds.environment]))[0].state).toBe('QUARANTINED');
  expect((await query('SELECT evidence_state FROM kff.capabilities WHERE id=$1', [localIds.publish]))[0].evidence_state).not.toBe('VERIFIED_REAL');
  expect((await query('SELECT count(*)::int AS count FROM kff.actions'))[0].count).toBe(1);
  expect(await dispatchOne()).toBe(false);
  await releaseQuarantine(scope, value.run.id);
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [localIds.environment]))[0].state).toBe('IDLE');
});
it('deduplicates concurrent identical reviews and ignores a delayed replay of the original unknown report', async () => {
  const value = await unknown(); await close(value); const input = decision(value);
  const records = await Promise.all(Array.from({ length: 8 }, () => adjudicateAction(scope, value.run.id, input)));
  expect(new Set(records.map(record => record.id)).size).toBe(1);
  await acceptReport(agent, value.report);
  expect((await runDetail(scope, value.run.id)).run.action_state).toBe('VERIFIED_SUCCEEDED');
  expect((await query("SELECT count(*)::int AS count FROM kff.audit_events WHERE event_type='action.human_adjudicated'"))[0].count).toBe(1);
  await expect(adjudicateAction(scope, value.run.id, { ...input, reason: 'Changed review under the original request identifier' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('allows only one of two conflicting final reviews to project the same version', async () => {
  const value = await unknown(); await close(value);
  const results = await Promise.allSettled([adjudicateAction(scope, value.run.id, decision(value)), adjudicateAction(scope, value.run.id, decision(value, 'CONFIRMED_FAILURE'))]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
  expect((await runDetail(scope, value.run.id)).adjudications).toHaveLength(1);
});
it('continues after an inconclusive review through an explicit event while older request replay cannot overwrite it', async () => {
  const value = await unknown(); const first = decision(value, 'INCONCLUSIVE'); await adjudicateAction(scope, value.run.id, first);
  await close(value);
  expect(() => assertTransition('NEEDS_HUMAN', 'VERIFIED_SUCCEEDED')).toThrow();
  await expect(query("UPDATE kff.actions SET state='VERIFIED_SUCCEEDED' WHERE id=$1", [value.actionId])).rejects.toThrow('INVALID_ACTION_TRANSITION');
  await expect(adjudicateAction(scope, value.run.id, decision(value))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  await adjudicateAction(scope, value.run.id, { ...decision(value), expected_state: 'NEEDS_HUMAN', expected_version: 1 });
  expect((await adjudicateAction(scope, value.run.id, first)).result_version).toBe(1);
  const detail = await runDetail(scope, value.run.id); expect(detail.run).toMatchObject({ action_state: 'VERIFIED_SUCCEEDED', adjudication_version: 2 });
  expect(detail.adjudications.map(record => record.decision)).toEqual(['INCONCLUSIVE', 'CONFIRMED_SUCCESS']);
});
it('rejects evidence for another account, content version, source scope or observation time', async () => {
  const value = await unknown(); await close(value); const input = decision(value);
  await expect(adjudicateAction(scope, value.run.id, { ...input, evidence: { ...input.evidence, external_account_id: '999' } })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  await expect(adjudicateAction(scope, value.run.id, { ...input, evidence: { ...input.evidence, content_hash: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(adjudicateAction(scope, value.run.id, { ...input, snapshot_hash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
  await expect(adjudicateAction(scope, value.run.id, { ...input, evidence: { ...input.evidence, source: 'platform_ui' } })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  for (const observed of ['2000-01-01T00:00:00.000Z', new Date(Date.now() + 120000).toISOString()]) await expect(adjudicateAction(scope, value.run.id, { ...input, evidence: { ...input.evidence, observed_at: observed } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('requires a durable submission intent before a write can be manually confirmed as successful', async () => {
  const value = await unknown(false); await close(value);
  await expect(adjudicateAction(scope, value.run.id, decision(value))).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  expect((await runDetail(scope, value.run.id)).adjudications).toHaveLength(0);
});
it('does not accept a missing record as proof of a final failure', async () => {
  const value = await unknown(); const input = decision(value, 'CONFIRMED_FAILURE');
  expect(adjudicationInput.safeParse({ ...input, evidence: { ...input.evidence, failure_basis: null } }).success).toBe(false);
  expect(adjudicationInput.safeParse({ ...input, evidence: { ...input.evidence, failure_basis: 'NOT_FOUND' } }).success).toBe(false);
  expect(adjudicationInput.safeParse({ ...input, evidence: { ...input.evidence, matched_original_submission: false } }).success).toBe(false);
  const pending = decision(value, 'INCONCLUSIVE'); expect(adjudicationInput.safeParse({ ...pending, evidence: { ...pending.evidence, matched_original_submission: true } }).success).toBe(false);
});
it('records a final rejection as a human finding and leaves automatic retries disabled', async () => {
  const value = await unknown(); await close(value);
  await adjudicateAction(scope, value.run.id, decision(value, 'CONFIRMED_FAILURE'));
  expect((await runDetail(scope, value.run.id)).run).toMatchObject({ action_state: 'VERIFIED_FAILED', error_code: 'MANUALLY_CONFIRMED_FAILURE', receipt: { evidence_kind: 'human_review', remote_id: null } });
  expect((await workspace(scope)).totals).toMatchObject({ unknown: 0, failed: 1, verified: 0 });
  expect(await dispatchOne()).toBe(false);
  expect((await enqueueTask(scope, value.task.id)).id).toBe(value.run.id);
});
it('prevents automatic reconciliation from overwriting the provenance of a manual finding', async () => {
  const value = await unknown(); await close(value); const input = decision(value);
  await adjudicateAction(scope, value.run.id, input);
  await expect(reconcileSynthetic(scope, value.run.id, async () => [{ id: input.evidence.remote_id, account_id: value.task.snapshot.external_account_id, action_id: value.actionId, body: value.task.snapshot.body, content_hash: value.task.snapshot.content_hash, created_at: new Date().toISOString() }])).rejects.toMatchObject({ code: 'MANUAL_DECISION_EXISTS' });
  expect((await runDetail(scope, value.run.id)).run.receipt?.evidence_kind).toBe('human_review');
});
it('keeps adjudication events immutable and requires a matching state projection in the same transaction', async () => {
  const value = await unknown(); await close(value); const input = decision(value);
  await expect(query('UPDATE kff.actions SET adjudication_version=1 WHERE id=$1', [value.actionId])).rejects.toThrow('ADJUDICATION_EVENT_REQUIRED');
  await adjudicateAction(scope, value.run.id, input);
  await expect(query("UPDATE kff.action_adjudications SET reason='replacement' WHERE id=$1", [input.request_id])).rejects.toThrow('IMMUTABLE_ADJUDICATION');
  await expect(query('DELETE FROM kff.action_adjudications WHERE id=$1', [input.request_id])).rejects.toThrow('IMMUTABLE_ADJUDICATION');
  await expect(query('INSERT INTO kff.action_adjudications(id,organization_id,brand_id,action_id,reviewer_id,request_hash,snapshot_hash,expected_version,result_version,previous_state,decision,result_state,evidence,reason) SELECT $1,organization_id,brand_id,action_id,reviewer_id,request_hash,snapshot_hash,1,2,previous_state,decision,result_state,evidence,reason FROM kff.action_adjudications WHERE id=$2', [randomUUID(), input.request_id])).rejects.toThrow('ADJUDICATION_PROJECTION_REQUIRED');
  expect((await runDetail(scope, value.run.id)).adjudications).toHaveLength(1);
});
it('scopes all reviews to the original brand and rejects non-admin adjudication', async () => {
  const value = await unknown(); await close(value); const input = decision(value);
  for (const role of ['operator', 'viewer'] as const) await expect(adjudicateAction({ ...scope, role }, value.run.id, input)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  const foreign = { ...scope, brand_id: randomUUID() };
  await expect(adjudicateAction(foreign, value.run.id, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await adjudicateAction(scope, value.run.id, input);
  expect(await scoped(foreign, async client => (await client.query('SELECT * FROM kff.action_adjudications')).rows)).toEqual([]);
});
