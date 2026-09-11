import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, getPool, closePool } from '../../packages/database/src/index';
import { createTask, approveTask, enqueueTask } from '../../packages/core/src/service';
import type { Scope } from '../../packages/contracts/src/index';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const children: ChildProcess[] = [];
function launch(script: string, args: string[] = []) {
  const child = spawn(process.execPath, ['--import','tsx',script,...args], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] }); children.push(child); return child;
}
async function stopOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await stopped;
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('Durability barrier was not reached'); await delay(60); }
}
async function approved() {
  const task = await createTask(scope, { title: 'Isolated real-process crash test', account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.publish, body: 'Synthetic crash boundary', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' }); return task;
}
async function barrier(event: 'INSERT' | 'UPDATE') {
  const client = await getPool().connect(); await client.query('SELECT pg_advisory_lock(71288321)');
  await query('CREATE FUNCTION kff.test_crash_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(71288321); RETURN NEW; END $$');
  await query('CREATE TRIGGER test_crash_barrier AFTER ' + event + " ON kff.jobs FOR EACH ROW WHEN (NEW.state='" + (event === 'INSERT' ? 'READY' : 'DONE') + "') EXECUTE FUNCTION kff.test_crash_barrier()");
  return {
    wait: () => until(async () => Number((await query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=71288321 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted"))[0].count) === 1),
    async close() { await client.query('SELECT pg_advisory_unlock(71288321)'); client.release(); await query('DROP TRIGGER test_crash_barrier ON kff.jobs; DROP FUNCTION kff.test_crash_barrier()'); },
  };
}
beforeAll(async () => {
  const name = (await query('SELECT current_database() AS name'))[0].name;
  if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Refusing a non-isolated database');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.content_versions,kff.audit_events CASCADE');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=now() WHERE id=$1", [localIds.agent]);
  await query("UPDATE kff.environments SET state='IDLE'");
});
afterAll(async () => { for (const child of children) await stopOwned(child); await closePool(); });

it('rolls back the entire enqueue when its actual caller dies inside the final transaction write', async () => {
  const task = await approved(); const blocked = await barrier('INSERT'); let child: ChildProcess | undefined;
  try {
    child = launch('tests/helpers/enqueue-process.ts', [task.id]); await blocked.wait(); await stopOwned(child);
    await until(async () => (await query('SELECT count(*)::int AS count FROM kff.runs'))[0].count === 0);
    for (const table of ['runs','actions','jobs']) expect((await query('SELECT count(*)::int AS count FROM kff.' + table))[0].count).toBe(0);
  } finally { if (child) await stopOwned(child); await blocked.close(); }
  await enqueueTask(scope, task.id); expect((await query('SELECT count(*)::int AS count FROM kff.jobs'))[0].count).toBe(1);
});

it('reuses the committed business intent after the enqueue caller dies before sending its response', async () => {
  const task = await approved(); const child = launch('tests/helpers/enqueue-process.ts', [task.id]);
  const committed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Caller did not commit')), 10000);
    child.on('message', message => { if (message && typeof message === 'object' && 'run_id' in message) { clearTimeout(timer); resolve(String(message.run_id)); } });
  });
  await stopOwned(child); const run = await enqueueTask(scope, task.id); expect(run.id).toBe(committed);
  for (const table of ['runs','actions','jobs']) expect((await query('SELECT count(*)::int AS count FROM kff.' + table))[0].count).toBe(1);
});

it('recovers the queued job after the actual Worker dies before its dispatch transaction commits', async () => {
  const task = await approved(); await enqueueTask(scope, task.id); const blocked = await barrier('UPDATE'); let child: ChildProcess | undefined;
  try {
    child = launch('apps/worker/src/main.ts'); await blocked.wait(); await stopOwned(child);
    expect((await query('SELECT state FROM kff.jobs'))[0].state).toBe('READY');
    expect((await query('SELECT state FROM kff.actions'))[0].state).toBe('QUEUED');
    expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(0);
  } finally { if (child) await stopOwned(child); await blocked.close(); }
  const restarted = launch('apps/worker/src/main.ts');
  try { await until(async () => (await query('SELECT count(*)::int AS count FROM kff.agent_commands'))[0].count === 1); }
  finally { await stopOwned(restarted); }
  expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(1);
});

it('does not create another command after the actual Worker restarts after dispatch commit', async () => {
  const task = await approved(); await enqueueTask(scope, task.id); const child = launch('apps/worker/src/main.ts');
  await until(async () => (await query('SELECT count(*)::int AS count FROM kff.agent_commands'))[0].count === 1); await stopOwned(child);
  const restarted = launch('apps/worker/src/main.ts'); await delay(1800); await stopOwned(restarted);
  expect((await query('SELECT count(*)::int AS count FROM kff.agent_commands'))[0].count).toBe(1);
  expect((await query('SELECT count(*)::int AS count FROM kff.action_attempts'))[0].count).toBe(1);
  expect((await query('SELECT state,attempts FROM kff.jobs'))[0]).toMatchObject({ state: 'DONE', attempts: 1 });
});
