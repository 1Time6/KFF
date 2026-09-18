import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runGuardian } from '../../apps/agent/src/guardian';
import { closureProof, readClosure, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { isProcessAlive, probeProcess } from '../../apps/agent/src/process-tree';
import { fixtureCommand, submitBoundaryCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

/**
 * The half of forced termination that the batch exists for: what the parent is allowed to record when
 * the force did not work. Every case runs the production `runGuardian` against a real child process
 * and takes away the only thing that could have ended it - the termination utility itself - so the
 * child is still running at the moment the parent has to decide what to write down.
 *
 * The utility is spawned by name, so removing the executable search path is enough to make the real
 * call fail for real. Nothing in the code under test is replaced or stubbed, and the platform
 * behaviour this relies on is asserted in the same file: the child is probed afterwards and is alive.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-force-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const nonce = () => randomBytes(32).toString('hex');
const identity = (command: AgentCommand, value: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: value });
const closuresIn = (runtime: string) => readdirSync(path.join(runtime, 'agent', 'closures'));

const phaseBudget = 700, terminationGrace = 400, forceKill = 800, startupBudget = 10000, hungBeforeReady = 4000;
const budgets = (startup = startupBudget) => ({ 'awaiting-ready': startup, 'awaiting-start': phaseBudget, 'awaiting-context': phaseBudget, 'awaiting-intent': phaseBudget, granting: phaseBudget, submitting: phaseBudget, grace: terminationGrace, force: forceKill });

function injectionRoot(point: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-force-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', point);
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
/** A child that never became ready, and a child that reached the submission boundary, both still alive. */
function closureCommand(): AgentCommand { return { ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) }; }
const seal = { KFF_ROOT: undefined as string | undefined, KFF_TEST_GUARDIAN_HANG_AT: undefined as string | undefined, NODE_ENV: undefined as string | undefined };
function armInjection(root: string, point: string) {
  const environment = process.env as Record<string, string | undefined>;
  for (const key of Object.keys(seal)) seal[key as keyof typeof seal] = environment[key];
  environment.KFF_ROOT = root; environment.NODE_ENV = 'test'; environment.KFF_TEST_GUARDIAN_HANG_AT = point;
}
function disarmInjection() {
  const environment = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(seal)) { if (value === undefined) delete environment[key]; else environment[key] = value; }
}
/** No executable search path, so no tool the parent spawns by name can start. Restored afterwards. */
function removeToolPath() {
  const environment = process.env as Record<string, string | undefined>;
  const saved = [['PATH', environment.PATH], ['Path', environment.Path]] as const;
  delete environment.PATH; delete environment.Path;
  return () => { for (const [key, value] of saved) { if (value === undefined) delete environment[key]; else environment[key] = value; } };
}
async function eventuallyGone(pid: number | undefined) {
  for (let attempt = 0; attempt < 50; attempt++) { if (!isProcessAlive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return !isProcessAlive(pid);
}
/** A child that survived the force is this test's own responsibility to clean up, not the runner's. */
const reap = (pid: number | undefined) => { try { if (pid !== undefined) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

/**
 * One forced termination whose utility could not run. The budgets are the test-scale ones the liveness
 * regression uses, for the same reason; `force` only has to be long enough for the parent to finish
 * its termination attempt and give up waiting, because with the tool unavailable that attempt is over
 * immediately and the rest of the budget is spent waiting for a child that is never going to exit.
 *
 * The child's liveness is sampled independently every 25ms, so the claim the record makes can be
 * compared against a measurement taken from outside the production code rather than against itself.
 */
async function forceWithoutTool(command: AgentCommand, point: string, options: { submit?: () => Promise<void>; budgets?: ReturnType<typeof budgets> } = {}) {
  const { root, runtime } = injectionRoot(point);
  const value = nonce(); let pid: number | undefined; let asked = 0;
  const samples: { at: number; alive: boolean }[] = [];
  const startedAt = Date.now();
  const sampler = setInterval(() => { if (pid !== undefined) samples.push({ at: Date.now() - startedAt, alive: isProcessAlive(pid) }); }, 25);
  armInjection(root, point);
  const running = runGuardian(command, runtime, value, { signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; }, beforeSubmit: async () => { asked += 1; await options.submit?.(); }, liveness: options.budgets ?? budgets() });
  disarmInjection();
  const restorePath = removeToolPath();
  try {
    const outcome = await running.then(closure => ({ kind: 'resolved' as const, code: closure.protocol_version }), error => ({ kind: 'rejected' as const, code: (error as { code?: string }).code }));
    clearInterval(sampler);
    const evidence = readClosureEvidence(runtime, identity(command, value));
    // Probed after the run has settled, i.e. after the parent decided the execution was over.
    const aliveAfterDecision = isProcessAlive(pid);
    let closed = 'none';
    try { readClosure(runtime, identity(command, value)); closed = 'read-as-closed'; } catch (error) { closed = (error as { code?: string }).code ?? 'unknown'; }
    return { runtime, command, value, pid, outcome, evidence, asked, aliveAfterDecision, closed, samples, gone: await eventuallyGone(pid) };
  } finally { clearInterval(sampler); restorePath(); }
}

it('records a Guardian that is still alive as needing a human instead of freeing its slot', async () => {
  const command = closureCommand();
  const forced = await forceWithoutTool(command, 'after-start');
  try {
    expect(forced.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
    // The tool could not start at all, so the tree was never enumerated and the child was never touched.
    // Every field says exactly that: an `ERROR` tool, no listing, a root that answers a probe, and a
    // tree that is therefore UNKNOWN - which is the strictest of the three states, not the weakest.
    expect(forced.evidence).toEqual({
      protocol_version: 'kff.guardian-closure-no-progress.v1', command_id: command.id, action_id: command.action_id,
      nonce: forced.value, closed_at: expect.any(String), phase: 'awaiting-context',
      termination: { process_tree: 'UNKNOWN', tool: 'ERROR', root: 'ALIVE', descendants: 'DEAD', sampled: 0, enumeration: 'UNAVAILABLE', elapsed_ms: expect.any(Number) },
      context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true, waited_ms: expect.any(Number), grace_ms: terminationGrace,
      // `start` was sent, so this is no longer a startup failure, and the process is still alive, so it
      // is not an unknown outcome either. The strictest reading is the only one left.
      result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } },
    });
    // The fact the record claims, measured from outside the production code: after the phase budget had
    // already expired - i.e. while the parent was attempting its termination and deciding - the child
    // was still answering a probe.
    expect(forced.samples.some(sample => sample.at >= phaseBudget && sample.alive)).toBe(true);
    expect(forced.aliveAfterDecision).toBe(true);
    expect(probeProcess(forced.pid)).toBe('ALIVE');
    // And the record it wrote is not a release: the proof carries the tree state, which is not DEAD.
    expect(closureProof(forced.evidence!)).toMatchObject({ protocol_version: 'kff.guardian-closure-no-progress.v1', process_tree: 'UNKNOWN' });
    expect(forced.closed).toBe('GUARDIAN_UNCONFIRMED');
    expect(closuresIn(forced.runtime)).toEqual([command.id + '.json']);
  } finally { reap(forced.pid); }
  expect(await eventuallyGone(forced.pid)).toBe(true);
}, 30000);

/**
 * The same termination of a child that never sent `ready` at all. The outcome is what changed with this
 * batch: the phase alone used to read as a cancelled command, and a cancelled command is a command that
 * may be tried again - which is not a claim anyone can make about a process that is still running.
 */
it('never calls a command cancelled while its process is still answering', async () => {
  const command = closureCommand();
  const forced = await forceWithoutTool(command, 'before-ready', { budgets: budgets(hungBeforeReady) });
  expect(forced.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  expect(forced.evidence).toMatchObject({
    phase: 'awaiting-ready', termination: { process_tree: 'UNKNOWN', tool: 'ERROR', root: 'ALIVE', enumeration: 'UNAVAILABLE' },
    context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true,
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
  });
  expect(closureProof(forced.evidence!)).toMatchObject({ protocol_version: 'kff.guardian-closure-no-progress.v1', process_tree: 'UNKNOWN' });
  expect(forced.closed).toBe('GUARDIAN_UNCONFIRMED');
  expect(forced.gone).toBe(true);
}, 30000);

it('records a Guardian that is still alive after the submission boundary as needing a human, not as an unknown outcome', async () => {
  const command = submitBoundaryCommand();
  const forced = await forceWithoutTool(command, 'after-grant');
  try {
    expect(forced.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
    expect(forced.asked).toBe(1);
    // The child had been granted submission authority and was still running when the parent gave up, so
    // the honest answer is the strictest one. `submission_state` stays UNKNOWN - what could have been
    // written is a different question from whether anyone may reuse this environment.
    expect(forced.evidence).toMatchObject({
      phase: 'submitting', termination: { process_tree: 'UNKNOWN', tool: 'ERROR', root: 'ALIVE' },
      context_opened: false, submission_state: 'UNKNOWN', forced: true,
      result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
    });
    // This one really is alive after the decision, for a reason of its own: it is parked waiting for
    // something that never arrives, and the closed channel does not end it. That is the case the
    // batch is about - the execution slot may not be freed on the strength of a force that did not work.
    expect(forced.aliveAfterDecision).toBe(true);
    expect(probeProcess(forced.pid)).toBe('ALIVE');
    expect(forced.closed).toBe('GUARDIAN_UNCONFIRMED');
  } finally { reap(forced.pid); }
  expect(await eventuallyGone(forced.pid)).toBe(true);
}, 30000);
