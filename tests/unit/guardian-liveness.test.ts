import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runGuardian } from '../../apps/agent/src/guardian';
import { isProcessAlive } from '../../apps/agent/src/process-tree';
import { readClosure, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { fixtureCommand, submitBoundaryCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

// Every case drives the production `runGuardian` against a real child process that really stops making
// progress. The child is asked to stall through a sealed, test-only switch that the production code
// only arms for a runtime directory inside `<KFF_ROOT>/.kff/agent-process-tests/` while NODE_ENV is
// `test`, so this file builds exactly that layout in its own throwaway root.
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b011-hang-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const nonce = () => randomBytes(32).toString('hex');
const identity = (command: AgentCommand, value: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: value });
/** The stored hash deliberately disagrees with the snapshot, so this command stops before it opens anything. */
function closureCommand(): AgentCommand { return { ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) }; }

/**
 * Short budgets keep the test fast; the production defaults are two to three orders of magnitude
 * larger. `startup` is the one budget that cannot be shortened to a test-scale number: it has to
 * cover a real interpreter booting the real guardian child, which is over a second, so a budget
 * below that would fire before the child could ever report and would measure nothing.
 */
const phaseBudget = 700, terminationGrace = 600, forceKill = 3000;
const startupBudget = 10000, hungBeforeReady = 4000;
/**
 * The deadline that turns a guardian which never settles into a failure instead of a hung suite. The
 * slowest healthy case spends its whole phase budget plus the termination grace, so this sits well
 * above the healthy worst case and well below anything a human would wait for.
 */
const caseDeadline = 12000;
const budgets = (startup: number) => ({ 'awaiting-ready': startup, 'awaiting-start': phaseBudget, 'awaiting-context': phaseBudget, 'awaiting-intent': phaseBudget, granting: phaseBudget, submitting: phaseBudget, grace: terminationGrace, force: forceKill });

function injectionRoot(point: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b011-hang-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', point);
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
/**
 * The switch is read synchronously while `runGuardian` builds its spawn call, so the environment only
 * has to hold for that instant. It is restored immediately so no other test inherits an armed switch.
 */
function withInjectionEnvironment(root: string, point: string | undefined) {
  // `NODE_ENV` is declared readonly by the platform types, and this is the one place a test has to
  // move it: the switch is read synchronously while `runGuardian` builds its spawn call.
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT], ['NODE_ENV', environment.NODE_ENV]] as const;
  environment.KFF_ROOT = root; environment.NODE_ENV = 'test';
  if (point) environment.KFF_TEST_GUARDIAN_HANG_AT = point; else delete environment.KFF_TEST_GUARDIAN_HANG_AT;
  return () => { for (const [key, value] of previous) { if (value === undefined) delete environment[key]; else environment[key] = value; } };
}
async function eventuallyGone(pid: number | undefined) {
  for (let attempt = 0; attempt < 50; attempt++) { if (!isProcessAlive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return !isProcessAlive(pid);
}

interface Hung { runtime: string; command: AgentCommand; value: string; outcome: { kind: 'resolved' | 'rejected'; code?: string }; settled: number; gone: boolean; evidence: ReturnType<typeof readClosureEvidence>; closed: string }
async function runHung(point: string | undefined, command: AgentCommand, options: { submit?: () => Promise<void>; budgets?: ReturnType<typeof budgets> } = {}): Promise<Hung> {
  const { root, runtime } = injectionRoot(point ?? 'no-hang');
  const value = nonce(); const controller = new AbortController(); let pid: number | undefined;
  const restore = withInjectionEnvironment(root, point);
  const startedAt = Date.now();
  const running = runGuardian(command, runtime, value, { signal: controller.signal, onSpawn: spawned => { pid = spawned; }, beforeSubmit: options.submit ?? (async () => {}), liveness: options.budgets ?? budgets(startupBudget) });
  restore();
  const outcome = await running.then(closure => ({ kind: 'resolved' as const, code: closure.protocol_version }), error => ({ kind: 'rejected' as const, code: (error as { code?: string }).code }));
  const settled = Date.now() - startedAt;
  const evidence = readClosureEvidence(runtime, identity(command, value));
  let closed = 'none';
  try { readClosure(runtime, identity(command, value)); closed = 'read-as-closed'; } catch (error) { closed = (error as { code?: string }).code ?? 'unknown'; }
  return { runtime, command, value, outcome, settled, gone: await eventuallyGone(pid), evidence, closed };
}

it('ends a child that never became ready, and records only that the process is gone', async () => {
  const hung = await runHung('before-ready', closureCommand(), { budgets: budgets(hungBeforeReady) });
  expect(hung.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  // Nothing downstream of `ready` can have happened here, so this is the one phase that is cancelled.
  expect(hung.evidence).toEqual({
    protocol_version: 'kff.guardian-closure-no-progress.v1', command_id: hung.command.id, action_id: hung.command.action_id,
    nonce: hung.value, closed_at: expect.any(String), phase: 'awaiting-ready', process_terminated: true,
    context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true, waited_ms: expect.any(Number), grace_ms: terminationGrace,
    result: { outcome: 'CANCELED', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } },
  });
  // The deadline was really spent waiting, not fired early, and exactly one record exists.
  expect((hung.evidence as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(hungBeforeReady);
  expect(readdirSync(path.join(hung.runtime, 'agent', 'closures'))).toEqual([hung.command.id + '.json']);
  // The weaker fact can never be read back as a closed context, whatever the outcome says.
  expect(hung.closed).toBe('GUARDIAN_UNCONFIRMED');
}, caseDeadline);

it('ends a child that received start but never confirmed it, keeping the environment isolated', async () => {
  const hung = await runHung('before-start-ack', closureCommand());
  expect(hung.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  // `start` was sent and never acknowledged: the parent must not treat this as a browser that failed
  // to launch, because it has no evidence that the launch was even attempted.
  expect(hung.evidence).toMatchObject({ phase: 'awaiting-start', process_terminated: true, context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true, result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' } });
  expect(hung.evidence).not.toHaveProperty('context_closed');
  expect(hung.gone).toBe(true);
  expect(hung.closed).toBe('GUARDIAN_UNCONFIRMED');
}, caseDeadline);

it('ends a child that stalled before the context it was launching ever reported, keeping the environment isolated', async () => {
  const hung = await runHung('after-start', closureCommand());
  expect(hung.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  expect(hung.evidence).toMatchObject({ phase: 'awaiting-context', process_terminated: true, context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true, result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' } });
  expect(hung.evidence).not.toHaveProperty('context_closed');
  expect(hung.gone).toBe(true);
}, caseDeadline);

it('ends a child that stalled while asking for submission authority, and never claims a submission did not happen', async () => {
  const hung = await runHung('before-grant', submitBoundaryCommand(), { submit: () => new Promise(() => {}) });
  expect(hung.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  expect(hung.evidence).toMatchObject({ phase: 'granting', process_terminated: true, context_opened: false, submission_state: 'UNKNOWN', forced: true, result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' } });
  expect(hung.evidence).not.toHaveProperty('context_closed');
  expect(hung.gone).toBe(true);
}, caseDeadline);

it('ends a child that stalled after the submission it was granted, and reports an unknown outcome', async () => {
  const hung = await runHung('after-grant', submitBoundaryCommand());
  expect(hung.outcome).toEqual({ kind: 'rejected', code: 'GUARDIAN_NO_PROGRESS' });
  expect(hung.evidence).toMatchObject({ phase: 'submitting', process_terminated: true, submission_state: 'UNKNOWN', result: { outcome: 'UNKNOWN_OUTCOME', error_code: 'GUARDIAN_NO_PROGRESS' } });
  expect(hung.evidence).not.toHaveProperty('context_closed');
  expect(hung.gone).toBe(true);
}, caseDeadline);

/**
 * The stop request is not decoration. A child that is stuck but still answering can close what it
 * opened and write its own proof, and that proof is always better than anything the parent could
 * write, so the watchdog waits for it and uses it instead of recording a termination.
 */
it('prefers a real closure from a child that stops cleanly over a recorded termination', async () => {
  const hung = await runHung(undefined, submitBoundaryCommand(), { submit: () => new Promise(() => {}), budgets: { ...budgets(startupBudget), grace: 5000 } });
  expect(hung.outcome).toEqual({ kind: 'resolved', code: 'kff.guardian-closure.v1' });
  expect(hung.evidence).toMatchObject({ protocol_version: 'kff.guardian-closure.v1', context_closed: true, result: { outcome: 'CANCELED', error_code: 'STOP_REQUESTED' } });
  expect(JSON.parse(readFileSync(path.join(hung.runtime, 'agent', 'closures', hung.command.id + '.json'), 'utf8'))).toMatchObject({ protocol_version: 'kff.guardian-closure.v1' });
  expect(hung.gone).toBe(true);
}, caseDeadline);
