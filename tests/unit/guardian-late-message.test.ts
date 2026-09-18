import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { runGuardian, type GuardianLivenessPolicy } from '../../apps/agent/src/guardian';
import { readClosure, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { isProcessAlive } from '../../apps/agent/src/process-tree';
import { submitBoundaryCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

/**
 * What happens to a message that arrives around the moment the parent has already decided the run is
 * over. Every case drives the production `runGuardian` against a real child process in a sealed
 * runtime root; none of them re-implements the decision they are checking.
 *
 * The invariant is one sentence long: a terminal decision hands out nothing further. No `start`, no
 * `submit-granted`, no phase advance, no second record - whatever is still in flight, and whatever the
 * child does next.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-late-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const nonce = () => randomBytes(32).toString('hex');
const identity = (command: AgentCommand, value: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: value });
/** Absence of a proof is a fact of its own, so a runtime that never wrote one answers with an empty list. */
function evidenceFiles(runtime: string) {
  const directory = path.join(runtime, 'agent', 'closures');
  return existsSync(directory) ? readdirSync(directory) : [];
}
/** A child that survived what the parent decided is this test's own responsibility to clean up. */
const reap = (pid: number | undefined) => { try { if (pid !== undefined) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

const phaseBudget = 700, terminationGrace = 600, forceKill = 3000, startupBudget = 10000;
function budgets(overrides: Partial<GuardianLivenessPolicy> = {}): GuardianLivenessPolicy {
  return { 'awaiting-ready': startupBudget, 'awaiting-start': phaseBudget, 'awaiting-context': phaseBudget, 'awaiting-intent': phaseBudget, granting: phaseBudget, submitting: phaseBudget, grace: terminationGrace, force: forceKill, ...overrides };
}
function injectionRoot(point: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-late-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', point);
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
/** The sealed switch is read while `runGuardian` builds its spawn call, so it only has to hold that long. */
function withSealedInjection<T>(root: string, point: string | undefined, body: () => T): T {
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT], ['NODE_ENV', environment.NODE_ENV]] as const;
  environment.KFF_ROOT = root; environment.NODE_ENV = 'test';
  if (point) environment.KFF_TEST_GUARDIAN_HANG_AT = point; else delete environment.KFF_TEST_GUARDIAN_HANG_AT;
  try { return body(); } finally { for (const [key, value] of previous) { if (value === undefined) delete environment[key]; else environment[key] = value; } }
}
async function eventuallyGone(pid: number | undefined) {
  for (let attempt = 0; attempt < 40; attempt++) { if (!isProcessAlive(pid)) return true; await delay(100); }
  return !isProcessAlive(pid);
}
const outcomeOf = (running: Promise<unknown>) => running.then(() => ({ kind: 'resolved' as const, code: 'resolved' }), error => ({ kind: 'rejected' as const, code: (error as { code?: string }).code }));

/**
 * The child is handling `ready` when the decision is taken: the spawn hook refuses it. That refusal is
 * the caller's, and what matters is what it cannot cause. `ready` is the only message that makes the
 * parent send `start`, `start` is the only way into the executor, and the executor is the only writer
 * of a closure - so an empty closures directory is that whole chain being cut at once, and a
 * `beforeSubmit` that would have thrown its own error is a hook that was never reached.
 */
it('sends no start and writes no evidence when the decision is taken while ready is being handled', async () => {
  const command = submitBoundaryCommand(); const value = nonce();
  const { root, runtime } = injectionRoot('no-hang');
  let pid: number | undefined; let spawned = 0;
  const refusal = Object.assign(new Error('测试钩子：拒绝本次执行'), { code: 'TEST_ONSPAWN_REFUSED' });
  const running = withSealedInjection(root, undefined, () => runGuardian(command, runtime, value, {
    signal: new AbortController().signal, liveness: budgets(),
    onSpawn: spawnedPid => { spawned += 1; pid = spawnedPid; throw refusal; },
    beforeSubmit: async () => { throw new Error('the executor must never be reached'); },
  }));
  try {
    expect(await outcomeOf(running)).toEqual({ kind: 'rejected', code: 'TEST_ONSPAWN_REFUSED' });
    expect(spawned).toBe(1);
    // Nothing downstream of `ready` happened, and nothing was written down about a run that never ran.
    expect(evidenceFiles(runtime)).toEqual([]);
    expect(readClosureEvidence(runtime, identity(command, value))).toBeNull();
    // The channel is closed, so the child leaves on its own instead of being left holding a command the
    // parent has already given up on.
    expect(await eventuallyGone(pid)).toBe(true);
  } finally { reap(pid); }
}, 30000);

/**
 * The submission boundary is where a late message would cost the most: `before-submit` is the child
 * asking for authority to write to the platform, and the parent answers it by calling the controller.
 * Here the watchdog fires while that controller call is still pending, and the call then resolves - a
 * real answer arriving after the parent has already decided the run is over.
 *
 * The observable is the phase the record carries. `submit-granted` is sent on the same line as
 * `progress('submitting')`, so a grant would show up as `submitting` in the terminal record; the
 * record says `granting`, which is only possible if the authority was refused. The child really was
 * ended - asserted by probing it - so the refusal is not an artifact of a force that failed.
 */
it('refuses submission authority when the controller answers after the watchdog has fired', async () => {
  const command = submitBoundaryCommand(); const value = nonce();
  const { root, runtime } = injectionRoot('before-grant');
  let pid: number | undefined; let asked = 0; let answeredAt = 0;
  const running = withSealedInjection(root, 'before-grant', () => runGuardian(command, runtime, value, {
    signal: new AbortController().signal, liveness: budgets(),
    onSpawn: spawnedPid => { pid = spawnedPid; },
    // Resolves inside the grace window: after the watchdog fired, before the child was ended.
    beforeSubmit: async () => { asked += 1; await delay(phaseBudget + terminationGrace / 2); answeredAt = Date.now(); },
  }));
  try {
    const outcome = await outcomeOf(running);
    expect(outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
    expect(asked).toBe(1);
    expect(answeredAt).toBeGreaterThan(0);
    const evidence = readClosureEvidence(runtime, identity(command, value));
    expect(evidence).toMatchObject({
      protocol_version: 'kff.guardian-closure-no-progress.v1', phase: 'granting',
      submission_state: 'UNKNOWN', forced: true,
      // The child had asked to submit but was never granted, so the three-state tree fact is the only
      // thing this test leaves to the platform: what is asserted here is what the record says it is.
      termination: { process_tree: expect.stringMatching(/^(ALIVE|DEAD|UNKNOWN)$/), tool: expect.any(String), sampled: expect.any(Number), enumeration: expect.any(String) },
      result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
    });
    // No grant ever reached the child: the phase a grant would have set is not the phase on record.
    expect(evidence).not.toMatchObject({ phase: 'submitting' });
    // The force worked, measured from outside: the child is gone, so the refusal to grant is a decision
    // about a run that really ended rather than about one that is still running.
    expect(await eventuallyGone(pid)).toBe(true);
    // One record, and it is not a closure: the child was ended, so nothing closed the context.
    expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
    expect(() => readClosure(runtime, identity(command, value))).toThrow();
  } finally { reap(pid); }
}, 30000);

/**
 * The same arrangement with the answer arriving after the run has already settled. A late answer can
 * neither reopen the command nor rewrite what was recorded about it: the record on disk is read before
 * and after the answer, and the two readings are byte-identical.
 */
it('cannot reopen or rewrite a settled run when the controller answers long afterwards', async () => {
  const command = submitBoundaryCommand(); const value = nonce();
  const { root, runtime } = injectionRoot('before-grant');
  const file = path.join(runtime, 'agent', 'closures', command.id + '.json');
  let pid: number | undefined; let asked = 0; let lateAnswerAt = 0; let settledAt = 0;
  const running = withSealedInjection(root, 'before-grant', () => runGuardian(command, runtime, value, {
    signal: new AbortController().signal, liveness: budgets(),
    onSpawn: spawnedPid => { pid = spawnedPid; },
    // Far past every budget, so the decision is taken with the answer still outstanding.
    beforeSubmit: async () => { asked += 1; await delay(forceKill + terminationGrace * 4); lateAnswerAt = Date.now(); },
  }));
  try {
    await running.then(() => { settledAt = Date.now(); }, () => { settledAt = Date.now(); });
    expect(asked).toBe(1);
    const recorded = readFileSync(file, 'utf8');
    await expect.poll(() => lateAnswerAt, { timeout: 30000 }).toBeGreaterThan(0);
    expect(settledAt).toBeLessThan(lateAnswerAt);
    // The late answer changed nothing: same bytes, same single record, still not a closure.
    expect(readFileSync(file, 'utf8')).toBe(recorded);
    expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
    expect(() => readClosure(runtime, identity(command, value))).toThrow();
    expect(await eventuallyGone(pid)).toBe(true);
  } finally { reap(pid); }
}, 40000);
