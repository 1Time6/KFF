import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { localIds, seed } from '../../scripts/seed';
import { closePool, query } from '../../packages/database/src/index';
import type { AgentCommand, Scope } from '../../packages/contracts/src/index';
import { approveTask, createEnvironment, createTask, enqueueTask, stopRun } from '../../packages/core/src/service';
import { acceptReport, claimCommand, dispatchOne, recoverExpired, type AgentIdentity } from '../../packages/core/src/execution';
import { claimEnvironmentCommand, completeEnvironmentCommand, configureEnvironment, queueEnvironmentOperation } from '../../packages/core/src/environments';
import { recordQuiescence, releaseQuarantine } from '../../packages/core/src/reconciliation';

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
