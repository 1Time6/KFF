import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { agentConfig, runtimeDir } from './config';
import { AppError, digest, requireCondition } from '@kff/core';
import { agentCommandSchema, type AgentCommand, type ActionReport, type ActionState } from '@kff/contracts';
import { runGuardian } from './guardian';
import { readClosure, closureProof } from './guardian-protocol';

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

interface JournalEntry { command_id: string; action_id: string; phase: string; guardian_nonce?: string; guardian_pid?: number; report?: ActionReport; acknowledged?: boolean; quarantined?: boolean; quiesced?: boolean }
const journalFile = path.join(journalDir, 'journal.json');
const journal: Record<string, JournalEntry> = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {};
function saveJournal() { writeFileSync(journalFile + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(journalFile + '.tmp', journalFile); }
async function api<T>(endpoint: string, data: unknown = {}): Promise<T> {
  const response = await fetch(origin + '/api/agent/' + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(7000), redirect: 'error' });
  const body = await response.json();
  if (!response.ok) throw new AppError(body.error?.code ?? 'AGENT_API_ERROR', '控制端暂时无法接受操作', response.status);
  return body as T;
}
let stopping = false; let executionControl: AbortController | null = null;
const stop = () => { stopping = true; executionControl?.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

async function flushJournal() {
  for (const entry of Object.values(journal).filter(value => !value.quiesced)) {
    const closure = readClosure(runtimeDir, entry);
    // A dead PID or a restarted parent is never treated as evidence that its browser closed.
    if (!closure) return false;
    try {
      if (entry.acknowledged || entry.quarantined) {
        await api('commands/' + entry.command_id + '/quiescence', closureProof(closure)); entry.quiesced = true; saveJournal(); continue;
      }
      if (!entry.report) {
        const status = await api<{ state: string; action_state: ActionState }>('commands/' + entry.command_id + '/status');
        if (!['READY', 'CLAIMED'].includes(status.state)) { entry.quarantined = true; saveJournal(); continue; }
        const result = { ...closure.result };
        if (['SUBMITTING', 'SUBMITTED'].includes(status.action_state) && result.outcome !== 'VERIFIED_SUCCEEDED') result.outcome = 'UNKNOWN_OUTCOME';
        entry.report = { ...result, event_id: randomUUID(), command_id: entry.command_id };
        saveJournal();
      }
      await api('action-reports', entry.report); entry.acknowledged = true; saveJournal();
      await api('commands/' + entry.command_id + '/quiescence', closureProof(closure)); entry.quiesced = true; saveJournal();
    } catch (error) {
      if (error instanceof AppError && ['LEASE_STALE', 'VERSION_CONFLICT'].includes(error.code)) { entry.quarantined = true; saveJournal(); }
      else throw error;
    }
  }
  return Object.values(journal).every(entry => entry.quiesced);
}
async function runCommand(command: AgentCommand) {
  requireCondition(!journal[command.id], 'SUBMISSION_UNCERTAIN', '已接收过此命令，不能再次执行');
  const nonce = randomBytes(32).toString('hex');
  journal[command.id] = { command_id: command.id, action_id: command.action_id, phase: 'claimed', guardian_nonce: nonce }; saveJournal();
  const control = new AbortController(); executionControl = control;
  let lastControl = performance.now(); let controlled = true; let controlCode = 'LEASE_STALE'; let heartbeatBusy = false;
  const assertControlled = () => { requireCondition(!stopping && controlled && performance.now() - lastControl < 20000, stopping ? 'STOP_REQUESTED' : controlCode, '执行控制权已停止'); };
  const timer = setInterval(async () => {
    if (heartbeatBusy) return; heartbeatBusy = true;
    try {
      const reply = await api<{ continue: boolean }>('heartbeats', { command_id: command.id, protocol_version: 'kff.agent.v1' });
      lastControl = performance.now();
      if (!reply.continue) { controlled = false; controlCode = 'STOP_REQUESTED'; control.abort(); }
    } catch (error) {
      if ((error instanceof AppError && [401, 403].includes(error.status)) || performance.now() - lastControl >= 15000) { controlled = false; controlCode = 'LEASE_STALE'; control.abort(); }
    }
    finally { heartbeatBusy = false; }
  }, 4000);
  const beforeSubmit = async () => {
    assertControlled(); journal[command.id].phase = 'intent_requested'; saveJournal();
    await api('commands/' + command.id + '/submit');
    journal[command.id].phase = 'submitting'; saveJournal(); assertControlled();
  };
  try {
    await runGuardian(command, runtimeDir, nonce, { beforeSubmit, signal: control.signal, onSpawn: pid => { journal[command.id].guardian_pid = pid; saveJournal(); }, onContextOpened: () => { journal[command.id].phase = 'context_open'; saveJournal(); } });
  } finally { clearInterval(timer); executionControl = null; }
  await flushJournal();
}

console.log('KFF Agent started with persistent journal and one execution slot');
while (!stopping) {
  try {
    await api('heartbeats', { protocol_version: 'kff.agent.v1' });
    requireCondition(await flushJournal(), 'GUARDIAN_UNCONFIRMED', '旧执行上下文尚未取得关闭证明，暂停接单');
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
