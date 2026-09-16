import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, digest, requireCondition } from '@kff/core';
import { environmentCommand, type EnvironmentResult } from '../../../packages/contracts/src/environment';
import { openManagedBrowser, type ManagedBrowser } from '../../../packages/adapters/src/browser-profile';
import { saveEnvironmentClosure } from './environment-protocol';
import { inspectFacebookProfileIdentity } from '../../../packages/adapters/src/facebook-browser-identity';

const startSchema = z.object({ type: z.literal('start'), command: environmentCommand, runtime: z.string(), profile_root: z.string(), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
let started = false; let stopped = false; let lastControl = performance.now(); let session: ManagedBrowser | undefined;
const stop = () => { stopped = true; if (session) void session.close().catch(() => {}); };
process.on('disconnect', stop); process.on('SIGINT', stop); process.on('SIGTERM', stop);
const idleTimer = setTimeout(() => process.exit(1), 10000);
process.on('message', async raw => {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
  if (raw.type === 'keepalive') { lastControl = performance.now(); return; }
  if (raw.type === 'stop') { stop(); return; }
  if (raw.type !== 'start' || started) return;
  started = true; clearTimeout(idleTimer);
  const parsed = startSchema.safeParse(raw); if (!parsed.success) { process.exit(1); return; }
  const { command, runtime, profile_root, nonce } = parsed.data;
  let result: EnvironmentResult = { context_closed: true, outcome: 'BLOCKED', error_code: 'EXECUTOR_ERROR' };
  const watchdog = setInterval(() => { if (!process.connected || performance.now() - lastControl > 15000 || Date.parse(command.expires_at) <= Date.now()) stop(); }, 1000);
  try {
    requireCondition(!stopped && process.connected && digest(command.snapshot) === command.snapshot_hash && Date.parse(command.expires_at) > Date.now(), 'VERSION_CONFLICT', '环境命令不再有效');
    session = await openManagedBrowser(profile_root, command.snapshot, command.operation === 'CHECK');
    requireCondition(!stopped, 'STOP_REQUESTED', '环境操作已停止');
    process.send?.({ type: 'opened', browser_version: session.version }, () => {});
    const page = await session.context.newPage();
    if (command.operation === 'CHECK') {
      const actual = await page.evaluate(() => ({ locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      const expected = command.snapshot.configuration;
      const timezone = new Intl.DateTimeFormat('en', { timeZone: expected.timezone_id }).resolvedOptions().timeZone;
      requireCondition(actual.locale.toLowerCase() === expected.locale.toLowerCase() && actual.timezone === timezone, 'BROWSER_CONFIG_MISMATCH', '浏览器语言或时区与登记配置不符');
      result = { context_closed: true, outcome: 'CHECKED', browser_version: session.version };
      if (!command.snapshot.is_synthetic && command.snapshot.platform === 'facebook' && command.snapshot.account_type === 'profile') {
        result.identity = await inspectFacebookProfileIdentity(page, expected.operating_identity_id);
      }
    } else {
      let url = command.snapshot.platform === 'facebook' ? 'https://www.facebook.com/' : 'https://www.instagram.com/';
      if (command.snapshot.is_synthetic) url = 'http://127.0.0.1:4311/page?account=' + command.snapshot.configuration.operating_identity_id + '&action=' + command.id + '&scenario=normal';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      while (!stopped && !page.isClosed()) await delay(200);
      result = { context_closed: true, outcome: 'CLOSED', browser_version: session.version };
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'GUARDIAN_UNCONFIRMED') { clearInterval(watchdog); process.exit(1); return; }
    result = { context_closed: true, outcome: 'BLOCKED', error_code: error instanceof AppError ? error.code : 'BROWSER_RUNTIME_ERROR', ...(session ? { browser_version: session.version } : {}) };
  }
  try {
    await session?.close();
    saveEnvironmentClosure(runtime, { id: command.id, nonce, result, closed_at: new Date().toISOString() });
    clearInterval(watchdog); process.exit(0);
  } catch { clearInterval(watchdog); process.exit(1); }
});
process.send?.({ type: 'ready' });
