import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand } from '@kff/contracts';
import { AppError } from '@kff/core';
import { readClosure, type GuardianClosure } from './guardian-protocol';
import { browserProviderEnvironment } from './browser-provider-configuration';

export function runGuardian(command: AgentCommand, runtime: string, nonce: string, hooks: { beforeSubmit(): Promise<void>; signal: AbortSignal; onSpawn?(pid: number): void; onContextOpened?(): void | Promise<void> }): Promise<GuardianClosure> {
  return new Promise((resolve, reject) => {
    // The child receives no controller token or database credentials. It cannot grant itself submission authority.
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'development', ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH|KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN|KFF_BROWSER_INBOX_FIXTURE_ORIGIN|KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN|KFF_ENABLE_LIVE|KFF_ENABLE_DISCOVERY|KFF_ENABLE_BROWSER_INBOX|KFF_FACEBOOK_GRAPH_VERSION|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY)$/.test(key) || /^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]+$/.test(key) || /^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key))) };
    if (command.snapshot.browser_environment) Object.assign(env, browserProviderEnvironment(path.resolve(process.env.KFF_ROOT ?? process.cwd())));
    // Windows must let the guardian survive its parent long enough to close the browser and persist proof.
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./guardian-child.ts', import.meta.url))], { cwd: process.cwd(), env, windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let started = false; let submitted = false;
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
      if (message.type === 'context-opened') { try { await hooks.onContextOpened?.(); } catch { stop(); } }
    });
    child.once('error', error => { clearInterval(keepalive); hooks.signal.removeEventListener('abort', stop); reject(error); });
    child.once('exit', () => {
      clearInterval(keepalive);
      hooks.signal.removeEventListener('abort', stop);
      try {
        const record = readClosure(runtime, { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce });
        if (!record) throw new AppError('GUARDIAN_UNCONFIRMED', '执行进程退出但没有关闭证明，资源保持隔离', 409);
        resolve(record);
      } catch (error) { reject(error); }
    });
  });
}
