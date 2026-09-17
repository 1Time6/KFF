import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resultInput, uuid, hashSchema, quiescenceInput } from '@kff/contracts';
import { digest, requireCondition, AppError } from '@kff/core';

export const guardianResult = resultInput.omit({ event_id: true, command_id: true });
export const closureSchema = z.object({
  protocol_version: z.literal('kff.guardian-closure.v1'), command_id: uuid, action_id: uuid,
  nonce: hashSchema, closed_at: z.string().datetime(), context_closed: z.literal(true), result: guardianResult,
}).strict();
export type GuardianClosure = z.infer<typeof closureSchema>;
const compactClosureSchema = closureSchema.omit({ protocol_version: true, result: true }).extend({
  protocol_version: z.literal('kff.guardian-closure-compact.v1'),
  proof_sha256: hashSchema, result_sha256: hashSchema, page_sha256: hashSchema.optional(),
  compacted_at: z.string().datetime(), reason: z.enum(['DELIVERED', 'RETENTION_EXPIRED']),
}).strict();
type CompactClosure = z.infer<typeof compactClosureSchema>;
/**
 * The child exited before it ever received `start`. `ready` is what makes the parent send `start`,
 * and only `start` reaches the executor, so at that point no browser context exists and no
 * submission can have been requested. The parent records that fact itself, with its own protocol
 * version: it deliberately carries no `context_closed: true`, which stays reserved for a proof the
 * child wrote after closing what it actually opened. A child that died after `start` is a different
 * case and still keeps its isolation.
 */
const startupFailureSchema = z.object({
  protocol_version: z.literal('kff.guardian-closure-startup-failed.v1'),
  command_id: uuid, action_id: uuid, nonce: hashSchema, closed_at: z.string().datetime(),
  context_opened: z.literal(false),
  result: guardianResult,
}).strict();
type StartupFailure = z.infer<typeof startupFailureSchema>;
export type ClosureEvidence = GuardianClosure | CompactClosure | StartupFailure;
export interface ClosureIdentity { command_id: string; action_id: string; guardian_nonce?: string }
export function closureFile(runtime: string, commandId: string) {
  return path.join(runtime, 'agent', 'closures', uuid.parse(commandId) + '.json');
}
export function saveClosure(runtime: string, value: GuardianClosure) {
  const record = closureSchema.parse(value); const file = closureFile(runtime, record.command_id);
  mkdirSync(path.dirname(file), { recursive: true });
  requireCondition(!existsSync(file), 'IDEMPOTENCY_CONFLICT', '关闭证明已经存在');
  writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file);
}
/**
 * Written only by the parent, only while the journal phase still proves the child never executed.
 * A child that had already been sent `start` may own a browser context, so it is never recorded
 * here and the caller keeps its isolation.
 */
export function saveStartupFailure(runtime: string, value: { command_id: string; action_id: string; nonce: string; result: z.infer<typeof guardianResult>; closed_at?: string }) {
  const record = startupFailureSchema.parse({ protocol_version: 'kff.guardian-closure-startup-failed.v1', closed_at: value.closed_at ?? new Date().toISOString(), command_id: value.command_id, action_id: value.action_id, nonce: value.nonce, context_opened: false, result: value.result });
  const file = closureFile(runtime, record.command_id);
  mkdirSync(path.dirname(file), { recursive: true });
  requireCondition(!existsSync(file), 'IDEMPOTENCY_CONFLICT', '关闭证明已经存在');
  writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file);
  return record;
}
export function readClosureEvidence(runtime: string, entry: ClosureIdentity): ClosureEvidence | null {
  if (!entry.guardian_nonce) return null;
  const file = closureFile(runtime, entry.command_id); if (!existsSync(file)) return null;
  const parsed = z.union([closureSchema, compactClosureSchema, startupFailureSchema]).safeParse(JSON.parse(readFileSync(file, 'utf8')));
  requireCondition(parsed.success && parsed.data.command_id === entry.command_id && parsed.data.action_id === entry.action_id && parsed.data.nonce === entry.guardian_nonce, 'GUARDIAN_UNCONFIRMED', '旧执行上下文关闭证明不匹配');
  return parsed.data;
}
export function readClosure(runtime: string, entry: ClosureIdentity): GuardianClosure | null {
  const record = readClosureEvidence(runtime, entry);
  if (!record) return null;
  // A startup failure answers "did anything execute", not "is the browser closed". It carries no
  // `context_closed: true` and never claims to be a normal closure; callers that need the terminal
  // result read `readClosureEvidence` directly, while a caller that needs an actually closed context
  // keeps its isolation.
  if (record.protocol_version === 'kff.guardian-closure-startup-failed.v1') throw new AppError('GUARDIAN_STARTUP_FAILED', '执行进程在启动阶段退出，没有浏览器上下文可以关闭', 409);
  requireCondition(record.protocol_version === 'kff.guardian-closure.v1', 'GUARDIAN_UNCONFIRMED', '原始回执已经清理，不能重新执行或恢复原文');
  return record;
}
export function closureProof(record: ClosureEvidence): z.infer<typeof quiescenceInput> {
  return { protocol_version: 'kff.guardian-closure.v1', command_id: record.command_id, action_id: record.action_id, closed_at: record.closed_at, proof_sha256: 'proof_sha256' in record ? record.proof_sha256 : digest(record) };
}
export function compactClosure(runtime: string, entry: ClosureIdentity, reason: CompactClosure['reason'], now = Date.now()) {
  const record = readClosureEvidence(runtime, entry);
  const file = closureFile(runtime, entry.command_id);
  if (!record || record.protocol_version === 'kff.guardian-closure-compact.v1') {
    // A crash can leave an unrenamed raw file. Removing it is never promoted to closure evidence.
    if (existsSync(file + '.tmp')) unlinkSync(file + '.tmp');
    return record;
  }
  const compact = compactClosureSchema.parse({ protocol_version: 'kff.guardian-closure-compact.v1', command_id: record.command_id, action_id: record.action_id, nonce: record.nonce, closed_at: record.closed_at, context_closed: true,
    proof_sha256: digest(record), result_sha256: digest(record.result), page_sha256: (record.result.collection_page || record.result.inbox_page) ? digest(record.result.collection_page ?? record.result.inbox_page) : undefined, compacted_at: new Date(now).toISOString(), reason });
  writeFileSync(file + '.tmp', JSON.stringify(compact), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file);
  return compact;
}
