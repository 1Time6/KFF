import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AgentCommand } from '@kff/contracts';
import { AppError } from '@kff/core';
import { guardianLivenessPhases, readClosure, readClosureEvidence, saveNoProgress, saveStartupFailure, type GuardianClosure, type GuardianLivenessPhase } from './guardian-protocol';
import { isProcessAlive, terminateProcessTree } from './process-tree';
import { browserProviderEnvironment } from './browser-provider-configuration';

/**
 * The fault-injection switch for the regression test that reproduces a guardian dying before `ready`.
 * It must never be reachable by a production run, so three independent conditions have to hold:
 *   - `NODE_ENV=test`, which a packaged or `local:run` Agent does not set;
 *   - the normalised runtime directory sits inside `<KFF_ROOT>/.kff/agent-process-tests/`, decided by
 *     comparing resolved, normalised paths with `path.relative` - never a substring test, which a
 *     sibling directory such as `.kff/agent-process-tests-prod` would otherwise satisfy;
 *   - the environment variable is exactly `true`.
 * Any disagreement resolves to `false`, which is the sealed behaviour: keep the isolation.
 */
/**
 * Fault injection may only ever run inside `<KFF_ROOT>/.kff/agent-process-tests/`, decided by
 * comparing resolved, normalised paths with `path.relative` - never a substring test, which a
 * sibling directory such as `.kff/agent-process-tests-prod` would otherwise satisfy.
 */
function insideAgentProcessTests(runtime: string, environment: Readonly<Record<string, string | undefined>>) {
  const testsRoot = path.resolve(environment.KFF_ROOT ?? process.cwd(), '.kff', 'agent-process-tests');
  const candidate = path.normalize(path.resolve(runtime));
  const relative = path.relative(testsRoot, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function guardianStartupFaultInjection(runtime: string, environment: Readonly<Record<string, string | undefined>> = process.env) {
  if (environment.NODE_ENV !== 'test') return false;
  if (environment.KFF_TEST_GUARDIAN_DIES_BEFORE_READY !== 'true') return false;
  return insideAgentProcessTests(runtime, environment);
}
/** Exported for `tests/unit/guardian-startup-fault-injection.test.ts`, which pins every condition above. */
export const guardianStartupFaultInjectionEnabled = guardianStartupFaultInjection;

/**
 * The hang injection behind the liveness regression. It is sealed by the same three conditions as the
 * startup fault, and the value has to name one of the points the child knows, so an unexpected
 * environment variable is ignored rather than half-applied.
 */
export const guardianHangPoints = ['before-ready', 'before-start-ack', 'after-start', 'after-context', 'before-grant', 'after-grant'] as const;
export type GuardianHangPoint = typeof guardianHangPoints[number];
function guardianHangInjection(runtime: string, environment: Readonly<Record<string, string | undefined>> = process.env): GuardianHangPoint | undefined {
  if (environment.NODE_ENV !== 'test') return undefined;
  const requested = environment.KFF_TEST_GUARDIAN_HANG_AT;
  if (!requested || !(guardianHangPoints as readonly string[]).includes(requested)) return undefined;
  return insideAgentProcessTests(runtime, environment) ? requested as GuardianHangPoint : undefined;
}

/**
 * How long each phase may stay silent before the parent stops waiting. This is bounded liveness, not
 * a single stopwatch: the budget belongs to the phase, and every observed progress event starts the
 * next phase's budget, so a slow browser launch never spends the budget of a slow executor run.
 *
 * The budgets differ because the facts behind them differ. `awaiting-ready` and `awaiting-start`
 * cover process startup, which is measured in seconds. `awaiting-context` covers a browser launch the
 * child itself bounds at 20 seconds. `awaiting-intent` covers the whole executor run up to the
 * submission boundary - page reads that legitimately scroll for a long time - so it is the most
 * generous. `granting` covers one controller call. `submitting` covers the platform write and its
 * receipt. A phase a longer budget cannot rescue still ends in the record's own honest outcome
 * rather than in a fabricated one, so a false positive costs a human review instead of a wrong fact.
 */
export interface GuardianLivenessPolicy {
  'awaiting-ready': number; 'awaiting-start': number; 'awaiting-context': number; 'awaiting-intent': number;
  granting: number; submitting: number; grace: number; force: number;
}
const livenessDefaults: GuardianLivenessPolicy = { 'awaiting-ready': 30000, 'awaiting-start': 30000, 'awaiting-context': 120000, 'awaiting-intent': 900000, granting: 60000, submitting: 300000, grace: 15000, force: 10000 };
const livenessEnvironment: Record<keyof GuardianLivenessPolicy, string> = {
  'awaiting-ready': 'KFF_GUARDIAN_AWAITING_READY_MS', 'awaiting-start': 'KFF_GUARDIAN_AWAITING_START_MS',
  'awaiting-context': 'KFF_GUARDIAN_AWAITING_CONTEXT_MS', 'awaiting-intent': 'KFF_GUARDIAN_AWAITING_INTENT_MS',
  granting: 'KFF_GUARDIAN_GRANTING_MS', submitting: 'KFF_GUARDIAN_SUBMITTING_MS', grace: 'KFF_GUARDIAN_GRACE_MS', force: 'KFF_GUARDIAN_FORCE_MS',
};
/** Explicit overrides win over the environment, and a value that is not a positive integer is ignored. */
export function guardianLivenessPolicy(overrides: Partial<GuardianLivenessPolicy> = {}, environment: Readonly<Record<string, string | undefined>> = process.env): GuardianLivenessPolicy {
  const policy = { ...livenessDefaults };
  for (const key of Object.keys(policy) as (keyof GuardianLivenessPolicy)[]) {
    const raw = overrides[key] ?? environment[livenessEnvironment[key]];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) policy[key] = value;
  }
  return policy;
}

export function runGuardian(command: AgentCommand, runtime: string, nonce: string, hooks: { beforeSubmit(): Promise<void>; signal: AbortSignal; onSpawn?(pid: number): void; onContextOpened?(): void | Promise<void>; liveness?: Partial<GuardianLivenessPolicy> }): Promise<GuardianClosure> {
  return new Promise((resolve, reject) => {
    const policy = guardianLivenessPolicy(hooks.liveness);
    // The child receives no controller token or database credentials. It cannot grant itself submission authority.
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'development', ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH|KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN|KFF_BROWSER_INBOX_FIXTURE_ORIGIN|KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN|KFF_ENABLE_LIVE|KFF_ENABLE_DISCOVERY|KFF_ENABLE_BROWSER_INBOX|KFF_FACEBOOK_GRAPH_VERSION|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY)$/.test(key) || /^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]+$/.test(key) || /^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key))) };
    if (command.snapshot.browser_environment) Object.assign(env, browserProviderEnvironment(path.resolve(process.env.KFF_ROOT ?? process.cwd())));
    const killBeforeReady = guardianStartupFaultInjection(runtime);
    const hangAt = guardianHangInjection(runtime);
    if (hangAt) Object.assign(env, { KFF_TEST_GUARDIAN_HANG_AT: hangAt });
    // Windows must let the guardian survive its parent long enough to close the browser and persist proof.
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./guardian-child.ts', import.meta.url))], { cwd: process.cwd(), env, windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    if (killBeforeReady) child.kill('SIGKILL');
    let started = false; let submitted = false; let contextOpened = false;
    // The phase is what the parent has observed, not what the child is doing. It is the unit the
    // watchdog budgets, so it only ever advances on evidence the parent actually received.
    let phase: GuardianLivenessPhase = 'awaiting-ready';
    let phaseSince = Date.now();
    let watchdogFired = false;
    let forced = false;
    const progress = (next: GuardianLivenessPhase) => { phase = next; phaseSince = Date.now(); };
    const send = (value: unknown) => { if (child.connected) child.send(value as object, () => {}); };
    const stop = () => send({ type: 'stop' });
    const keepalive = setInterval(() => { if (!hooks.signal.aborted) send({ type: 'keepalive' }); }, 2000);
    hooks.signal.addEventListener('abort', stop);
    // One child lifetime gets exactly one terminal decision. `error`, `exit` and `close` can arrive in
    // any combination, and a spawn failure emits `error` and `close` without ever emitting `exit`, so
    // the decision cannot be attached to a single event name.
    let settled = false;
    const settle = (decide: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      clearInterval(watchdog);
      hooks.signal.removeEventListener('abort', stop);
      try { decide(); } catch (error) { reject(error); }
    };
    /**
     * The watchdog fired, so no honest answer to "what did the child achieve" exists any more. The
     * phase decides the outcome, because the phase is the last thing the parent actually observed:
     * a child that never sent `ready` never reached the executor, so the command is cancelled; every
     * later phase may own a context nobody has proven closed, so it is recorded as needing a human and
     * the environment stays quarantined. A submission that could have been reached also sets
     * `submission_state` to UNKNOWN, which is a different fact from `context_opened`.
     */
    const recordNoProgress = (processTerminated: boolean) => {
      const waited_ms = Math.min(Date.now() - phaseSince, 86400000);
      const neverReachedExecutor = phase === 'awaiting-ready' && !started && !submitted && !contextOpened;
      const outcome = !processTerminated ? 'NEEDS_HUMAN' : phase === 'submitting' ? 'UNKNOWN_OUTCOME' : neverReachedExecutor ? 'CANCELED' : 'NEEDS_HUMAN';
      saveNoProgress(runtime, { command_id: command.id, action_id: command.action_id, nonce, phase, process_terminated: processTerminated, context_opened: contextOpened, submission_state: phase === 'granting' || phase === 'submitting' ? 'UNKNOWN' : 'NOT_SUBMITTED', forced, waited_ms, grace_ms: policy.grace, result: { outcome, error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } } });
      return new AppError('GUARDIAN_NO_PROGRESS', '执行进程长期没有进展，已被终止，且没有取得关闭证明', 409);
    };
    const settleTerminal = (processTerminated: boolean) => settle(() => {
      const identity = { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce };
      if (readClosureEvidence(runtime, identity)) { resolve(readClosure(runtime, identity)!); return; }
      // A child the watchdog had to end has already had every chance to write its own proof. Nothing
      // arriving means the proof does not exist, and the record says only what the parent knows.
      if (watchdogFired) throw recordNoProgress(processTerminated);
      // The child is gone and never sent `ready`, so the parent never sent `start`, the executor was
      // never reached, no browser context exists and no submission could have been requested. That is
      // a fact the journal already proves, so it is recorded instead of leaving the command to block
      // this agent for good. Anything after `start` keeps the original isolation: the child may own a
      // context that nobody has proven closed.
      if (!started && !submitted && !contextOpened) {
        const result = { outcome: 'CANCELED' as const, error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } };
        saveStartupFailure(runtime, { command_id: command.id, action_id: command.action_id, nonce, result });
        throw new AppError('GUARDIAN_STARTUP_FAILED', '执行进程在启动阶段退出，没有浏览器上下文可以关闭', 409);
      }
      throw new AppError('GUARDIAN_UNCONFIRMED', '执行进程退出但没有关闭证明，资源保持隔离', 409);
    });
    const waitForTerminal = async (ms: number) => {
      const until = Date.now() + ms;
      while (!settled && Date.now() < until) await delay(Math.min(50, Math.max(5, Math.floor(ms / 4))));
      return settled;
    };
    /**
     * Stops the execution the watchdog gave up on. Asking first is not politeness: a child that is
     * merely stuck, rather than dead, can still close its context and write its own closure, and that
     * real proof is always better than anything the parent could write. Only a child that stays silent
     * through the grace period is ended, and ending it is what proves the process is gone.
     */
    const terminate = async () => {
      send({ type: 'stop' });
      if (await waitForTerminal(policy.grace)) return;
      forced = true;
      terminateProcessTree(child.pid);
      if (await waitForTerminal(policy.force)) return;
      // No event arrived even after the tree was ended. The promise still settles: leaving it pending
      // is the defect this watchdog exists for. Termination is only claimed if the process is gone.
      settleTerminal(!isProcessAlive(child.pid));
    };
    const budgets = Object.fromEntries(guardianLivenessPhases.map(name => [name, policy[name]])) as Record<GuardianLivenessPhase, number>;
    const tick = Math.max(20, Math.min(1000, Math.floor(Math.min(...Object.values(budgets)) / 4)));
    const watchdog = setInterval(() => {
      if (settled || watchdogFired) return;
      if (Date.now() - phaseSince < budgets[phase]) return;
      watchdogFired = true;
      void terminate();
    }, tick);
    child.on('message', async message => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'ready' && !started) {
        started = true;
        progress('awaiting-start');
        try { hooks.onSpawn?.(child.pid!); send({ type: 'start', command, runtime: path.resolve(runtime), profile_root: path.resolve(process.env.KFF_ROOT ?? process.cwd(), '.kff/browser-environments'), nonce }); if (hooks.signal.aborted) stop(); }
        catch (error) { child.disconnect(); reject(error); }
      }
      // The child confirms it parsed `start`, which is the only way the parent can tell "start never
      // arrived" apart from "start arrived and the browser launch is what is stuck".
      if (message.type === 'started' && started) progress('awaiting-context');
      if (message.type === 'before-submit') {
        // The watchdog's first duty is to stop new submission authority: once it has fired this child
        // never receives `submit-granted` again, whatever else happens.
        if (submitted || watchdogFired || hooks.signal.aborted) { stop(); return; }
        submitted = true;
        progress('granting');
        try { await hooks.beforeSubmit(); if (hooks.signal.aborted || watchdogFired) stop(); else { progress('submitting'); send({ type: 'submit-granted' }); } }
        catch (error) { send({ type: 'submit-rejected', code: error instanceof AppError ? error.code : 'CONTROL_UNAVAILABLE' }); }
      }
      if (message.type === 'context-opened') { contextOpened = true; if (phase === 'awaiting-start' || phase === 'awaiting-context') progress('awaiting-intent'); try { await hooks.onContextOpened?.(); } catch { stop(); } }
    });
    child.once('error', error => {
      // A missing pid means the operating system never created the process, and `exit` will never
      // follow. A child that does have a pid may still own a context, so its own termination stays the
      // only thing allowed to decide and the error is still reported to the caller unchanged.
      if (child.pid === undefined) settleTerminal(true); else settle(() => reject(error));
    });
    child.once('exit', () => settleTerminal(true));
    child.once('close', () => settleTerminal(true));
  });
}
