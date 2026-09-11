import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resultInput, uuid, hashSchema, quiescenceInput } from '@kff/contracts';
import { digest, requireCondition } from '@kff/core';

export const guardianResult = resultInput.omit({ event_id: true, command_id: true });
export const closureSchema = z.object({
  protocol_version: z.literal('kff.guardian-closure.v1'), command_id: uuid, action_id: uuid,
  nonce: hashSchema, closed_at: z.string().datetime(), context_closed: z.literal(true), result: guardianResult,
}).strict();
export type GuardianClosure = z.infer<typeof closureSchema>;
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
export function readClosure(runtime: string, entry: ClosureIdentity): GuardianClosure | null {
  if (!entry.guardian_nonce) return null;
  const file = closureFile(runtime, entry.command_id); if (!existsSync(file)) return null;
  const parsed = closureSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  requireCondition(parsed.success && parsed.data.command_id === entry.command_id && parsed.data.action_id === entry.action_id && parsed.data.nonce === entry.guardian_nonce, 'GUARDIAN_UNCONFIRMED', '旧执行上下文关闭证明不匹配');
  return parsed.data;
}
export function closureProof(record: GuardianClosure): z.infer<typeof quiescenceInput> {
  return { protocol_version: record.protocol_version, command_id: record.command_id, action_id: record.action_id, closed_at: record.closed_at, proof_sha256: digest(record) };
}
