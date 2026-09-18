import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { guardianTimingLimits, type AgentCommand, type GuardianTermination } from '@kff/contracts';
import { AppError } from '@kff/core';
import { guardianLivenessPhases, readClosure, readClosureEvidence, saveNoProgress, saveStartupFailure, type GuardianClosure, type GuardianLivenessPhase } from './guardian-protocol';
import { composeTreeState, probeProcess, terminateProcessTree } from './process-tree';
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
/**
 * The part of the force budget held back from the termination call, so the wait that follows it has
 * time to observe the child's `exit`. It can be small because the wait is not doing any work: by then
 * the tree has been signalled, and all the wait does is let the event loop deliver an event that is
 * already queued. Sized from the same measurement as the termination split - the kill itself is a
 * ~300 ms tool, and the settle wait after it is shorter still.
 */
const FORCED_SETTLE_RESERVE_MS = 1000;
const livenessEnvironment: Record<keyof GuardianLivenessPolicy, string> = {
  'awaiting-ready': 'KFF_GUARDIAN_AWAITING_READY_MS', 'awaiting-start': 'KFF_GUARDIAN_AWAITING_START_MS',
  'awaiting-context': 'KFF_GUARDIAN_AWAITING_CONTEXT_MS', 'awaiting-intent': 'KFF_GUARDIAN_AWAITING_INTENT_MS',
  granting: 'KFF_GUARDIAN_GRANTING_MS', submitting: 'KFF_GUARDIAN_SUBMITTING_MS', grace: 'KFF_GUARDIAN_GRACE_MS', force: 'KFF_GUARDIAN_FORCE_MS',
};
/** Explicit overrides win over the environment. A value outside the accepted range is refused, never ignored. */
export function guardianLivenessPolicy(overrides: Partial<GuardianLivenessPolicy> = {}, environment: Readonly<Record<string, string | undefined>> = process.env, options: { runtime?: string } = {}): GuardianLivenessPolicy {
  const policy = { ...livenessDefaults };
  // The regression that pins bounded liveness needs budgets two orders of magnitude below anything a
  // production run may use, so it runs under the same seal as the fault injection: test mode, and a
  // runtime directory inside `<KFF_ROOT>/.kff/agent-process-tests/`. Without both, the production range
  // applies and a sub-millisecond budget is refused like any other illegal configuration.
  const sealed = environment.NODE_ENV === 'test' && options.runtime !== undefined && insideAgentProcessTests(options.runtime, environment);
  const minimum = sealed ? guardianTimingLimits.test_min_ms : guardianTimingLimits.min_ms;
  let total = 0;
  for (const key of Object.keys(policy) as (keyof GuardianLivenessPolicy)[]) {
    const raw = overrides[key] ?? environment[livenessEnvironment[key]];
    if (raw === undefined) { total += policy[key]; continue; }
    const value = typeof raw === 'number' ? raw : Number(raw);
    // A configuration error used to be silent: the bad value was dropped and the default took over, so
    // an operator who mistyped a budget got the production default and no way to notice. A guardian
    // that waits the wrong amount of time is a safety property, so the value is refused instead, and
    // the Agent surfaces it at startup rather than at the first command that needs the watchdog.
    requireLiveness(Number.isSafeInteger(value) && value >= minimum && value <= guardianTimingLimits.max_ms, livenessEnvironment[key], `必须是 ${minimum} 到 ${guardianTimingLimits.max_ms} 之间的整数毫秒值，实际为 ${JSON.stringify(raw)}`);
    policy[key] = value;
    total += value;
  }
  // The evidence schema records how long the run waited, so the sum of the configured budgets is what
  // bounds that recording. Checking it here keeps a legal configuration from producing a closure proof
  // that the schema would reject after the fact - which would lose the proof, not just the number.
  requireLiveness(total <= guardianTimingLimits.max_total_ms, '合计', `所有阶段加上 grace / force 的和不得超过 ${guardianTimingLimits.max_total_ms} 毫秒，实际为 ${total}`);
  return policy;
}
function requireLiveness(condition: boolean, name: string, detail: string): asserts condition {
  if (!condition) throw new AppError('GUARDIAN_LIVENESS_INVALID', `Guardian 存活预算配置非法（${name}）：${detail}`, 500);
}
/**
 * Called once when the Agent starts. `guardianLivenessPolicy` already refuses an illegal value, but it
 * only runs when a command is launched; validating the same configuration at startup is what turns a
 * bad environment variable into a refused boot instead of a command that fails hours later.
 */
export function assertGuardianLivenessConfiguration(environment: Readonly<Record<string, string | undefined>> = process.env) {
  return guardianLivenessPolicy({}, environment);
}

export function runGuardian(command: AgentCommand, runtime: string, nonce: string, hooks: { beforeSubmit(): Promise<void>; signal: AbortSignal; onSpawn?(pid: number): void; onContextOpened?(): void | Promise<void>; liveness?: Partial<GuardianLivenessPolicy> }, dependencies: { terminate?: typeof terminateProcessTree } = {}): Promise<GuardianClosure> {
  return new Promise((resolve, reject) => {
    const policy = guardianLivenessPolicy(hooks.liveness, process.env, { runtime });
    // The termination utility is the one dependency the settlement race depends on, and the only
    // seam the settlement tests need: production always passes nothing, so the default is the real
    // `terminateProcessTree`. A test may substitute a controlled promise to pin the exact moment the
    // child's terminal events arrive relative to the termination verdict - the ordering the race is
    // about - without touching the rest of the guardian's lifecycle.
    const terminateTree = dependencies.terminate ?? terminateProcessTree;
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
    /** What the termination call proved, kept so the terminal record can carry the real fact rather than a guess. */
    let forcedTermination: GuardianTermination | undefined;
    // F1: the termination verdict and the child's terminal events race each other. The flag marks the
    // window in which the verdict is still awaited; the second flag records that `exit`/`close`/`error`
    // arrived inside that window. An event is not a verdict, so it must not settle the run.
    let terminationInFlight = false;
    let terminalEventObserved = false;
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
      // Both doors the child could still use to reach this command are shut here. Detaching the message
      // listener drops a `ready`, `context-opened` or `before-submit` that was already in flight when
      // the decision was taken, so it cannot restart a command that has finished; disconnecting makes
      // sure the child is never handed submission authority afterwards, even if it is still running.
      child.off('message', onMessage);
      try { if (child.connected) child.disconnect(); } catch { /* the channel is already gone */ }
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
    /**
     * The process fact the record will carry. The termination call's own verdict was taken at kill
     * time, so the root is probed again here: a process that is gone now is a stronger fact than one
     * that was gone then. When no termination was ever performed - a child that exited on its own
     * during the grace period - the descendants stay `UNKNOWN` rather than being rounded up to `DEAD`,
     * because nobody enumerated them. That is the honest answer, and it is also the safe one: a tree
     * that cannot be proven dead does not license releasing the execution slot.
     */
    const terminationFact = (): GuardianTermination => {
      const root = probeProcess(child.pid);
      const base = forcedTermination ?? { process_tree: 'UNKNOWN' as const, tool: 'SKIPPED' as const, root: 'DEAD' as const, descendants: 'UNKNOWN' as const, sampled: 0, enumeration: 'UNAVAILABLE' as const, elapsed_ms: 0 };
      return { ...base, root, process_tree: base.enumeration === 'UNAVAILABLE' ? 'UNKNOWN' : composeTreeState(root, [base.descendants]) };
    };
    const recordNoProgress = () => {
      const waited_ms = Math.min(Date.now() - phaseSince, guardianTimingLimits.max_total_ms);
      const termination = terminationFact();
      const neverReachedExecutor = phase === 'awaiting-ready' && !started && !submitted && !contextOpened;
      // Only a proven dead tree earns anything better than "a human has to look". The mapping is
      // deliberately the stricter reading of the old one: it used to key off a boolean that a root-only
      // probe could set, so a live browser could be recorded as a terminated tree; now the same three
      // outcomes require the tree itself to be dead, and an `ALIVE` or `UNKNOWN` tree always lands on
      // NEEDS_HUMAN.
      const dead = termination.process_tree === 'DEAD';
      const outcome = !dead ? 'NEEDS_HUMAN' : phase === 'submitting' ? 'UNKNOWN_OUTCOME' : neverReachedExecutor ? 'CANCELED' : 'NEEDS_HUMAN';
      saveNoProgress(runtime, { command_id: command.id, action_id: command.action_id, nonce, phase, termination, context_opened: contextOpened, submission_state: phase === 'granting' || phase === 'submitting' ? 'UNKNOWN' : 'NOT_SUBMITTED', forced, waited_ms, grace_ms: policy.grace, result: { outcome, error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } } });
      return new AppError('GUARDIAN_NO_PROGRESS', '执行进程长期没有进展，已被终止，且没有取得关闭证明', 409);
    };
    const settleTerminal = () => {
      // While the forced termination is still awaited, a terminal event is exactly that - an event.
      // Settling now would record the fallback UNKNOWN and throw the real verdict the termination is
      // about to hand back away (the race the Machine B matrix exposed). The deferral is bounded: the
      // termination call runs under the force deadline, and its continuation settles the moment the
      // verdict lands or the budget ends.
      if (terminationInFlight) { terminalEventObserved = true; return; }
      settle(() => {
        const identity = { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce };
        if (readClosureEvidence(runtime, identity)) { resolve(readClosure(runtime, identity)!); return; }
        // A child the watchdog had to end has already had every chance to write its own proof. Nothing
        // arriving means the proof does not exist, and the record says only what the parent knows.
        if (watchdogFired) throw recordNoProgress();
        // The child is gone and never sent `ready`, so the parent never sent `start`, the executor was
        // never reached, no browser context exists and no submission could have been requested. That is
        // a fact the journal already proves, so it is recorded instead of leaving the command to block
        // this agent for good. Anything after `start` keeps the original isolation: the child may own a
        // context that nobody has proven closed.
        if (!started && !submitted && !contextOpened) {
          const result = { outcome: 'CANCELED' as const, error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } };
          // The termination fact is attached only when a termination really happened. Nothing was ended
          // in the ordinary startup failure, and inventing a process verdict for it would be exactly the
          // kind of manufactured fact this record exists to avoid.
          saveStartupFailure(runtime, { command_id: command.id, action_id: command.action_id, nonce, termination: forcedTermination, result });
          throw new AppError('GUARDIAN_STARTUP_FAILED', '执行进程在启动阶段退出，没有浏览器上下文可以关闭', 409);
        }
        throw new AppError('GUARDIAN_UNCONFIRMED', '执行进程退出但没有关闭证明，资源保持隔离', 409);
      });
    };
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
     *
     * The termination utility runs *inside* the deadline rather than beside it. It used to be a
     * synchronous call that could hold the event loop for as long as the tool wanted, which made the
     * force budget a number the parent hoped for rather than one it enforced; now the call and the wait
     * after it share the same budget, so the whole forced phase is bounded and a taskkill that never
     * returns cannot stretch it.
     */
    const terminate = async () => {
      send({ type: 'stop' });
      if (await waitForTerminal(policy.grace)) return;
      forced = true;
      const forcedUntil = Date.now() + policy.force;
      // The termination gets everything except a small reserve, and the reserve is what is genuinely
      // needed: once `taskkill /T /F` has returned, the child is already dead and the wait below only
      // has to let the event loop deliver its `exit`. Holding back half the budget for that wait was
      // the defect - the listing alone costs ~800 ms idle and ~2 s under load, so half of a 5 s force
      // left it about one second of margin, and a starved listing reports `UNKNOWN` and quarantines a
      // browser that nothing was wrong with. The two shares still sum to exactly `policy.force`,
      // because `forcedUntil` was fixed before the call: this moves budget between the stages, it does
      // not extend the total.
      const settleReserve = Math.max(1, Math.min(Math.floor(policy.force / 5), FORCED_SETTLE_RESERVE_MS));
      terminationInFlight = true;
      try {
        forcedTermination = await terminateTree(child.pid, { deadlineMs: Math.max(1, policy.force - settleReserve) });
      } catch {
        // The termination call failed before it could produce a verdict. There is no fact to preserve,
        // so the fallback below - an honest UNKNOWN - is exactly what remains.
      } finally {
        terminationInFlight = false;
      }
      // A terminal decision may already have been taken while the verdict was awaited; a late
      // continuation must not settle again or write a second record.
      if (settled) return;
      // The child's terminal event arrived during the termination: settle now, carrying the verdict.
      if (terminalEventObserved) { settleTerminal(); return; }
      if (await waitForTerminal(Math.max(1, forcedUntil - Date.now()))) return;
      // No event arrived even after the tree was ended. The promise still settles: leaving it pending
      // is the defect this watchdog exists for. Whether the process is really gone is not decided here
      // any more - that judgement now travels with the record, and an unproven tree keeps its isolation.
      settleTerminal();
    };
    const budgets = Object.fromEntries(guardianLivenessPhases.map(name => [name, policy[name]])) as Record<GuardianLivenessPhase, number>;
    const tick = Math.max(20, Math.min(1000, Math.floor(Math.min(...Object.values(budgets)) / 4)));
    const watchdog = setInterval(() => {
      if (settled || watchdogFired) return;
      if (Date.now() - phaseSince < budgets[phase]) return;
      watchdogFired = true;
      void terminate();
    }, tick);
    // The handler is a named declaration so `settle` can detach it: once a terminal decision is taken,
    // this function must not run again for this child, whatever is still in flight on the channel.
    async function onMessage(message: unknown) {
      if (settled) return;
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'ready' && !started) {
        started = true;
        progress('awaiting-start');
        // A throwing hook used to reject the promise directly and leave the watchdog and the channel
        // running behind it. It goes through the same one-shot terminal path as everything else.
        try { hooks.onSpawn?.(child.pid!); send({ type: 'start', command, runtime: path.resolve(runtime), profile_root: path.resolve(process.env.KFF_ROOT ?? process.cwd(), '.kff/browser-environments'), nonce }); if (hooks.signal.aborted) stop(); }
        catch (error) { settle(() => reject(error)); }
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
        try { await hooks.beforeSubmit(); if (settled) return; if (hooks.signal.aborted || watchdogFired) stop(); else { progress('submitting'); send({ type: 'submit-granted' }); } }
        catch (error) { send({ type: 'submit-rejected', code: error instanceof AppError ? error.code : 'CONTROL_UNAVAILABLE' }); }
      }
      if (message.type === 'context-opened') { contextOpened = true; if (phase === 'awaiting-start' || phase === 'awaiting-context') progress('awaiting-intent'); try { await hooks.onContextOpened?.(); } catch { stop(); } }
    }
    child.on('message', onMessage);
    child.once('error', error => {
      // A missing pid means the operating system never created the process, and `exit` will never
      // follow. A child that does have a pid may still own a context, so its own termination stays the
      // only thing allowed to decide and the error is still reported to the caller unchanged.
      if (child.pid === undefined) { settleTerminal(); return; }
      // A pid-bearing child cannot normally emit `error` at this call site (failed sends land in the
      // send callback), but if one arrives mid-termination it is another terminal event: the verdict
      // still decides, and the fallback is never allowed to pre-empt it.
      if (terminationInFlight) { terminalEventObserved = true; return; }
      settle(() => reject(error));
    });
    child.once('exit', () => settleTerminal());
    child.once('close', () => settleTerminal());
  });
}
