import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { digest } from '../../packages/core/src/index';
import { migrate } from '../../scripts/migrate';
import { localIds, seed } from '../../scripts/seed';
import { closePool, query } from '../../packages/database/src/index';
import { resultInput, quiescenceInput, uuid, type AgentCommand, type Scope } from '../../packages/contracts/src/index';
import { approveTask, createEnvironment, createTask, enqueueTask, stopRun } from '../../packages/core/src/service';
import { acceptReport, claimCommand, commandStatus, dispatchOne, recoverExpired, type AgentIdentity } from '../../packages/core/src/execution';
import { claimEnvironmentCommand, completeEnvironmentCommand, configureEnvironment, queueEnvironmentOperation } from '../../packages/core/src/environments';
import { recordQuiescence, releaseQuarantine } from '../../packages/core/src/reconciliation';
import { saveNoProgress } from '../../apps/agent/src/guardian-protocol';
import { flushActionJournal, type JournalEntry } from '../../apps/agent/src/action-journal';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent: AgentIdentity = { id: localIds.agent, organization_id: localIds.organization, brand_id: localIds.brand, status: 'ONLINE' };
const first = { account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.read };
let second: typeof first;

beforeAll(async () => {
  const database = (await query('SELECT current_database() AS name'))[0].name;
  if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Refusing non-isolated database');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.content_versions,kff.environment_commands,kff.audit_events,kff.cost_budgets CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1", [agent.id]);
  await query("UPDATE kff.environments SET state='IDLE'");
  const accountId = randomUUID(), capabilityId = randomUUID();
  const externalId = BigInt('0x' + accountId.replaceAll('-', '')).toString();
  // A distinct synthetic account prevents account/environment leases from masking the Agent gate.
  await query("INSERT INTO kff.accounts(id,organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,'Second closure fixture','kff','page',$4,'ACTIVE',true)", [accountId, scope.organization_id, scope.brand_id, externalId]);
  await query("INSERT INTO kff.capabilities(id,organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) SELECT $1,organization_id,brand_id,$2,capability_key,adapter_version,evidence_state,mode,is_synthetic,description FROM kff.capabilities WHERE id=$3", [capabilityId, accountId, localIds.read]);
  const environment = await createEnvironment(scope, { name: 'Second closure fixture', account_id: accountId, agent_id: agent.id });
  second = { account_id: accountId, environment_id: environment.id, capability_id: capabilityId };
  await configureEnvironment(scope, environment.id, { expected_version: 1, configuration: { driver: 'native', provider_profile_id: null, login_account_id: externalId, operating_identity_id: externalId, locale: 'en-US', timezone_id: 'America/New_York', proxy_ref: null } });
});
afterAll(closePool);

async function queue(binding = first) {
  const task = await createTask(scope, { ...binding, title: 'Closure gate fixture', body: '', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' });
  return enqueueTask(scope, task.id);
}
async function terminalCommand(state: 'DONE' | 'EXPIRED') {
  const run = await queue();
  expect(await dispatchOne()).toBe(true);
  const command = (await claimCommand(agent))!;
  expect(command).not.toBeNull();
  if (state === 'DONE') {
    await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: command.snapshot.external_account_id, actual_account_id: command.snapshot.external_account_id, evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: { step: 'fixture-read' } });
  } else {
    await query("UPDATE kff.resource_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE holder_attempt_id=$1", [command.attempt_id]);
    expect(await recoverExpired()).toBe(1);
  }
  expect((await query('SELECT state,quiesced_at FROM kff.agent_commands WHERE id=$1', [command.id]))[0]).toEqual({ state, quiesced_at: null });
  return { command, run };
}
async function close(command: AgentCommand) {
  await recordQuiescence(agent, command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) });
}

it.each(['DONE', 'EXPIRED'] as const)('keeps another account queued without attempts until %s command closure', async state => {
  const { command, run } = await terminalCommand(state);
  const pending = await queue(second);
  expect(await dispatchOne()).toBe(false);
  expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(1);
  expect((await query('SELECT state FROM kff.actions WHERE run_id=$1', [pending.id]))[0].state).toBe('QUEUED');
  await close(command);
  if (state === 'EXPIRED') await releaseQuarantine(scope, run.id);
  await query('UPDATE kff.jobs SET available_at=clock_timestamp() WHERE action_id IN (SELECT id FROM kff.actions WHERE run_id=$1)', [pending.id]);
  expect(await dispatchOne()).toBe(true);
  expect((await claimCommand(agent))?.run_id).toBe(pending.id);
  expect((await query('SELECT state FROM kff.actions WHERE run_id=$1', [run.id]))[0].state).toBe(state === 'DONE' ? 'VERIFIED_SUCCEEDED' : 'NEEDS_HUMAN');
});

it.each(['DONE', 'EXPIRED'] as const)('keeps another account environment check queued until %s command closure', async state => {
  const { command } = await terminalCommand(state);
  const pending = await queueEnvironmentOperation(scope, second.environment_id, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  expect(await claimEnvironmentCommand(agent)).toBeNull();
  expect((await query('SELECT state FROM kff.environment_commands WHERE id=$1', [pending.id]))[0].state).toBe('QUEUED');
  expect(await query('SELECT resource_id FROM kff.resource_leases WHERE holder_control_id=$1', [pending.id])).toHaveLength(0);
  await close(command);
  expect((await claimEnvironmentCommand(agent))?.id).toBe(pending.id);
});

it.each(['DONE', 'EXPIRED'] as const)('refuses an already dispatched legacy command while another %s command lacks closure', async state => {
  const { command } = await terminalCommand(state);
  // Reproduce a pre-fix READY backlog. Only isolated fixture setup bypasses dispatch's new gate.
  await query('UPDATE kff.agent_commands SET quiesced_at=clock_timestamp() WHERE id=$1', [command.id]);
  const pending = await queue(second);
  expect(await dispatchOne()).toBe(true);
  await query('UPDATE kff.agent_commands SET quiesced_at=NULL WHERE id=$1', [command.id]);
  expect(await claimCommand(agent)).toBeNull();
  expect((await query('SELECT c.state,c.claimed_at FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id WHERE a.run_id=$1', [pending.id]))[0]).toEqual({ state: 'READY', claimed_at: null });
  await close(command);
  expect((await claimCommand(agent))?.run_id).toBe(pending.id);
});

it('does not let a never-claimed canceled command block subsequent work', async () => {
  const run = await queue();
  expect(await dispatchOne()).toBe(true);
  await stopRun(scope, run.id, 'Fixture cancellation before claim');
  await recoverExpired();
  expect((await query('SELECT c.quiesced_at FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id WHERE a.run_id=$1', [run.id]))[0].quiesced_at).not.toBeNull();
  const pending = await queue(second);
  expect(await dispatchOne()).toBe(true);
  expect((await claimCommand(agent))?.run_id).toBe(pending.id);
});

it('refuses a legacy READY task while an environment operation holds the Agent', async () => {
  const pending = await queue();
  expect(await dispatchOne()).toBe(true);
  const operation = await queueEnvironmentOperation(scope, second.environment_id, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  // Reproduce concurrent records from an older controller in this synthetic database only.
  await query("UPDATE kff.environment_commands SET state='RUNNING' WHERE id=$1", [operation.id]);
  expect(await claimCommand(agent)).toBeNull();
  await completeEnvironmentCommand(agent, operation.id, { context_closed: true, outcome: 'CLOSED' });
  expect((await claimCommand(agent))?.run_id).toBe(pending.id);
});

/**
 * Four facts travel together and none of them implies the next: the command's lifecycle, the guardian's
 * execution quiescence, the process tree's termination and the browser environment's closure. The three
 * tests below pin the two implications that are easy to assume and must never hold - a quiesced guardian
 * is not a closed browser, and an expired command is not a quiesced guardian - and they do it through the
 * production functions the agent's own routes call. The journal test goes one step further and drives the
 * real flush against them, because retention sits between the record and the controller and is exactly
 * where a safety fact can be lost.
 */
type TreeState = 'DEAD' | 'ALIVE' | 'UNKNOWN';
const termination = (tree: TreeState) => ({ process_tree: tree, tool: 'ERROR' as const, root: 'ALIVE' as const, descendants: 'DEAD' as const, sampled: 0, enumeration: 'UNAVAILABLE' as const, elapsed_ms: 30 });
const noProgressProof = (command: AgentCommand, tree: TreeState) => ({ protocol_version: 'kff.guardian-closure-no-progress.v1' as const, command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'a'.repeat(64), process_tree: tree });
async function refusal(body: () => Promise<unknown>) { try { await body(); return null; } catch (error) { return error as Error & { code?: string }; } }
async function claimed(binding = first) {
  const run = await queue(binding);
  expect(await dispatchOne()).toBe(true);
  const command = await claimCommand(agent);
  expect(command).not.toBeNull();
  return { command: command!, run };
}
async function expired(binding = first) {
  const started = await claimed(binding);
  await query("UPDATE kff.resource_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE holder_attempt_id=$1", [started.command.attempt_id]);
  expect(await recoverExpired()).toBe(1);
  return started;
}
const environmentState = async (id: string) => (await query<{ state: string }>('SELECT state FROM kff.environments WHERE id=$1', [id]))[0].state;
const commandRow = async (id: string) => (await query<{ state: string; quiesced_at: Date | null }>('SELECT state,quiesced_at FROM kff.agent_commands WHERE id=$1', [id]))[0];
const actionRow = async (runId: string) => (await query<{ state: string; error_code: string | null }>('SELECT state,error_code FROM kff.actions WHERE run_id=$1', [runId]))[0];
const reported = async () => (await query<{ details: Record<string, unknown> }>("SELECT details FROM kff.audit_events WHERE event_type='action.reported'")).map(row => row.details);
/** The transport, and only the transport: the same three calls the agent's controller routes make. */
function controller() {
  return async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint === 'action-reports') return await acceptReport(agent, resultInput.parse(data)) as T;
    const parts = endpoint.split('/');
    if (parts.length === 3 && parts[0] === 'commands' && parts[2] === 'status') return await commandStatus(agent, uuid.parse(parts[1])) as T;
    if (parts.length === 3 && parts[0] === 'commands' && parts[2] === 'quiescence') return await recordQuiescence(agent, uuid.parse(parts[1]), quiescenceInput.parse(data)) as T;
    throw new Error('Unexpected endpoint ' + endpoint);
  };
}

it('refuses to release an environment on a termination proof even when the tree was proven dead', async () => {
  // A command the controller had to expire: nothing was reported, so the environment is quarantined.
  const { command, run } = await expired();
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
  // The agent's proof is admissible here - the tree is dead, so the slot may be reused - and that is
  // exactly as far as it goes: the same record says nothing about the browser.
  await recordQuiescence(agent, command.id, noProgressProof(command, 'DEAD'));
  expect((await commandRow(command.id)).quiesced_at).not.toBeNull();
  // Every other release gate passes: the action is terminal and no submission intent was ever recorded.
  expect(await actionRow(run.id)).toEqual({ state: 'NEEDS_HUMAN', error_code: 'LEASE_EXPIRED' });
  const refused = await refusal(() => releaseQuarantine(scope, run.id));
  expect(refused?.code).toBe('GUARDIAN_UNCONFIRMED');
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
  // The control: the same release path, on the same kind of run, holding a proof that a context was
  // closed. It releases - and it releases only the environment that proof belongs to.
  const control = await expired(second);
  await close(control.command);
  expect(await releaseQuarantine(scope, control.run.id)).toEqual({ released: true });
  expect(await environmentState(second.environment_id)).toBe('IDLE');
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
});

/**
 * The journal a restarted Agent finds when the parent died between a forced termination and the flush:
 * the page is long expired and no report was ever produced, so retention has to synthesize one - from
 * the record, which is the only place the process fact exists. The record and the journal are written by
 * the production writers, with the command's real identity, so the flush below is the real one.
 */
const journalRoots: string[] = [];
afterAll(() => {
  for (const root of journalRoots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-journal-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
function expiredNoProgressJournal(command: AgentCommand, tree: TreeState) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-journal-')), runtime = path.join(root, '.kff');
  journalRoots.push(root);
  const nonce = digest(randomUUID());
  saveNoProgress(runtime, { command_id: command.id, action_id: command.action_id, nonce, phase: 'submitting', termination: termination(tree), context_opened: true, submission_state: 'UNKNOWN', forced: true, waited_ms: 900000, grace_ms: 15000, result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } } });
  const entry: JournalEntry = { command_id: command.id, action_id: command.action_id, phase: 'submitting', guardian_nonce: nonce, collection_expires_at: new Date(Date.now() - 1000).toISOString() };
  const journal = { [command.id]: entry }, file = path.join(runtime, 'agent', 'journal.json');
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); };
  save();
  return { runtime, entry, journal, save };
}

it('keeps a no-progress termination quarantined through retention expiry and recovery', async () => {
  const { command, run } = await claimed();
  const journal = expiredNoProgressJournal(command, 'UNKNOWN');
  const failure = await refusal(() => flushActionJournal(journal.runtime, journal.journal, journal.save, controller()));
  // The report was accepted. The proof was not: an unproven tree may not free the execution slot, and
  // the refusal is what leaves the journal entry unfinished instead of silently releasing the browser.
  expect(failure?.code).toBe('GUARDIAN_UNCONFIRMED');
  expect(journal.entry).toMatchObject({ acknowledged: true });
  expect(journal.entry.quiesced).toBeUndefined();
  expect(journal.entry.collection_redaction?.reason).toBe('RETENTION_EXPIRED');
  expect(journal.entry.report?.collection_page).toBeUndefined();
  // What the controller recorded is the process fact and not the retention story. This is the assertion
  // that fails when retention replaces the report without carrying the guardian's termination across:
  // the page expires, the report becomes a generic BLOCKED, and the environment is handed back IDLE.
  const events = await reported();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ outcome: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS', guardian_tree: 'UNKNOWN', command_completed: false });
  expect(await commandRow(command.id)).toEqual({ state: 'CLAIMED', quiesced_at: null });
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
  // The worker still owns the command's lifecycle: it may expire it. That is not quiescence, and it is
  // not a reason to hand the environment back, so `quiesced_at` stays null and the environment stays
  // where the report left it. The action keeps the outcome and the error code the report gave it.
  expect(await recoverExpired()).toBe(1);
  expect(await commandRow(command.id)).toEqual({ state: 'EXPIRED', quiesced_at: null });
  expect(await actionRow(run.id)).toEqual({ state: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS' });
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
  // Even after the command is terminal, the same proof is still refused, and the ordinary release path
  // is shut. It shuts early here - the retention report left the action BLOCKED, which is not a state
  // the release path accepts at all - and the proof gate behind it, the one that refuses a termination
  // record even for a NEEDS_HUMAN action, is what the test above exercises.
  expect((await refusal(() => recordQuiescence(agent, command.id, noProgressProof(command, 'UNKNOWN'))))?.code).toBe('GUARDIAN_UNCONFIRMED');
  expect((await refusal(() => releaseQuarantine(scope, run.id)))?.code).toBe('SUBMISSION_UNCERTAIN');
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
});

it('completes a command on a proven-dead tree and still refuses to release its environment', async () => {
  const { command, run } = await claimed();
  await acceptReport(agent, { event_id: randomUUID(), command_id: command.id, outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS', guardian: termination('DEAD'), diagnostic: { step: 'guardian-no-progress' } });
  // A proven-dead tree is what licenses reusing the slot, so the command completes - and it is the only
  // thing that changed: a termination record never claims a browser was closed.
  expect(await commandRow(command.id)).toEqual({ state: 'DONE', quiesced_at: null });
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
  const events = await reported();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS', guardian_tree: 'DEAD', command_completed: true });
  await recordQuiescence(agent, command.id, noProgressProof(command, 'DEAD'));
  expect((await commandRow(command.id)).quiesced_at).not.toBeNull();
  expect((await refusal(() => releaseQuarantine(scope, run.id)))?.code).toBe('GUARDIAN_UNCONFIRMED');
  expect(await environmentState(first.environment_id)).toBe('QUARANTINED');
});
