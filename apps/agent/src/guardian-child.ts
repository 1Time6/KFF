import {executeFacebookBrowserComment} from '../../../packages/adapters/src/facebook-browser-comment';
import { executeFacebookBrowserMessage } from '../../../packages/adapters/src/facebook-browser-message';
import { executeBrowserMessage } from '../../../packages/adapters/src/browser-message';
import { executeFacebookBrowserInbox } from '../../../packages/adapters/src/facebook-browser-inbox';
import { executeBrowserInbox } from '../../../packages/adapters/src/browser-inbox';
import { z } from 'zod';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { performance } from 'node:perf_hooks';
import type { BrowserContext } from '@playwright/test';
import { agentCommandSchema, hashSchema, type ActionReport } from '@kff/contracts';
import { AppError, requireCondition, digest } from '@kff/core';
import { adapterImplementationDigest } from '../../../packages/core/src/artifacts';
import { executeFixture, FacebookPageAdapter } from '@kff/adapters';
import {FacebookMessengerAdapter,executeFixtureMessage} from '../../../packages/adapters/src/facebook-messenger';
import {executeInstagramIdentity,executeSocialOutreach} from '../../../packages/adapters/src/social-outreach';
import { executeBrowserDiscovery, executeFacebookBrowserDiscovery } from '../../../packages/adapters/src/browser-discovery';
import { saveClosure } from './guardian-protocol';

const startInput = z.object({ type: z.literal('start'), command: agentCommandSchema, runtime: z.string(), profile_root: z.string().optional(), nonce: hashSchema }).strict();
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
/**
 * Sealed test-only fault injection. It exists so the liveness regression can make a real guardian
 * child stop making progress at a chosen point of its real lifecycle instead of waiting for an
 * intermittent hang to show up. The parent only ever sets the variable for a run whose NODE_ENV is
 * `test` and whose runtime directory is a guardian process-test root, and this side re-checks
 * NODE_ENV, so no production run can reach it.
 */
const hangPoint = process.env.NODE_ENV === 'test' ? process.env.KFF_TEST_GUARDIAN_HANG_AT : undefined;
/**
 * Alive and answering, simply never progressing: the child waits for something that never arrives.
 * Bounded so that a run which armed this injection and then died cannot leave a process behind; every
 * budget that can reach it is shorter than this.
 */
const hangSilently = (ms = 60000) => new Promise<never>(() => { setTimeout(() => process.exit(1), ms); });
/**
 * Frozen: the event loop stops running, which is exactly what a browser call that never returns does
 * to this process. Bounded so a leaked injection can never spin forever; every budget that reaches
 * it is far shorter than this.
 */
const hangFrozen = (ms = 60000) => { const until = Date.now() + ms; while (Date.now() < until) { /* frozen event loop */ } };
/** Every executor reports its context through here, so the injection has exactly one home. */
const onContext = (value: BrowserContext | null) => {
  context = value;
  if (value && process.connected) process.send?.({ type: 'context-opened' }, () => {});
  if (value && control.signal.aborted) void value.close().catch(() => {});
  if (value && hangPoint === 'after-context') hangFrozen();
};
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
  if (hangPoint === 'before-start-ack') { await hangSilently(); return; }
  // The parent budgets its phases on what it has actually observed, so it needs to know that `start`
  // arrived. Without this the parent cannot tell a child that never received `start` from one that is
  // stuck inside the browser launch it began after receiving it.
  if (process.connected) process.send?.({ type: 'started' }, () => {});
  if (hangPoint === 'after-start') { hangFrozen(); return; }
  const watchdog = setInterval(() => { if (performance.now() - lastControl >= 20000) stop(); }, 1000);
  let result: Omit<ActionReport, 'event_id' | 'command_id'>; let intentGranted = false;
  const beforeSubmit = async () => {
    assertControlled();
    await new Promise<void>((resolve, reject) => {
      submitWait = { resolve, reject };
      process.send?.({ type: 'before-submit' }, error => { if (error) { submitWait = undefined; reject(error); } });
      // The request has to leave this process before its event loop stops, so this stall is scheduled
      // rather than entered inline. What it models is a child that asked for authority and then froze
      // while it waited for an answer - not a child that never asked.
      if (hangPoint === 'before-grant') setTimeout(hangFrozen, 100);
    });
    intentGranted = true; assertControlled();
    if (hangPoint === 'after-grant') return hangSilently();
  };
  try {
    assertControlled();
    requireCondition(digest(command.snapshot) === command.snapshot_hash && digest(command.snapshot.body) === command.snapshot.content_hash, 'APPROVAL_STALE', '任务快照不匹配');
    requireCondition(Date.parse(command.expires_at) > Date.now(), 'LEASE_STALE', '命令已经过期');
    if (command.snapshot.is_synthetic) {
      result = command.snapshot.inbox ? await executeBrowserInbox(command, parsed.data.profile_root ?? path.join(runtime, 'browser-environments'), { beforeSubmit, assertControlled, onContext }, process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN) : command.snapshot.collection ? await executeBrowserDiscovery(command, parsed.data.profile_root ?? path.join(runtime, 'browser-environments'), { beforeSubmit, assertControlled, onContext }, process.env.KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN) : command.snapshot.outreach?{outcome:'VERIFIED_SUCCEEDED',receipt:await executeSocialOutreach(command.snapshot,command.action_id,{beforeSubmit,signal:control.signal}),diagnostic:{step:'social-accepted'}}:command.snapshot.message?.browser?await executeBrowserMessage(command, parsed.data.profile_root ?? path.join(runtime, 'browser-environments'), { beforeSubmit, assertControlled, onContext }, process.env.KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN):command.snapshot.message?{outcome:'VERIFIED_SUCCEEDED',receipt:await executeFixtureMessage(command,{beforeSubmit,assertControlled,signal:control.signal}),diagnostic:{step:'message-accepted'}}:await executeFixture(command, command.snapshot.browser_environment ? parsed.data.profile_root ?? path.join(runtime, 'browser-environments') : path.join(runtime, 'profiles'), { beforeSubmit, assertControlled, onContext });
    } else if (['facebook.discovery.read.browser','facebook.inbox.read.browser','facebook.messenger.reply.browser','facebook.comment.reply.browser'].includes(command.snapshot.capability_key)) {
      requireCondition(command.snapshot.implementation_digest === adapterImplementationDigest(fileURLToPath(new URL('../../../',import.meta.url)), 'facebook'), 'VERSION_CONFLICT', '本机采集适配器与已审核实现不匹配');
      result = await (command.snapshot.outreach?.browser ? executeFacebookBrowserComment : command.snapshot.message ? executeFacebookBrowserMessage : command.snapshot.inbox ? executeFacebookBrowserInbox : executeFacebookBrowserDiscovery)(command, parsed.data.profile_root ?? path.join(runtime, 'browser-environments'), { beforeSubmit, assertControlled, onContext });
    } else {
      requireCondition(process.env.KFF_ENABLE_LIVE === 'true', 'LIVE_DISABLED', '真实执行未启用');
      requireCondition(command.snapshot.implementation_digest === adapterImplementationDigest(fileURLToPath(new URL('../../../',import.meta.url)), 'facebook'), 'VERSION_CONFLICT', '本机适配器与已审核实现不匹配');
      requireCondition(command.snapshot.credential_ref, 'AUTH_EXPIRED', '任务缺少已审核的凭据引用');
      const credential = process.env[command.snapshot.credential_ref];
      requireCondition(credential && process.env.KFF_FACEBOOK_GRAPH_VERSION, 'AUTH_EXPIRED', 'Facebook 凭据和版本尚未配置');
      requireCondition(command.snapshot.platform_api_version === process.env.KFF_FACEBOOK_GRAPH_VERSION, 'VERSION_CONFLICT', 'Graph API 版本与已审核版本不符');
      const options={ version: command.snapshot.platform_api_version!, pageToken: credential, signal: control.signal, assertControlled };
      const receipt = command.snapshot.capability_key==='instagram.account.read.api'?await executeInstagramIdentity(command.snapshot,{token:credential,signal:control.signal}):command.snapshot.outreach?await executeSocialOutreach(command.snapshot,command.action_id,{beforeSubmit,signal:control.signal,token:credential}):command.snapshot.message?await new FacebookMessengerAdapter(options).execute(command.snapshot,beforeSubmit,command.action_id):await new FacebookPageAdapter(options).execute(command.snapshot,beforeSubmit);
      result = { outcome: 'VERIFIED_SUCCEEDED', receipt, diagnostic: { step: 'graph-verified' } };
    }
  } catch (error) { if (error instanceof AppError && error.code === 'GUARDIAN_UNCONFIRMED') { clearInterval(watchdog); process.exit(1); return; } result = { outcome: intentGranted?'UNKNOWN_OUTCOME':control.signal.aborted ? 'CANCELED' : 'BLOCKED', error_code: error instanceof AppError ? error.code : 'EXECUTOR_ERROR', diagnostic: { step: 'executor-failed' } }; }
  if (control.signal.aborted && result.outcome !== 'VERIFIED_SUCCEEDED') { result.outcome = intentGranted ? 'UNKNOWN_OUTCOME' : 'CANCELED'; result.error_code = 'STOP_REQUESTED'; }
  // A failed or killed guardian never writes this proof. Its caller must retain isolation.
  try {
    if (context) await (context as BrowserContext).close(); context = null;
    if ((command.snapshot.collection || command.snapshot.inbox) && Date.parse(command.snapshot.inbox?.expires_at ?? command.snapshot.collection?.expires_at ?? command.expires_at) <= Date.now()) result = { outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED', diagnostic: { step: 'collection-retention-expired' } };
    result.diagnostic.duration_ms = Math.min(3600000, Math.round(performance.now() - start));
    result.diagnostic.executor_version = 'kff-agent-0.1.0_node-' + process.versions.node;
    saveClosure(runtime, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, nonce, closed_at: new Date().toISOString(), context_closed: true, result });
    clearInterval(watchdog);
    process.exit(0);
  } catch { process.exit(1); }
});
// The idle timer would end a child that never received `start`, which is a different fact from a
// child that is stalled, so the injection clears it and then stops progressing.
if (hangPoint === 'before-ready') { clearTimeout(idleTimer); hangFrozen(); } else process.send?.({ type: 'ready' });
