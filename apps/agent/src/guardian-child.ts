import { z } from 'zod';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserContext } from '@playwright/test';
import { agentCommandSchema, hashSchema, type ActionReport } from '@kff/contracts';
import { AppError, requireCondition, digest } from '@kff/core';
import { adapterImplementationDigest } from '../../../packages/core/src/artifacts';
import { executeFixture, FacebookPageAdapter } from '@kff/adapters';
import { saveClosure } from './guardian-protocol';

const startInput = z.object({ type: z.literal('start'), command: agentCommandSchema, runtime: z.string(), nonce: hashSchema }).strict();
const control = new AbortController();
let context: BrowserContext | null = null; let started = false;
let lastControl = performance.now();
let submitWait: { resolve(): void; reject(error: Error): void } | undefined;
const assertControlled = () => requireCondition(!control.signal.aborted && process.connected, 'STOP_REQUESTED', '本地 guardian 已失去控制连接');
const stop = () => {
  control.abort(); submitWait?.reject(new AppError('STOP_REQUESTED', '控制连接已停止')); submitWait = undefined;
  if (context) void context.close().catch(() => {});
  if (!started) process.exit(0);
};
process.on('disconnect', stop); process.on('SIGINT', stop); process.on('SIGTERM', stop);
const idleTimer = setTimeout(() => process.exit(1), 10000);
process.on('message', async raw => {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
  if (raw.type === 'keepalive') { lastControl = performance.now(); return; }
  if (raw.type === 'stop') { stop(); return; }
  if (raw.type === 'submit-granted') { submitWait?.resolve(); submitWait = undefined; return; }
  if (raw.type === 'submit-rejected') {
    const code = 'code' in raw && typeof raw.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(raw.code) ? raw.code : 'CONTROL_UNAVAILABLE';
    submitWait?.reject(new AppError(code, '提交门槛拒绝执行')); submitWait = undefined; return;
  }
  if (raw.type !== 'start' || started) return;
  started = true; clearTimeout(idleTimer);
  const parsed = startInput.safeParse(raw); if (!parsed.success) { process.exit(1); return; }
  const { command, runtime, nonce } = parsed.data; const start = performance.now();
  lastControl = performance.now();
  const watchdog = setInterval(() => { if (performance.now() - lastControl >= 20000) stop(); }, 1000);
  let result: Omit<ActionReport, 'event_id' | 'command_id'>; let intentGranted = false;
  const beforeSubmit = async () => {
    assertControlled();
    await new Promise<void>((resolve, reject) => { submitWait = { resolve, reject }; process.send?.({ type: 'before-submit' }, error => { if (error) { submitWait = undefined; reject(error); } }); });
    intentGranted = true; assertControlled();
  };
  try {
    assertControlled();
    requireCondition(digest(command.snapshot) === command.snapshot_hash && digest(command.snapshot.body) === command.snapshot.content_hash, 'APPROVAL_STALE', '任务快照不匹配');
    requireCondition(Date.parse(command.expires_at) > Date.now(), 'LEASE_STALE', '命令已经过期');
    if (command.snapshot.is_synthetic) {
      result = await executeFixture(command, path.join(runtime, 'profiles'), { beforeSubmit, assertControlled, onContext: value => { context = value; if (value && process.connected) process.send?.({ type: 'context-opened' }, () => {}); if (value && control.signal.aborted) void value.close().catch(() => {}); } });
    } else {
      requireCondition(process.env.KFF_ENABLE_LIVE === 'true', 'LIVE_DISABLED', '真实执行未启用');
      requireCondition(command.snapshot.implementation_digest === adapterImplementationDigest(path.dirname(runtime), 'facebook'), 'VERSION_CONFLICT', '本机适配器与已审核实现不匹配');
      requireCondition(command.snapshot.credential_ref, 'AUTH_EXPIRED', '任务缺少已审核的凭据引用');
      const credential = process.env[command.snapshot.credential_ref];
      requireCondition(credential && process.env.KFF_FACEBOOK_GRAPH_VERSION, 'AUTH_EXPIRED', 'Facebook 凭据和版本尚未配置');
      requireCondition(command.snapshot.platform_api_version === process.env.KFF_FACEBOOK_GRAPH_VERSION, 'VERSION_CONFLICT', 'Graph API 版本与已审核版本不符');
      const adapter = new FacebookPageAdapter({ version: command.snapshot.platform_api_version!, pageToken: credential, signal: control.signal, assertControlled });
      const receipt = await adapter.execute(command.snapshot, beforeSubmit);
      result = { outcome: 'VERIFIED_SUCCEEDED', receipt, diagnostic: { step: 'graph-verified' } };
    }
  } catch (error) { result = { outcome: control.signal.aborted ? 'CANCELED' : 'BLOCKED', error_code: error instanceof AppError ? error.code : 'EXECUTOR_ERROR', diagnostic: { step: 'executor-failed' } }; }
  if (control.signal.aborted && result.outcome !== 'VERIFIED_SUCCEEDED') { result.outcome = intentGranted ? 'UNKNOWN_OUTCOME' : 'CANCELED'; result.error_code = 'STOP_REQUESTED'; }
  // A failed or killed guardian never writes this proof. Its caller must retain isolation.
  try {
    if (context) await (context as BrowserContext).close(); context = null;
    result.diagnostic.duration_ms = Math.min(3600000, Math.round(performance.now() - start));
    result.diagnostic.executor_version = 'kff-agent-0.1.0_node-' + process.versions.node;
    saveClosure(runtime, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, nonce, closed_at: new Date().toISOString(), context_closed: true, result });
    clearInterval(watchdog);
    process.exit(0);
  } catch { process.exit(1); }
});
process.send?.({ type: 'ready' });
