import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext } from '@playwright/test';
import { agentConfig, runtimeDir } from './config';
import { AppError, digest, requireCondition } from '@kff/core';
import { adapterImplementationDigest } from '../../../packages/core/src/artifacts';
import { executeFixture, FacebookPageAdapter } from '@kff/adapters';
import { agentCommandSchema, type AgentCommand, type ActionReport, type ActionState } from '@kff/contracts';

const origin = agentConfig.controller_origin;
const token = agentConfig.token;
const journalDir = path.join(runtimeDir, 'agent'); mkdirSync(journalDir, { recursive: true });
const lockFile = path.join(journalDir, 'process.lock');
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  let live = false;
  if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); live = true; } catch { /* A missing process permits recovery of this project-owned lock. */ } }
  requireCondition(!live, 'RESOURCE_BUSY', '本地 Agent 已有执行进程'); unlinkSync(lockFile);
}
const lockHandle = openSync(lockFile, 'wx'); writeFileSync(lockHandle, String(process.pid));
process.on('exit', () => { closeSync(lockHandle); if (existsSync(lockFile) && readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile); });

interface JournalEntry { command_id: string; action_id: string; phase: string; report?: ActionReport; acknowledged?: boolean; quarantined?: boolean; quiesced?: boolean }
const journalFile = path.join(journalDir, 'journal.json');
const journal: Record<string, JournalEntry> = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {};
function saveJournal() { writeFileSync(journalFile + '.tmp', JSON.stringify(journal), { mode: 0o600 }); renameSync(journalFile + '.tmp', journalFile); }
async function api<T>(endpoint: string, data: unknown = {}): Promise<T> {
  const response = await fetch(origin + '/api/agent/' + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(7000), redirect: 'error' });
  const body = await response.json();
  if (!response.ok) throw new AppError(body.error?.code ?? 'AGENT_API_ERROR', '控制端暂时无法接受操作', response.status);
  return body as T;
}
let stopping = false; let context: BrowserContext | null = null;
const stop = () => { stopping = true; void context?.close(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

async function flushJournal() {
  for (const entry of Object.values(journal).filter(value => !value.quiesced)) {
    try {
      if (entry.acknowledged || entry.quarantined) {
        await api('commands/' + entry.command_id + '/quiescence'); entry.quiesced = true; saveJournal(); continue;
      }
      if (!entry.report) {
        const status = await api<{ state: string; action_state: ActionState }>('commands/' + entry.command_id + '/status');
        if (!['READY', 'CLAIMED'].includes(status.state)) { entry.quarantined = true; saveJournal(); continue; }
        entry.report = { event_id: randomUUID(), command_id: entry.command_id, outcome: ['SUBMITTING', 'SUBMITTED'].includes(status.action_state) ? 'UNKNOWN_OUTCOME' : 'NEEDS_HUMAN', error_code: 'AGENT_RESTART', diagnostic: { step: 'restart-recovery' } };
        saveJournal();
      }
      await api('action-reports', entry.report); entry.acknowledged = true; saveJournal();
      await api('commands/' + entry.command_id + '/quiescence'); entry.quiesced = true; saveJournal();
    } catch (error) {
      if (error instanceof AppError && ['LEASE_STALE', 'VERSION_CONFLICT'].includes(error.code)) { entry.quarantined = true; saveJournal(); }
      else throw error;
    }
  }
}
async function runCommand(command: AgentCommand) {
  requireCondition(!journal[command.id], 'SUBMISSION_UNCERTAIN', '已接收过此命令，不能再次执行');
  journal[command.id] = { command_id: command.id, action_id: command.action_id, phase: 'claimed' }; saveJournal();
  let lastControl = performance.now(); let controlled = true; let controlCode = 'LEASE_STALE'; let heartbeatBusy = false;
  const assertControlled = () => { requireCondition(!stopping && controlled && performance.now() - lastControl < 20000, stopping ? 'STOP_REQUESTED' : controlCode, '执行控制权已停止'); };
  const timer = setInterval(async () => {
    if (heartbeatBusy) return; heartbeatBusy = true;
    try {
      const reply = await api<{ continue: boolean }>('heartbeats', { command_id: command.id, protocol_version: 'kff.agent.v1' });
      lastControl = performance.now();
      if (!reply.continue) { controlled = false; controlCode = 'STOP_REQUESTED'; await context?.close(); }
    } catch { if (performance.now() - lastControl >= 15000) { controlled = false; await context?.close(); } }
    finally { heartbeatBusy = false; }
  }, 4000);
  let result: Omit<ActionReport, 'event_id' | 'command_id'>;
  const beforeSubmit = async () => {
    assertControlled(); journal[command.id].phase = 'intent_requested'; saveJournal();
    await api('commands/' + command.id + '/submit');
    journal[command.id].phase = 'submitting'; saveJournal(); assertControlled();
  };
  try {
    if (command.snapshot.is_synthetic) result = await executeFixture(command, path.join(runtimeDir, 'profiles'), { beforeSubmit, assertControlled, onContext: value => { context = value; } });
    else {
      requireCondition(process.env.KFF_ENABLE_LIVE === 'true', 'LIVE_DISABLED', '真实执行未启用');
      requireCondition(command.snapshot.implementation_digest === adapterImplementationDigest(path.dirname(runtimeDir), 'facebook'), 'VERSION_CONFLICT', '本机适配器与已审核实现不匹配');
      requireCondition(command.snapshot.credential_ref, 'AUTH_EXPIRED', '任务缺少已审核的凭据引用');
      const credential = process.env[command.snapshot.credential_ref];
      requireCondition(credential && process.env.KFF_FACEBOOK_GRAPH_VERSION, 'AUTH_EXPIRED', 'Facebook 凭据和版本尚未配置');
      const adapter = new FacebookPageAdapter({ version: process.env.KFF_FACEBOOK_GRAPH_VERSION, pageToken: credential });
      const receipt = await adapter.execute(command.snapshot, beforeSubmit);
      result = { outcome: 'VERIFIED_SUCCEEDED', receipt, diagnostic: { step: 'graph-verified' } };
    }
  } catch (error) { result = { outcome: 'BLOCKED', error_code: error instanceof AppError ? error.code : 'EXECUTOR_ERROR', diagnostic: { step: 'executor-failed' } }; }
  finally { clearInterval(timer); await context?.close(); context = null; }
  try {
    const status = await api<{ action_state: ActionState }>('commands/' + command.id + '/status');
    if (['SUBMITTING', 'SUBMITTED'].includes(status.action_state) && result.outcome !== 'VERIFIED_SUCCEEDED') result.outcome = 'UNKNOWN_OUTCOME';
    if (status.action_state === 'PREPARING' && controlCode === 'STOP_REQUESTED' && !controlled) { result.outcome = 'CANCELED'; result.error_code = 'STOP_REQUESTED'; }
    journal[command.id].report = { ...result, event_id: randomUUID(), command_id: command.id }; journal[command.id].phase = 'reported'; saveJournal();
  } catch { /* Persisted intent will be reconciled after the connection recovers. */ }
  await flushJournal();
}

console.log('KFF Agent started with persistent journal and one execution slot');
while (!stopping) {
  try {
    await api('heartbeats', { protocol_version: 'kff.agent.v1' });
    await flushJournal();
    const { command: raw } = await api<{ command: unknown }>('claims');
    if (raw) {
      const command = agentCommandSchema.parse(raw);
      requireCondition(command.agent_id === agentConfig.agent_id && command.organization_id === agentConfig.organization_id && command.brand_id === agentConfig.brand_id && command.snapshot.agent_id === agentConfig.agent_id, 'FORBIDDEN_SCOPE', '命令不属于本机配对范围');
      requireCondition(digest(command.snapshot) === command.snapshot_hash && digest(command.snapshot.body) === command.snapshot.content_hash, 'APPROVAL_STALE', '任务快照校验失败');
      requireCondition(Date.parse(command.expires_at) > Date.now(), 'LEASE_STALE', '命令已过期');
      for (const [type, resource] of [['account', command.snapshot.account_id], ['environment', command.snapshot.environment_id]]) requireCondition(command.leases.filter(lease => lease.resource_type === type && lease.resource_id === resource).length === 1, 'LEASE_STALE', '资源租约与快照不符');
      await runCommand(command);
    }
  } catch (error) { console.error('Agent waiting:', error instanceof AppError ? error.code : 'CONTROL_UNAVAILABLE'); }
  await delay(1000);
}
