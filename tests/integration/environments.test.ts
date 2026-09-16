import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { createEnvironment, createTask, approveTask, enqueueTask, createAccount } from '../../packages/core/src/service';
import { createAgent } from '../../packages/core/src/controls';
import { configureEnvironment, queueEnvironmentOperation, claimEnvironmentCommand, environmentHeartbeat, completeEnvironmentCommand, recoverEnvironmentCommands, controlEnvironment, environmentWorkspace } from '../../packages/core/src/environments';
import { dispatchOne, claimCommand, beginSubmission, recordBrowserOpened, type AgentIdentity } from '../../packages/core/src/execution';
import type { Scope } from '../../packages/contracts/src/index';
import type { BrowserConfiguration } from '../../packages/contracts/src/environment';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent: AgentIdentity = { id: localIds.agent, organization_id: localIds.organization, brand_id: localIds.brand, status: 'ONLINE' };
const configuration: BrowserConfiguration = { driver: 'native', provider_profile_id: null, login_account_id: '100000000000000001', operating_identity_id: '100000000000000001', locale: 'en-US', timezone_id: 'America/New_York', proxy_ref: null };
let environmentId: string;
beforeAll(async () => {
  const name = (await query('SELECT current_database() AS name'))[0].name;
  if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Refusing non-isolated database');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.content_versions,kff.environment_commands,kff.audit_events CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1", [agent.id]);
  await query("UPDATE kff.environments SET state='IDLE'");
  environmentId = (await createEnvironment(scope, { name: 'Matrix test ' + randomUUID(), account_id: localIds.account, agent_id: agent.id })).id;
});
afterAll(closePool);
async function configure() { return configureEnvironment(scope, environmentId, { expected_version: 1, configuration }); }
async function operation(operation: 'CHECK' | 'OPEN_LOGIN' = 'CHECK') {
  await configure(); return queueEnvironmentOperation(scope, environmentId, { operation, expected_version: 2, request_id: randomUUID() });
}
async function task(write = false) {
  const value = await createTask(scope, { title: 'Environment-bound task', account_id: localIds.account, environment_id: environmentId, capability_id: write ? localIds.publish : localIds.read, body: write ? 'Scoped synthetic body' : '', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, value.id, { snapshot_hash: value.snapshot_hash, decision: 'APPROVED' }); return value;
}
it('rejects cross-brand reads/configuration and unauthorized operators', async () => {
  const other = { ...scope, brand_id: randomUUID() };
  await expect(configureEnvironment(other, environmentId, { expected_version: 1, configuration })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(configureEnvironment({ ...scope, role: 'operator' }, environmentId, { expected_version: 1, configuration })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await operation();
  expect((await scoped(other, client => client.query('SELECT * FROM kff.environment_commands'))).rowCount).toBe(0);
});
it('pins new configuration and rejects wrong identity and stale task approval', async () => {
  const old = await task(); await configure();
  await expect(enqueueTask(scope, old.id)).rejects.toMatchObject({ code: 'ENVIRONMENT_CHANGED' });
  await expect(configureEnvironment(scope, environmentId, { expected_version: 2, configuration: { ...configuration, operating_identity_id: '999' } })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  const fresh = await task(); expect(fresh.snapshot.environment_version).toBe(2); await enqueueTask(scope, fresh.id); expect(await dispatchOne()).toBe(true);
  const command = await claimCommand(agent); await recordBrowserOpened(agent, command!.id);
  expect((await query('SELECT browser_status FROM kff.environments WHERE id=$1', [environmentId]))[0].browser_status).toBe('RUNNING');
});
it('deduplicates concurrent requests and refuses a changed replay', async () => {
  await configure(); const value = { operation: 'CHECK', expected_version: 2, request_id: randomUUID() };
  const results = await Promise.all([queueEnvironmentOperation(scope, environmentId, value), queueEnvironmentOperation(scope, environmentId, value)]);
  expect(results[0].id).toBe(results[1].id);
  await expect(queueEnvironmentOperation(scope, environmentId, { ...value, operation: 'OPEN_LOGIN' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('reserves one Agent and both resources, and cannot reconfigure an open login window', async () => {
  const queued = await operation('OPEN_LOGIN'); const commands = await Promise.all([claimEnvironmentCommand(agent), claimEnvironmentCommand(agent)]);
  expect(commands.filter(Boolean)).toHaveLength(1); expect(commands.find(Boolean)?.id).toBe(queued.id);
  expect((await query('SELECT resource_id FROM kff.resource_leases WHERE holder_control_id=$1', [queued.id])).length).toBe(2);
  await expect(configureEnvironment(scope, environmentId, { expected_version: 2, configuration })).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  const pending = await task(); await enqueueTask(scope, pending.id); expect(await dispatchOne()).toBe(false);
});
it('keeps expired controls isolated until the exact closure is reported, and deduplicates that result', async () => {
  const queued = await operation(); await claimEnvironmentCommand(agent);
  await query("UPDATE kff.environment_commands SET heartbeat_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [queued.id]);
  expect(await recoverEnvironmentCommands()).toBe(1);
  expect(await environmentHeartbeat(agent, queued.id)).toEqual({ continue: false });
  expect((await query('SELECT state,browser_status FROM kff.environments WHERE id=$1', [environmentId]))[0]).toEqual({ state: 'QUARANTINED', browser_status: 'UNKNOWN' });
  const result = { context_closed: true, outcome: 'BLOCKED', error_code: 'STOP_REQUESTED' };
  await expect(completeEnvironmentCommand({ ...agent, id: randomUUID() }, queued.id, result)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  expect(await completeEnvironmentCommand(agent, queued.id, result)).toMatchObject({ duplicate: false });
  expect(await completeEnvironmentCommand(agent, queued.id, result)).toMatchObject({ duplicate: true });
  await expect(completeEnvironmentCommand(agent, queued.id, { ...result, outcome: 'CHECKED' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [environmentId]))[0].state).toBe('IDLE');
});
it('stops login control without claiming login success or releasing resources early', async () => {
  const queued = await operation('OPEN_LOGIN'); await claimEnvironmentCommand(agent);
  expect(await environmentHeartbeat(agent, queued.id, { browser_version: '145.0.0' })).toEqual({ continue: true });
  await controlEnvironment(scope, environmentId, { action: 'STOP', expected_version: 2 });
  expect(await environmentHeartbeat(agent, queued.id)).toEqual({ continue: false });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [environmentId]))[0].state).toBe('BUSY');
  await expect(completeEnvironmentCommand(agent, queued.id, { context_closed: true, outcome: 'CHECKED' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await completeEnvironmentCommand(agent, queued.id, { context_closed: true, outcome: 'CLOSED' });
  expect((await query('SELECT browser_checked_at FROM kff.environments WHERE id=$1', [environmentId]))[0].browser_checked_at).toBeNull();
});
it('rejects delayed heartbeat on expired leases and a revoked Agent', async () => {
  const queued = await operation(); await claimEnvironmentCommand(agent);
  await query("UPDATE kff.resource_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE holder_control_id=$1", [queued.id]);
  expect(await environmentHeartbeat(agent, queued.id)).toEqual({ continue: false });
  await query("UPDATE kff.agents SET status='REVOKED' WHERE id=$1", [agent.id]);
  expect(await environmentHeartbeat(agent, queued.id)).toEqual({ continue: false });
});
it('does not steal an account already running an ordinary task, including another environment', async () => {
  const running = await task(true); await enqueueTask(scope, running.id); expect(await dispatchOne()).toBe(true);
  const command = await claimCommand(agent); expect(command).not.toBeNull();
  await expect(configure()).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  await beginSubmission(agent, command!.id);
  expect(await claimEnvironmentCommand(agent)).toBeNull();
});
it('prevents duplicate AdsPower binding and disabling an occupied environment', async () => {
  const adspower = { ...configuration, driver: 'adspower', provider_profile_id: 'test-' + randomUUID() };
  await configureEnvironment(scope, environmentId, { expected_version: 1, configuration: adspower });
  const second = await createEnvironment(scope, { name: 'Second profile binding', account_id: localIds.account, agent_id: agent.id });
  await expect(configureEnvironment(scope, second.id, { expected_version: 1, configuration: adspower })).rejects.toMatchObject({ code: 'PROFILE_ALREADY_BOUND' });
  await queueEnvironmentOperation(scope, environmentId, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  await expect(controlEnvironment(scope, environmentId, { action: 'DISABLE', expected_version: 2 })).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
});
it('allows independent accounts on two Agents while preserving command ownership', async () => {
  await operation();
  const paired = await createAgent(scope, { name: 'Second matrix agent' });
  const other: AgentIdentity = { ...agent, id: paired.agent.id };
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1", [other.id]);
  const account = await createAccount(scope, { display_name: 'Second matrix account', external_id: '9' + Date.now(), platform: 'facebook', account_type: 'page' });
  const environment = await createEnvironment(scope, { name: 'Second matrix environment', account_id: account.id, agent_id: other.id });
  await configureEnvironment(scope, environment.id, { expected_version: 1, configuration: { ...configuration, login_account_id: account.external_id, operating_identity_id: account.external_id } });
  await queueEnvironmentOperation(scope, environment.id, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  const [first, second] = await Promise.all([claimEnvironmentCommand(agent), claimEnvironmentCommand(other)]);
  expect(first?.snapshot.environment_id).toBe(environmentId); expect(second?.snapshot.environment_id).toBe(environment.id);
  await expect(environmentHeartbeat(agent, second!.id)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await completeEnvironmentCommand(agent, first!.id, { context_closed: true, outcome: 'CLOSED' });
  await completeEnvironmentCommand(other, second!.id, { context_closed: true, outcome: 'CLOSED' });
});
it('registers a browser profile without Page capabilities and pins a real identity receipt to its checked configuration', async () => {
  const account = await createAccount(scope, { display_name: 'Browser profile', external_id: '9' + Date.now(), platform: 'facebook', account_type: 'profile' });
  expect(account.is_synthetic).toBe(false);
  expect(await query('SELECT id FROM kff.capabilities WHERE account_id=$1', [account.id])).toHaveLength(0);
  const environment = await createEnvironment(scope, { name: 'Real profile configuration', account_id: account.id, agent_id: agent.id });
  const config = { ...configuration, operating_identity_id: account.external_id, login_account_id: account.external_id };
  await configureEnvironment(scope, environment.id, { expected_version: 1, configuration: config });
  const operation = await queueEnvironmentOperation(scope, environment.id, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  const command = await claimEnvironmentCommand(agent); expect(command?.id).toBe(operation.id); expect(command?.snapshot.account_type).toBe('profile');
  const identity = { method: 'facebook-profile-dom-v1', authenticated: true, operating_identity_id: account.external_id, account_type: 'profile', display_name: account.display_name, observed_at: new Date().toISOString(), source_url: 'https://www.facebook.com/profile.php?id=' + account.external_id };
  const result = { context_closed: true, outcome: 'CHECKED', identity };
  await expect(completeEnvironmentCommand(agent, operation.id, { context_closed: true, outcome: 'CHECKED' })).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  await expect(completeEnvironmentCommand(agent, operation.id, { ...result, identity: { ...identity, operating_identity_id: '123', source_url: 'https://www.facebook.com/profile.php?id=123' } })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  await expect(completeEnvironmentCommand(agent, operation.id, { ...result, identity: { ...identity, observed_at: '2020-01-01T00:00:00.000Z' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await completeEnvironmentCommand(agent, operation.id, result);
  expect((await environmentWorkspace(scope)).find(row => row.id === environment.id)?.identity_result.identity).toEqual(identity);
  const retry = await queueEnvironmentOperation(scope, environment.id, { operation: 'CHECK', expected_version: 2, request_id: randomUUID() });
  expect((await environmentWorkspace(scope)).find(row => row.id === environment.id)?.identity_result).toBeNull();
  await claimEnvironmentCommand(agent);
  await completeEnvironmentCommand(agent, retry.id, { context_closed: true, outcome: 'BLOCKED', error_code: 'LOGIN_REQUIRED' });
  expect((await environmentWorkspace(scope)).find(row => row.id === environment.id)?.identity_result).toMatchObject({ outcome: 'BLOCKED', error_code: 'LOGIN_REQUIRED' });
  await configureEnvironment(scope, environment.id, { expected_version: 2, configuration: config });
  expect((await environmentWorkspace(scope)).find(row => row.id === environment.id)?.identity_result).toBeNull();
});
