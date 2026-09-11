import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { createTask, approveTask, enqueueTask, stopRun, createEnvironment, createAccount, workspace, runDetail, setBrandPause } from '../../packages/core/src/service';
import { dispatchOne, claimCommand, beginSubmission, acceptReport, agentHeartbeat, recoverExpired, authenticateAgent, type AgentIdentity } from '../../packages/core/src/execution';
import type { ActionReport, Scope } from '../../packages/contracts/src/index';
import { exportDiagnostic, reconcileSynthetic, releaseQuarantine, recordQuiescence } from '../../packages/core/src/reconciliation';
import { createPermit, findPermit } from '../../packages/core/src/permits';
import { adapterImplementationDigest } from '../../packages/core/src/artifacts';
import { setOrganizationPause, setAccountPause, createAgent, controlAgent } from '../../packages/core/src/controls';
import { configureBudget, reconcileCost } from '../../packages/core/src/costs';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent: AgentIdentity = { id: localIds.agent, organization_id: localIds.organization, brand_id: localIds.brand, status: 'ONLINE' };
const previousGraphVersion = process.env.KFF_FACEBOOK_GRAPH_VERSION;
function input(write = false) { return { title: 'Isolated integration task', account_id: localIds.account, environment_id: localIds.environment, capability_id: write ? localIds.publish : localIds.read, body: write ? 'An explicit synthetic content version' : '', mode: 'TEST_ONLY' as const, fixture_scenario: 'normal' as const, idempotency_key: randomUUID() }; }
async function queued(write = false) {
  const task = await createTask(scope, input(write));
  await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' });
  return { task, run: await enqueueTask(scope, task.id) };
}
async function claimed(write = false) { const result = await queued(write); expect(await dispatchOne()).toBe(true); const command = await claimCommand(agent); expect(command).not.toBeNull(); return { ...result, command: command! }; }
beforeAll(async () => {
  process.env.KFF_FACEBOOK_GRAPH_VERSION = 'v99.0';
  if (!process.env.KFF_TEST_DATABASE?.startsWith('kff_test_')) throw new Error('Refusing non-isolated database');
  await migrate(); await seed();
});
beforeEach(async () => {
  // This guard is authoritative: destructive fixture cleanup is restricted to the newly created test database.
  const database = (await query<{ name: string }>('SELECT current_database() AS name'))[0].name;
  if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Wrong database');
  await query('TRUNCATE kff.content_versions,kff.audit_events,kff.cost_budgets CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=now() WHERE id=$1", [agent.id]);
  await query("UPDATE kff.environments SET state='IDLE'");
  await query('UPDATE kff.brands SET outbound_paused=false');
  await query('UPDATE kff.organizations SET outbound_paused=false');
  await query('UPDATE kff.accounts SET outbound_paused=false');
});
afterAll(async () => { if (previousGraphVersion === undefined) delete process.env.KFF_FACEBOOK_GRAPH_VERSION; else process.env.KFF_FACEBOOK_GRAPH_VERSION = previousGraphVersion; await closePool(); });

describe('Postgres execution and failure boundaries', () => {
  it('atomically deduplicates concurrent create requests and content versions', async () => {
    const value = input(); const tasks = await Promise.all(Array.from({ length: 8 }, () => createTask(scope, value)));
    expect(new Set(tasks.map(task => task.id)).size).toBe(1);
    expect((await query('SELECT count(*)::int AS count FROM kff.content_versions'))[0].count).toBe(1);
    await expect(createTask(scope, { ...value, title: 'Different intent' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('requires an approval of the immutable snapshot', async () => {
    const task = await createTask(scope, input());
    await expect(enqueueTask(scope, task.id)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    await expect(approveTask(scope, task.id, { snapshot_hash: '0'.repeat(64), decision: 'APPROVED' })).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    await expect(query("UPDATE kff.tasks SET snapshot='{}' WHERE id=$1", [task.id])).rejects.toThrow('IMMUTABLE_TASK_SNAPSHOT');
    expect((await query('SELECT count(*)::int AS count FROM kff.approval_decisions'))[0].count).toBe(0);
  });
  it('creates exactly one run, action and durable job for repeated enqueues', async () => {
    const { task, run } = await queued(); const repeats = await Promise.all(Array.from({ length: 8 }, () => enqueueTask(scope, task.id)));
    expect(repeats.every(value => value.id === run.id)).toBe(true);
    for (const table of ['runs', 'actions', 'jobs']) expect((await query('SELECT count(*)::int AS count FROM kff.' + table))[0].count).toBe(1);
  });
  it('keeps a stopped queued action canceled and never dispatches it', async () => {
    const { run } = await queued(true); await stopRun(scope, run.id, 'Test stop before dispatch');
    expect(await dispatchOne()).toBe(false);
    expect((await query('SELECT state FROM kff.actions WHERE run_id=$1', [run.id]))[0].state).toBe('CANCELED');
    expect((await workspace(scope)).totals.verified).toBe(0);
  });
  it('blocks cross-brand reads even for another brand in the same organization', async () => {
    const otherBrand = randomUUID(); await query('INSERT INTO kff.brands(id,organization_id,name) VALUES($1,$2,$3)', [otherBrand, scope.organization_id, 'Other test brand']);
    const result = await scoped({ ...scope, brand_id: otherBrand }, client => client.query('SELECT id FROM kff.accounts'));
    expect(result.rowCount).toBe(0);
    await expect(createEnvironment({ ...scope, brand_id: otherBrand }, { name: 'Wrong-brand environment', account_id: localIds.account, agent_id: localIds.agent })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    await expect(query('INSERT INTO kff.environments(organization_id,brand_id,name,account_id,agent_id) VALUES($1,$2,$3,$4,$5)', [scope.organization_id, otherBrand, 'Privileged FK negative', localIds.account, localIds.agent])).rejects.toMatchObject({ code: '23503' });
  });
  it('rejects mutations by viewers', async () => { await expect(createTask({ ...scope, role: 'viewer' }, input())).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' }); });
  it('does not dispatch when the bound Agent is offline', async () => {
    await queued(); await query("UPDATE kff.agents SET status='OFFLINE' WHERE id=$1", [agent.id]);
    expect(await dispatchOne()).toBe(false); expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(0);
  });
  it('allocates one Agent slot across different environments and concurrent dispatchers', async () => {
    await queued();
    const environment = await createEnvironment(scope, { name: 'Another isolated profile', account_id: localIds.account, agent_id: agent.id });
    const task = await createTask(scope, { ...input(), environment_id: environment.id });
    await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' }); await enqueueTask(scope, task.id);
    const results = await Promise.all([dispatchOne(), dispatchOne(), dispatchOne()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await dispatchOne()).toBe(false);
    expect((await query("SELECT count(*)::int AS count FROM kff.agent_commands WHERE state IN ('READY','CLAIMED')"))[0].count).toBe(1);
    expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(1);
  });
  it('accepts a scoped read receipt once and rejects a changed replay', async () => {
    const { command } = await claimed();
    const report: ActionReport = { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: '100000000000000001', actual_account_id: '100000000000000001', evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: { step: 'read-verified' } };
    expect(await acceptReport(agent, report)).toEqual({ accepted: true, duplicate: false });
    expect(await acceptReport(agent, report)).toEqual({ accepted: true, duplicate: true });
    await expect(acceptReport(agent, { ...report, error_code: 'CHANGED' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await query('SELECT count(*)::int AS count FROM kff.diagnostic_bundles'))[0].count).toBe(1);
  });
  it('rejects a wrong-account receipt and success without a write intent', async () => {
    const { command, task } = await claimed(true);
    const report: ActionReport = { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: 'synthetic_post', actual_account_id: '999', content_hash: task.snapshot.content_hash, evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: { step: 'write-verified' } };
    await expect(acceptReport(agent, report)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    await expect(acceptReport(agent, { ...report, receipt: { ...report.receipt!, actual_account_id: task.snapshot.external_account_id } })).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  });
  it('blocks another write attempt and preserves unknown outcome with isolated resources', async () => {
    const { command, run } = await claimed(true);
    await beginSubmission(agent, command.id);
    await expect(beginSubmission(agent, command.id)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
    await stopRun(scope, run.id, 'Stop after submit');
    await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'UNKNOWN_OUTCOME', error_code: 'NETWORK_LOST', diagnostic: { step: 'submitted' } });
    expect((await query('SELECT state FROM kff.actions WHERE run_id=$1', [run.id]))[0].state).toBe('UNKNOWN_OUTCOME');
    expect((await query('SELECT count(*)::int AS count FROM kff.resource_leases WHERE quarantined AND holder_attempt_id IS NOT NULL'))[0].count).toBe(2);
    await queued(true); expect(await dispatchOne()).toBe(false);
  });
  it('honors stop at the final submission gate', async () => {
    const { command, run } = await claimed(true); await stopRun(scope, run.id, 'Stop in preparation');
    await expect(beginSubmission(agent, command.id)).rejects.toMatchObject({ code: 'STOP_REQUESTED' });
    expect((await query('SELECT submitted_at FROM kff.action_attempts WHERE id=$1', [command.attempt_id]))[0].submitted_at).toBeNull();
  });
  const pause = {
    account: () => setAccountPause(scope, localIds.account, true, 'Test account pause'),
    brand: () => setBrandPause(scope, true),
    organization: () => setOrganizationPause(scope, true, 'Test organization pause'),
    agent: () => controlAgent(scope, agent.id, { action: 'DRAIN', reason: 'Test Agent drain' }),
  };
  it.each(Object.keys(pause) as (keyof typeof pause)[])('rejects new submissions after %s pause', async target => {
    const { command } = await claimed(true); await pause[target]();
    await expect(beginSubmission(agent, command.id)).rejects.toMatchObject({ code: 'STOP_REQUESTED' });
    expect((await agentHeartbeat(agent, command.id)).continue).toBe(false);
    expect((await query('SELECT submitted_at FROM kff.action_attempts WHERE id=$1', [command.attempt_id]))[0].submitted_at).toBeNull();
  });
  it.each(Object.keys(pause) as (keyof typeof pause)[])('orders concurrent submission and %s pause without hiding an in-flight action', async target => {
    const { command } = await claimed(true);
    const [submit, stop] = await Promise.allSettled([beginSubmission(agent, command.id), pause[target]()]);
    expect(stop.status).toBe('fulfilled');
    const status = (await query('SELECT state FROM kff.actions WHERE id=$1', [command.action_id]))[0].state;
    if (submit.status === 'fulfilled') { expect(status).toBe('SUBMITTING'); if (stop.status === 'fulfilled') expect(stop.value.in_flight).toBe(1); }
    else { expect(submit.reason).toMatchObject({ code: 'STOP_REQUESTED' }); expect(status).toBe('PREPARING'); if (stop.status === 'fulfilled') expect(stop.value.in_flight).toBe(0); }
  });
  it('does not give organization controls to a brand administrator without organization membership', async () => {
    await expect(setOrganizationPause({ ...scope, user_id: randomUUID() }, true, 'Unauthorized organization stop')).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    expect((await query('SELECT outbound_paused FROM kff.organizations WHERE id=$1', [scope.organization_id]))[0].outbound_paused).toBe(false);
  });
  it('cancels an unclaimed command with explicit proof it never reached an executor', async () => {
    const { run } = await queued(true); expect(await dispatchOne()).toBe(true);
    await setAccountPause(scope, localIds.account, true, 'Stop before claim'); expect(await claimCommand(agent)).toBeNull(); expect(await recoverExpired()).toBe(1);
    expect(await claimCommand(agent)).toBeNull();
    expect((await query('SELECT state FROM kff.actions WHERE run_id=$1', [run.id]))[0].state).toBe('CANCELED');
    expect((await query('SELECT count(*)::int AS count FROM kff.resource_leases WHERE holder_attempt_id IS NOT NULL OR quarantined'))[0].count).toBe(0);
    expect((await query('SELECT quiesced_at FROM kff.agent_commands'))[0].quiesced_at).not.toBeNull();
  });
  it('pairs with a hashed credential and makes revocation permanent', async () => {
    const created = await createAgent(scope, { name: 'Isolated token lifecycle test' });
    const token = created.configuration.token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await query('SELECT token_hash FROM kff.agents WHERE id=$1', [created.agent.id]))[0].token_hash).not.toBe(token);
    expect((await workspace(scope)).agents.find(value => value.id === created.agent.id)).not.toHaveProperty('token_hash');
    const request = () => new Request('http://127.0.0.1/api/agent/claims', { headers: { Authorization: 'Bearer ' + token } });
    const paired = await authenticateAgent(request()); expect(paired.id).toBe(created.agent.id);
    await controlAgent(scope, paired.id, { action: 'DRAIN', reason: 'Test drain' }); await agentHeartbeat(paired);
    expect(await claimCommand(paired)).toBeNull();
    await controlAgent(scope, paired.id, { action: 'RESUME', reason: 'Test resume' }); await agentHeartbeat(paired);
    await controlAgent(scope, paired.id, { action: 'REVOKE', reason: 'Test revocation' });
    await expect(authenticateAgent(request())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(controlAgent(scope, paired.id, { action: 'RESUME', reason: 'Must remain revoked' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it.each([false, true])('does not steal expired leases or replay an expired action (submitted=%s)', async submitted => {
    const { command } = await claimed(submitted); if (submitted) await beginSubmission(agent, command.id);
    await query("UPDATE kff.resource_leases SET expires_at=now()-interval '1 second' WHERE holder_attempt_id=$1", [command.attempt_id]);
    await expect(agentHeartbeat(agent, command.id)).rejects.toMatchObject({ code: 'LEASE_STALE' });
    expect(await recoverExpired()).toBe(1);
    expect((await query('SELECT state FROM kff.actions WHERE id=$1', [command.action_id]))[0].state).toBe(submitted ? 'UNKNOWN_OUTCOME' : 'NEEDS_HUMAN');
    expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(1);
    expect((await query('SELECT count(*)::int AS count FROM kff.jobs WHERE state=$1', ['READY']))[0].count).toBe(0);
  });
  it('keeps an unknown result until positive evidence and guardian closure are both recorded', async () => {
    const { command, task, run } = await claimed(true); await beginSubmission(agent, command.id);
    await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'UNKNOWN_OUTCOME', diagnostic: { step: 'submitted' } });
    expect((await reconcileSynthetic(scope, run.id, async () => [])).reconciled).toBe(false);
    expect((await query('SELECT state FROM kff.actions WHERE id=$1', [command.action_id]))[0].state).toBe('UNKNOWN_OUTCOME');
    await expect(releaseQuarantine(scope, run.id)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
    const post = { id: 'synthetic_' + randomUUID(), account_id: task.snapshot.external_account_id, action_id: command.action_id, body: task.snapshot.body, content_hash: task.snapshot.content_hash, created_at: new Date().toISOString() };
    expect((await reconcileSynthetic(scope, run.id, async () => [post, { ...post, id: 'synthetic_' + randomUUID() }])).reconciled).toBe(false);
    expect((await reconcileSynthetic(scope, run.id, async () => [post])).reconciled).toBe(true);
    await expect(releaseQuarantine(scope, run.id)).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
    const proof = { protocol_version: 'kff.guardian-closure.v1' as const, command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'a'.repeat(64) };
    await expect(recordQuiescence(agent, command.id, { ...proof, action_id: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    await recordQuiescence(agent, command.id, proof); await recordQuiescence(agent, command.id, proof);
    await expect(recordQuiescence(agent, command.id, { ...proof, proof_sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await query("SELECT count(*)::int AS count FROM kff.audit_events WHERE event_type='guardian.quiesced'"))[0].count).toBe(1);
    expect(await releaseQuarantine(scope, run.id)).toEqual({ released: true });
    expect((await query('SELECT count(*)::int AS count FROM kff.actions'))[0].count).toBe(1);
    expect((await query('SELECT count(*)::int AS count FROM kff.resource_leases WHERE quarantined'))[0].count).toBe(0);
  });
  it('exports diagnostics only after scope, permission and content checks with an audit event', async () => {
    const { command, run } = await claimed();
    await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'BLOCKED', error_code: 'AUTH_EXPIRED', diagnostic: { step: 'identity', scene: { identity_count: 0, submit_controls: 0, result_count: 0 } } });
    const bundle = (await query('SELECT id FROM kff.diagnostic_bundles'))[0];
    expect((await runDetail(scope, run.id)).diagnostics[0].manifest).toEqual({ level: 'D1' });
    await expect(exportDiagnostic({ ...scope, role: 'viewer' }, bundle.id)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    expect((await exportDiagnostic(scope, bundle.id)).level).toBe('D1');
    expect((await query("SELECT count(*)::int AS count FROM kff.audit_events WHERE event_type='diagnostic.exported'"))[0].count).toBe(1);
    await query("UPDATE kff.diagnostic_bundles SET manifest=(manifest-ARRAY['protocol_version','adapter_version','attempt_id','outcome','duration_ms','executor_version','browser_version']) || '{\"schema_version\":\"kff.diagnostic.v1\"}'::jsonb WHERE id=$1", [bundle.id]);
    expect((await exportDiagnostic(scope, bundle.id)).schema_version).toBe('kff.diagnostic.v1');
    await query("UPDATE kff.diagnostic_bundles SET manifest=manifest || '{\"cookie\":\"SENSITIVE_SENTINEL\"}'::jsonb WHERE id=$1", [bundle.id]);
    await expect(exportDiagnostic(scope, bundle.id)).rejects.toMatchObject({ code: 'DIAGNOSTIC_REDACTION_FAILED' });
  });
  it('reserves a controlled read exactly once, rejects expiry and keeps scope immutable', async () => {
    await configureBudget(scope, { request_id: randomUUID(), expected_version: 0, currency: 'USD', minor_unit_exponent: 2, precision_source: 'Synthetic test precision rule', limit_minor: '100', reason: 'Isolated contract test budget' });
    const account = await createAccount(scope, { display_name: 'Contract-only Facebook account', external_id: '90909090', platform: 'facebook', account_type: 'page', credential_ref: 'FACEBOOK_TEST_CREDENTIAL' });
    const environment = await createEnvironment(scope, { name: 'Contract test environment', account_id: account.id, agent_id: agent.id });
    const capability = (await query("UPDATE kff.capabilities SET mode='CONTROLLED_PILOT',evidence_state='IMPLEMENTED_TEST_ONLY',implementation_digest=$2 WHERE account_id=$1 AND capability_key='facebook.page.read.api' RETURNING id", [account.id, adapterImplementationDigest(process.cwd(), 'facebook')]))[0];
    const task = await createTask(scope, { ...input(), account_id: account.id, environment_id: environment.id, capability_id: capability.id, mode: 'CONTROLLED_PILOT' });
    await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' });
    const permit = await createPermit(scope, { task_id: task.id, max_actions: 1, starts_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), currency: 'USD', max_cost_minor: '100', per_action_max_minor: '75', cost_basis: 'Synthetic test ledger; no actual billing', authorization_evidence: 'Synthetic authorization; no external operations', platform_conditions: 'Contract test fixtures only; no Graph access', expected_evidence: 'page_identity', stop_rule: 'stop_on_first_unknown_or_failure', confirmation: 'I_CONFIRM_THIS_EXACT_SCOPE' });
    await expect(query('UPDATE kff.pilot_permits SET target_id=$1 WHERE id=$2', ['999', permit.id])).rejects.toThrow('IMMUTABLE_PILOT_SCOPE');
    const run = (await query('INSERT INTO kff.runs(organization_id,brand_id,task_id) VALUES($1,$2,$3) RETURNING id', [scope.organization_id, scope.brand_id, task.id]))[0];
    const action = (await query('INSERT INTO kff.actions(organization_id,brand_id,run_id,task_id) VALUES($1,$2,$3,$4) RETURNING id', [scope.organization_id, scope.brand_id, run.id, task.id]))[0];
    await Promise.all(Array.from({ length: 8 }, () => scoped(scope, client => findPermit(client, task.id, task.snapshot, action.id))));
    expect((await query('SELECT reserved_actions,reserved_cost_minor FROM kff.pilot_permits WHERE id=$1', [permit.id]))[0]).toEqual({ reserved_actions: 1, reserved_cost_minor: '75' });
    await expect(scoped(scope, client => findPermit(client, task.id, task.snapshot))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(query('UPDATE kff.pilot_permits SET reserved_actions=0 WHERE id=$1', [permit.id])).rejects.toThrow('PILOT_RESERVATION_CANNOT_RESET');
    await stopRun(scope, run.id, 'Cancel isolated test before dispatch');
    await reconcileCost(scope, action.id, { request_id: randomUUID(), expected_version: 1, decision: 'RELEASE', actual_cost_minor: '0', evidence_ref: 'synthetic/no-charge-confirmation', note: 'Synthetic zero-charge bill; no external request was sent', confirmation: 'I_RECONCILED_THIS_COST' });
    expect((await query('SELECT reserved_actions,reserved_cost_minor FROM kff.pilot_permits WHERE id=$1', [permit.id]))[0]).toEqual({ reserved_actions: 1, reserved_cost_minor: '75' });
    await expect(scoped(scope, client => findPermit(client, task.id, task.snapshot, action.id))).rejects.toMatchObject({ code: 'COST_ALREADY_FINAL' });
    await query('UPDATE kff.pilot_permits SET revoked_at=now() WHERE id=$1', [permit.id]);
    await expect(scoped(scope, client => findPermit(client, task.id, task.snapshot, action.id))).rejects.toMatchObject({ code: 'PILOT_PERMIT_REQUIRED' });
  });
});
