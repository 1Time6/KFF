import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { digest, requireCondition, AppError } from '@kff/core';
import { environmentCommand, type EnvironmentCommand } from '../../../packages/contracts/src/environment';
import { readEnvironmentClosure, saveEnvironmentClosure } from './environment-protocol';
import { browserProviderEnvironment } from './browser-provider-configuration';

type Api = <T>(endpoint: string, body?: unknown) => Promise<T>;
interface Entry { id: string; nonce: string; acknowledged: boolean }
export function environmentRunner(runtime: string, profileRoot: string, identity: { agent_id: string; organization_id: string; brand_id: string }, api: Api) {
  const journalFile = path.join(runtime, 'agent', 'environment-journal.json'); mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal: Record<string, Entry> = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {};
  const save = () => { writeFileSync(journalFile + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(journalFile + '.tmp', journalFile); };
  async function flush() {
    for (const entry of Object.values(journal).filter(item => !item.acknowledged)) {
      const closure = readEnvironmentClosure(runtime, entry.id, entry.nonce);
      if (!closure) return false;
      await api('environment-commands/' + entry.id + '/result', closure.result); entry.acknowledged = true; save();
    }
    return true;
  }
  async function run(raw: EnvironmentCommand, signal: AbortSignal) {
    const command = environmentCommand.parse(raw); const scope = command.snapshot;
    requireCondition(scope.agent_id === identity.agent_id && scope.organization_id === identity.organization_id && scope.brand_id === identity.brand_id, 'FORBIDDEN_SCOPE', '环境命令不属于本机配对');
    requireCondition(digest(scope) === command.snapshot_hash && Date.parse(command.expires_at) > Date.now(), 'VERSION_CONFLICT', '环境命令无效或已过期');
    requireCondition(!journal[command.id], 'SUBMISSION_UNCERTAIN', '已经接收过此环境命令，禁止重新启动');
    const entry = { id: command.id, nonce: randomBytes(32).toString('hex'), acknowledged: false }; journal[entry.id] = entry; save();
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'development', ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY)$/.test(key) || /^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key))) };
    try { Object.assign(env, browserProviderEnvironment(path.resolve(profileRoot, '../..'))); }
    catch {
      // No child has been started: persist that known failure so a bad key file cannot strand the slot.
      saveEnvironmentClosure(runtime, { id: command.id, nonce: entry.nonce, closed_at: new Date().toISOString(), result: { context_closed: true, outcome: 'BLOCKED', error_code: 'AGENT_CONFIGURATION_INVALID' } });
      await flush(); return;
    }
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./environment-child.ts', import.meta.url))], { cwd: process.cwd(), env, windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const send = (value: object) => { if (child.connected) child.send(value, () => {}); };
    let controlled = true; let lastHeartbeat = performance.now(); let busy = false; let started = false;
    const stop = () => { controlled = false; send({ type: 'stop' }); };
    signal.addEventListener('abort', stop);
    child.on('message', async message => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'ready' && !started) { started = true; send({ type: 'start', command, runtime, profile_root: profileRoot, nonce: entry.nonce }); if (signal.aborted || !controlled) stop(); }
      if (message.type === 'opened' && 'browser_version' in message) {
        try { const answer = await api<{ continue: boolean }>('environment-commands/' + command.id + '/opened', { browser_version: message.browser_version }); if (!answer.continue) stop(); } catch { stop(); }
      }
    });
    const timer = setInterval(async () => {
      if (!controlled || signal.aborted) { stop(); return; }
      if (busy) return; busy = true;
      try { const answer = await api<{ continue: boolean }>('environment-commands/' + command.id + '/heartbeat'); lastHeartbeat = performance.now(); if (answer.continue) send({ type: 'keepalive' }); else stop(); }
      catch (error) { if (performance.now() - lastHeartbeat > 10000 || error instanceof AppError && [401, 403].includes(error.status)) stop(); }
      finally { busy = false; }
    }, 3000);
    try { await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); }); }
    finally { clearInterval(timer); signal.removeEventListener('abort', stop); }
    requireCondition(await flush(), 'GUARDIAN_UNCONFIRMED', '旧浏览器缺少关闭证明，环境保持隔离');
  }
  return { flush, run };
}
