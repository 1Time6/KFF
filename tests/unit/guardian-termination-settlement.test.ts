import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runGuardian } from '../../apps/agent/src/guardian';
import { readClosure, readClosureEvidence, saveClosure } from '../../apps/agent/src/guardian-protocol';
import { isProcessAlive } from '../../apps/agent/src/process-tree';
import { fixtureCommand } from '../helpers/commands';
import type { AgentCommand, GuardianTermination } from '@kff/contracts';

/**
 * F1: the settlement race between the child's terminal events and the forced-termination verdict.
 *
 * The watchdog's `terminate()` awaits the termination utility; `taskkill` kills the child, whose
 * `exit` handler used to settle synchronously with the fallback fact while the awaited verdict was
 * still pending - so a termination that really proved the tree DEAD was recorded as UNKNOWN. These
 * cases pin the ordering by substituting the termination utility (the only dependency the race turns
 * on) with a controlled promise that kills the child immediately and hands the verdict back only
 * when the test says so. Production passes no substitution, so the real utility is the default.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-settle-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const nonce = () => randomBytes(32).toString('hex');
const identity = (command: AgentCommand, value: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: value });
const closuresIn = (runtime: string) => readdirSync(path.join(runtime, 'agent', 'closures'));
const closureFile = (runtime: string, command: AgentCommand) => path.join(runtime, 'agent', 'closures', command.id + '.json');
/** The stored hash disagrees with the snapshot, so the child stops before it opens anything; the hang point is what keeps it alive. */
function closureCommand(): AgentCommand { return { ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) }; }

// Test-scale budgets: short phases, a grace long enough for the frozen child to stay silent through
// it, and a force large enough that the substituted utility - which resolves on demand - is the only
// thing pacing the forced phase.
const phaseBudget = 700, terminationGrace = 400, forceKill = 2000, startupBudget = 10000;
const budgets = { 'awaiting-ready': startupBudget, 'awaiting-start': phaseBudget, 'awaiting-context': phaseBudget, 'awaiting-intent': phaseBudget, granting: phaseBudget, submitting: phaseBudget, grace: terminationGrace, force: forceKill };

const deadVerdict: GuardianTermination = { process_tree: 'DEAD', tool: 'SUCCESS', root: 'DEAD', descendants: 'DEAD', sampled: 2, enumeration: 'LISTED', elapsed_ms: 123 };
const uncertainVerdict: GuardianTermination = { process_tree: 'UNKNOWN', tool: 'TIMEOUT', root: 'DEAD', descendants: 'UNKNOWN', sampled: 0, enumeration: 'UNAVAILABLE', elapsed_ms: 800 };

interface Controlled {
  called: number;
  pid: number | undefined;
  resolve: ((value: GuardianTermination) => void) | undefined;
  fake: (pid: number | undefined, options: { deadlineMs: number }) => Promise<GuardianTermination>;
}
function controlledTermination(): Controlled {
  const control: Controlled = { called: 0, pid: undefined, resolve: undefined, fake: () => { throw new Error('termination dependency assigned before use'); } };
  const pending = new Promise<GuardianTermination>(resolve => { control.resolve = resolve; });
  control.fake = async (pid: number | undefined, _options: { deadlineMs: number }) => {
    control.called += 1; control.pid = pid;
    // The kill is what makes the child's terminal events land while this promise is still pending:
    // the parent is inside the awaited termination call, and the verdict has not been handed back.
    try { if (pid !== undefined) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return pending;
  };
  return control;
}

async function runSettled(command: AgentCommand, point: 'after-start') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-settle-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', point);
  mkdirSync(runtime, { recursive: true });
  const value = nonce(); let pid: number | undefined;
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT], ['NODE_ENV', environment.NODE_ENV]] as const;
  environment.KFF_ROOT = root; environment.NODE_ENV = 'test'; environment.KFF_TEST_GUARDIAN_HANG_AT = point;
  const control = controlledTermination();
  const running = runGuardian(command, runtime, value, { signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; }, beforeSubmit: async () => {}, liveness: budgets }, { terminate: control.fake });
  for (const [key, stored] of previous) { if (stored === undefined) delete environment[key]; else environment[key] = stored; }
  // The test asserts on the record at points where it may not have awaited the run yet; marking the
  // rejection as observed keeps a failing assertion from also raising an unhandled-rejection error.
  running.then(undefined, () => {});
  return { root, runtime, command, value, pid, control, running };
}
async function untilCalled(control: Controlled) {
  for (let attempt = 0; attempt < 400 && control.called === 0; attempt += 1) await sleep(25);
  expect(control.called).toBe(1);
}
async function untilGone(pid: number | undefined) {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (!isProcessAlive(pid)) return true; await sleep(25); }
  return !isProcessAlive(pid);
}

/**
 * A + B: the child dies the moment the kill happens, while the termination verdict is still in
 * flight. Before the fix the exit handler wrote the fallback UNKNOWN immediately (the race the
 * Machine B matrix exposed); after the fix nothing is settled until the verdict arrives, and the
 * DEAD/LISTED/SUCCESS verdict the termination really returned is the fact that gets recorded.
 */
it('waits for the in-flight termination verdict instead of settling on the fallback, and keeps the real DEAD verdict', async () => {
  const s = await runSettled(closureCommand(), 'after-start');
  await untilCalled(s.control);
  expect(await untilGone(s.pid)).toBe(true);
  // Both terminal events have had time to be delivered while the verdict is still pending.
  await sleep(150);
  // Mid-flight: the final settlement must not have happened yet, so no fallback record may exist.
  expect(readClosureEvidence(s.runtime, identity(s.command, s.value))).toBeNull();
  s.control.resolve!(deadVerdict);
  await expect(s.running).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  const evidence = readClosureEvidence(s.runtime, identity(s.command, s.value));
  expect(evidence).toMatchObject({
    protocol_version: 'kff.guardian-closure-no-progress.v1', command_id: s.command.id, action_id: s.command.action_id, nonce: s.value,
    phase: 'awaiting-context', forced: true, grace_ms: terminationGrace,
    termination: { process_tree: 'DEAD', tool: 'SUCCESS', root: 'DEAD', descendants: 'DEAD', sampled: 2, enumeration: 'LISTED', elapsed_ms: 123 },
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
  });
  // The weaker fact still cannot be read back as a real closure.
  expect(() => readClosure(s.runtime, identity(s.command, s.value))).toThrow();
  expect(closuresIn(s.runtime)).toEqual([s.command.id + '.json']);
}, 30000);

/** C: a termination that timed out with no enumeration stays honestly UNKNOWN - the fallback and the real verdict agree, and neither fabricates a DEAD tree. */
it('keeps an honest UNKNOWN when the termination verdict is a timeout with an unavailable enumeration', async () => {
  const s = await runSettled(closureCommand(), 'after-start');
  await untilCalled(s.control);
  expect(await untilGone(s.pid)).toBe(true);
  await sleep(150);
  s.control.resolve!(uncertainVerdict);
  await expect(s.running).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  expect(readClosureEvidence(s.runtime, identity(s.command, s.value))).toMatchObject({
    phase: 'awaiting-context', forced: true,
    termination: { process_tree: 'UNKNOWN', tool: 'TIMEOUT', root: 'DEAD', descendants: 'UNKNOWN', sampled: 0, enumeration: 'UNAVAILABLE', elapsed_ms: 800 },
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
  });
}, 30000);

/** D: a real closure that lands while termination is in flight wins over the termination verdict, however DEAD that verdict is. */
it('prefers a real closure that arrives during the in-flight termination over the termination verdict', async () => {
  const s = await runSettled(closureCommand(), 'after-start');
  await untilCalled(s.control);
  expect(await untilGone(s.pid)).toBe(true);
  await sleep(150);
  // The child's own saver writes the strong proof while the parent still awaits the verdict.
  const closure = saveClosure(s.runtime, {
    protocol_version: 'kff.guardian-closure.v1', command_id: s.command.id, action_id: s.command.action_id, nonce: s.value,
    closed_at: new Date().toISOString(), context_closed: true,
    result: { outcome: 'BLOCKED', error_code: 'APPROVAL_STALE', diagnostic: { step: 'executor-failed' } },
  });
  s.control.resolve!(deadVerdict);
  const resolved = await s.running;
  expect(resolved).toEqual(closure);
  expect(resolved.protocol_version).toBe('kff.guardian-closure.v1');
  expect(resolved.result).toMatchObject({ outcome: 'BLOCKED', error_code: 'APPROVAL_STALE' });
  // Exactly one record was written, and it is the closure - no no-progress fallback was recorded beside it.
  expect(closuresIn(s.runtime)).toEqual([s.command.id + '.json']);
  expect(readClosure(s.runtime, identity(s.command, s.value))).toEqual(closure);
}, 30000);

/** E: `exit` and `close` both arrive for the one kill, and the run settles exactly once, into exactly one record. */
it('settles once when exit and close interleave around the termination verdict', async () => {
  const s = await runSettled(closureCommand(), 'after-start');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  await untilCalled(s.control);
  expect(await untilGone(s.pid)).toBe(true);
  await sleep(150);
  s.control.resolve!(deadVerdict);
  await expect(s.running).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  expect(closuresIn(s.runtime)).toEqual([s.command.id + '.json']);
  expect(JSON.parse(readFileSync(closureFile(s.runtime, s.command), 'utf8'))).toMatchObject({ termination: { process_tree: 'DEAD', tool: 'SUCCESS', enumeration: 'LISTED' } });
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
}, 30000);

/** F: once settled, late continuations - a redundant verdict, further terminal events - leave the record and the process untouched. */
it('leaves no side effects from late continuations after the settlement is complete', async () => {
  const s = await runSettled(closureCommand(), 'after-start');
  await untilCalled(s.control);
  expect(await untilGone(s.pid)).toBe(true);
  await sleep(150);
  s.control.resolve!(deadVerdict);
  await expect(s.running).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  const settledBytes = readFileSync(closureFile(s.runtime, s.command), 'utf8');
  // A late second resolution of the same verdict, plus time for any pending continuations to run.
  s.control.resolve!(uncertainVerdict);
  await sleep(200);
  expect(readFileSync(closureFile(s.runtime, s.command), 'utf8')).toBe(settledBytes);
  expect(closuresIn(s.runtime)).toEqual([s.command.id + '.json']);
  expect(readClosureEvidence(s.runtime, identity(s.command, s.value))).toMatchObject({ termination: { process_tree: 'DEAD', tool: 'SUCCESS', enumeration: 'LISTED' } });
}, 30000);
