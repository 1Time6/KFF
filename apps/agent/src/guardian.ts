import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand } from '@kff/contracts';
import { AppError } from '@kff/core';
import { readClosure, saveStartupFailure, type GuardianClosure } from './guardian-protocol';
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
function guardianStartupFaultInjection(runtime: string, environment: Readonly<Record<string, string | undefined>> = process.env) {
  if (environment.NODE_ENV !== 'test') return false;
  if (environment.KFF_TEST_GUARDIAN_DIES_BEFORE_READY !== 'true') return false;
  const testsRoot = path.resolve(environment.KFF_ROOT ?? process.cwd(), '.kff', 'agent-process-tests');
  const candidate = path.normalize(path.resolve(runtime));
  const relative = path.relative(testsRoot, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** Exported for the unit contract that pins every condition this switch must satisfy. */
export const guardianStartupFaultInjectionEnabled = guardianStartupFaultInjection;

export function runGuardian(command: AgentCommand, runtime: string, nonce: string, hooks: { beforeSubmit(): Promise<void>; signal: AbortSignal; onSpawn?(pid: number): void; onContextOpened?(): void | Promise<void> }): Promise<GuardianClosure> {
  return new Promise((resolve, reject) => {
    // The child receives no controller token or database credentials. It cannot grant itself submission authority.
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'development', ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH|KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN|KFF_BROWSER_INBOX_FIXTURE_ORIGIN|KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN|KFF_ENABLE_LIVE|KFF_ENABLE_DISCOVERY|KFF_ENABLE_BROWSER_INBOX|KFF_FACEBOOK_GRAPH_VERSION|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY)$/.test(key) || /^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]+$/.test(key) || /^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key))) };
    if (command.snapshot.browser_environment) Object.assign(env, browserProviderEnvironment(path.resolve(process.env.KFF_ROOT ?? process.cwd())));
    const killBeforeReady = guardianStartupFaultInjection(runtime);
    // Windows must let the guardian survive its parent long enough to close the browser and persist proof.
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./guardian-child.ts', import.meta.url))], { cwd: process.cwd(), env, windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    if (killBeforeReady) child.kill('SIGKILL');
    let started = false; let submitted = false; let contextOpened = false;
    const send = (value: unknown) => { if (child.connected) child.send(value as object, () => {}); };
    const stop = () => send({ type: 'stop' });
    const keepalive = setInterval(() => { if (!hooks.signal.aborted) send({ type: 'keepalive' }); }, 2000);
    hooks.signal.addEventListener('abort', stop);
    child.on('message', async message => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'ready' && !started) {
        started = true;
        try { hooks.onSpawn?.(child.pid!); send({ type: 'start', command, runtime: path.resolve(runtime), profile_root: path.resolve(process.env.KFF_ROOT ?? process.cwd(), '.kff/browser-environments'), nonce }); if (hooks.signal.aborted) stop(); }
        catch (error) { child.disconnect(); reject(error); }
      }
      if (message.type === 'before-submit') {
        if (submitted || hooks.signal.aborted) { stop(); return; }
        submitted = true;
        try { await hooks.beforeSubmit(); if (hooks.signal.aborted) stop(); else send({ type: 'submit-granted' }); }
        catch (error) { send({ type: 'submit-rejected', code: error instanceof AppError ? error.code : 'CONTROL_UNAVAILABLE' }); }
      }
      if (message.type === 'context-opened') { contextOpened = true; try { await hooks.onContextOpened?.(); } catch { stop(); } }
    });
    child.once('error', error => { clearInterval(keepalive); hooks.signal.removeEventListener('abort', stop); reject(error); });
    child.once('exit', () => {
      clearInterval(keepalive);
      hooks.signal.removeEventListener('abort', stop);
      try {
        const record = readClosure(runtime, { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce });
        if (record) { resolve(record); return; }
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
      } catch (error) { reject(error); }
    });
  });
}
