import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { runGuardian } from '../../apps/agent/src/guardian';
import { readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { fixtureCommand, submitBoundaryCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

// Every scenario is driven through the production `runGuardian` against a real child process. The
// runtime root is a throwaway directory under the operating system's temp directory, so nothing here
// can reach the project's own journal, closures, browser profiles or database.
const roots: string[] = [];
function runtimeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-guardian-'));
  roots.push(root);
  const runtime = path.join(root, '.kff');
  mkdirSync(runtime, { recursive: true });
  return runtime;
}
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !/^kff-b01-(guardian|missing)-/.test(path.basename(root))) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
const nonce = () => randomBytes(32).toString('hex');
const identity = (command: AgentCommand, value: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: value });
const closuresIn = (runtime: string) => readdirSync(path.join(runtime, 'agent', 'closures'));

/**
 * A spawn failure is the only way to observe the event combination this defect is about, and the
 * production call site is fixed at `spawn(process.execPath, ..., { cwd: process.cwd() })`. Pointing
 * the process's own working directory at a path that does not exist therefore turns that very call
 * into a genuine libuv ENOENT. Nothing in the code under test is replaced, stubbed or re-implemented -
 * only the directory the operating system reports is unavailable.
 */
async function withUnusableWorkingDirectory<T>(body: (missing: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-missing-')); roots.push(root);
  const missing = path.join(root, 'removed');
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(missing);
  try { return await body(missing); } finally { spy.mockRestore(); }
}
/** Records the raw platform event order for the same unusable working directory, with no production code in the way. */
function platformSpawnEvents(cwd: string) {
  const order: string[] = [];
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.on('error', error => order.push(`error:${(error as NodeJS.ErrnoException).code}:pid=${child.pid === undefined ? 'undefined' : String(child.pid)}`));
  child.on('exit', code => order.push(`exit:${code}`));
  child.on('close', code => order.push(`close:${code}`));
  return new Promise<string[]>(resolve => setTimeout(() => resolve(order), 750));
}
/** The stored hash deliberately disagrees with the snapshot, so the child fails before it opens anything and still writes a real closure. */
function closureCommand(): AgentCommand { return { ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) }; }

it('A: a child killed before it can ever start is settled as a proven startup failure', async () => {
  const runtime = runtimeRoot(); const command = closureCommand(); const value = nonce();
  let spawned = false; let submitRequested = false;
  await withUnusableWorkingDirectory(async () => {
    await expect(runGuardian(command, runtime, value, { beforeSubmit: async () => { submitRequested = true; }, signal: new AbortController().signal, onSpawn: () => { spawned = true; } }))
      .rejects.toMatchObject({ code: 'GUARDIAN_STARTUP_FAILED' });
  });
  // Nothing downstream of `ready` can have happened, which is what makes recording the failure sound.
  expect(spawned).toBe(false); expect(submitRequested).toBe(false);
  expect(readClosureEvidence(runtime, identity(command, value))).toEqual({
    protocol_version: 'kff.guardian-closure-startup-failed.v1', command_id: command.id, action_id: command.action_id,
    nonce: value, closed_at: expect.any(String), context_opened: false,
    result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } },
  });
});

it('B: the failing spawn emits error then close and never exit, and produces exactly one terminal decision', async () => {
  // The platform fact this defect rests on, captured beside the production call rather than assumed.
  const order = await withUnusableWorkingDirectory(missing => platformSpawnEvents(missing));
  expect(order.map(entry => entry.split(':')[0])).toEqual(['error', 'close']);
  expect(order[0]).toBe('error:ENOENT:pid=undefined');
  expect(order).not.toContainEqual(expect.stringMatching(/^exit:/));

  const runtime = runtimeRoot(); const command = closureCommand(); const value = nonce();
  await withUnusableWorkingDirectory(async () => {
    await expect(runGuardian(command, runtime, value, { beforeSubmit: async () => {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'GUARDIAN_STARTUP_FAILED' });
  });
  // `error` and `close` both arrive; a second decision would surface as IDEMPOTENCY_CONFLICT instead.
  expect(closuresIn(runtime)).toEqual([command.id + '.json']);
  expect(readClosureEvidence(runtime, identity(command, value))).toMatchObject({ context_opened: false });
});

it('C: a child that really starts closes its context and the run resolves with that proof', async () => {
  const runtime = runtimeRoot(); const command = closureCommand(); const value = nonce();
  let pid: number | undefined;
  const closure = await runGuardian(command, runtime, value, { beforeSubmit: async () => {}, signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; } });
  expect(pid).toBeGreaterThan(0);
  expect(closure.protocol_version).toBe('kff.guardian-closure.v1');
  expect(closure.context_closed).toBe(true);
  expect(closure.result).toMatchObject({ outcome: 'BLOCKED', error_code: 'APPROVAL_STALE' });
  expect(closure).not.toHaveProperty('context_opened');
  expect(readClosureEvidence(runtime, identity(command, value))).toEqual(closure);
}, 60000);

it('D: a child that had started and left no proof keeps its isolation instead of being written off as a startup failure', async () => {
  const runtime = runtimeRoot(); const command = closureCommand(); const value = nonce();
  let pid: number | undefined;
  const running = runGuardian(command, runtime, value, { beforeSubmit: async () => {}, signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; } });
  const settled = running.then(() => 'resolved', error => (error as { code?: string }).code);
  while (pid === undefined) await new Promise(resolve => setTimeout(resolve, 25));
  // Under load the child can exit between the spawn callback and this line; that is still the
  // scenario under test (a started child left no proof), and the assertions below are the point.
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  expect(await settled).toBe('GUARDIAN_UNCONFIRMED');
  expect(readClosureEvidence(runtime, identity(command, value))).toBeNull();
}, 60000);

/**
 * `error + exit` is the one combination in this matrix that does not occur at this call site, and the
 * reason is the production send path: it checks `child.connected` and always passes a callback, which
 * is where a failed send is delivered. Both halves of that fact are captured here rather than assumed.
 */
it('F: a failed IPC send goes to its callback, so no error event can follow exit', async () => {
  const order: string[] = [];
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.on('error', () => order.push('error'));
  child.on('exit', () => order.push('exit'));
  await new Promise<void>(resolve => child.on('close', () => { order.push('close'); resolve(); }));
  expect(order).toEqual(['exit', 'close']);
  expect(child.connected).toBe(false);
  const failures: unknown[] = [];
  if (child.connected) throw new Error('Expected the channel to be closed');
  child.send({ type: 'start' }, error => failures.push(error ?? 'accepted'));
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(failures).toEqual([expect.objectContaining({ code: 'ERR_IPC_CHANNEL_CLOSED' })]);
  // The failed send emitted nothing on the child, which is what the production guard relies on.
  expect(order).toEqual(['exit', 'close']);
});

it('E: a child that died after asking for submission authority is never recorded as a startup failure', async () => {
  const runtime = runtimeRoot(); const command = submitBoundaryCommand(); const value = nonce();
  let pid: number | undefined; let asked = false;
  const settled = runGuardian(command, runtime, value, {
    signal: new AbortController().signal,
    onSpawn: spawned => { pid = spawned; },
    // The parent only reaches this hook because the child really sent `before-submit`, i.e. the command
    // had already reached the submission boundary when it died.
    beforeSubmit: async () => { asked = true; process.kill(pid!, 'SIGKILL'); },
  }).then(() => 'resolved', error => (error as { code?: string }).code);
  expect(await settled).toBe('GUARDIAN_UNCONFIRMED');
  expect(asked).toBe(true);
  expect(readClosureEvidence(runtime, identity(command, value))).toBeNull();
}, 60000);
