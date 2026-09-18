import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, linkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resultInput, uuid, hashSchema, quiescenceInput, guardianTermination, guardianTimingLimits } from '@kff/contracts';
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
 *
 * `termination` is optional because a startup failure usually needs no termination at all - the
 * process is already gone. When the parent did have to end something, the fact it proved travels with
 * the record instead of being dropped, so a reader can tell "never opened" from "never opened, and the
 * process is provably gone" without having to infer it.
 */
export const startupFailedProtocolVersion = 'kff.guardian-closure-startup-failed.v1';
const startupFailureSchema = z.object({
  protocol_version: z.literal(startupFailedProtocolVersion),
  command_id: uuid, action_id: uuid, nonce: hashSchema, closed_at: z.string().datetime(),
  context_opened: z.literal(false),
  termination: guardianTermination.optional(),
  result: guardianResult,
}).strict();
type StartupFailure = z.infer<typeof startupFailureSchema>;
/**
 * The child was alive but stopped making progress, so the parent ended it. That proves exactly one
 * thing - the process is gone - and the record says so and nothing more. The two remaining questions
 * are answered separately because their answers differ: `context_opened` is only what the parent
 * observed before it stopped waiting, and `submission_state` says whether a platform write could have
 * been reached. `context_closed` is deliberately absent: ending a process never closes a context.
 *
 * The old shape carried `process_terminated: boolean`, and that boolean was the defect: it could be
 * set from a probe that only ever asked about the root pid, so a live browser could be recorded as a
 * terminated tree. `termination` replaces it with the three-state fact and the evidence behind it -
 * root, descendants, how many were sampled, and whether the listing was available at all. A record
 * that cannot prove the tree is dead is still written (the truth is worth keeping), but it is no
 * longer usable as a proof: the receiver refuses it, and the environment stays quarantined.
 */
export const noProgressProtocolVersion = 'kff.guardian-closure-no-progress.v1';
export const guardianLivenessPhases = ['awaiting-ready', 'awaiting-start', 'awaiting-context', 'awaiting-intent', 'granting', 'submitting'] as const;
export type GuardianLivenessPhase = typeof guardianLivenessPhases[number];
const noProgressSchema = z.object({
  protocol_version: z.literal(noProgressProtocolVersion),
  command_id: uuid, action_id: uuid, nonce: hashSchema, closed_at: z.string().datetime(),
  phase: z.enum(guardianLivenessPhases),
  termination: guardianTermination,
  context_opened: z.boolean(),
  submission_state: z.enum(['NOT_SUBMITTED', 'UNKNOWN']),
  forced: z.boolean(),
  // Both durations are measured, not configured, so their ceiling is the largest wait any legal policy
  // can accumulate - the same shared bound the policy itself is validated against. Keeping the two in
  // step is what stops a legal policy from producing evidence the schema would then reject and lose.
  waited_ms: z.number().int().min(0).max(guardianTimingLimits.max_total_ms),
  grace_ms: z.number().int().min(0).max(guardianTimingLimits.max_total_ms),
  result: guardianResult,
}).strict();
type NoProgress = z.infer<typeof noProgressSchema>;
export type ClosureEvidence = GuardianClosure | CompactClosure | StartupFailure | NoProgress;
export interface ClosureIdentity { command_id: string; action_id: string; guardian_nonce?: string }

/**
 * How much a record actually proves, in the only order that matters: whether a browser context is
 * known to be closed, known never to have opened, or merely unaccounted for behind a dead process.
 * The rank is what the write rules below compare, and it is deliberately not the same thing as
 * "a file exists".
 */
export const closureRanks: Record<'PROVEN_CLOSED' | 'NEVER_OPENED' | 'PROCESS_ONLY', number> = { PROVEN_CLOSED: 3, NEVER_OPENED: 2, PROCESS_ONLY: 1 };
export type ClosureStrength = keyof typeof closureRanks;
export function closureStrength(record: ClosureEvidence): ClosureStrength {
  if (record.protocol_version === 'kff.guardian-closure.v1' || record.protocol_version === 'kff.guardian-closure-compact.v1') return 'PROVEN_CLOSED';
  return record.protocol_version === startupFailedProtocolVersion ? 'NEVER_OPENED' : 'PROCESS_ONLY';
}

export function closureFile(runtime: string, commandId: string) {
  return path.join(runtime, 'agent', 'closures', uuid.parse(commandId) + '.json');
}
/**
 * Each kind of evidence writes through its own temporary file. The previous version had all of them
 * share `<file>.tmp`, which is a race with real consequences: the child writing its closure and the
 * parent writing a no-progress record for the same command could interleave inside one temporary file,
 * and whichever renamed second would publish a mixture of the two. Separate names make that
 * impossible, and they cost nothing because only the renamed file is ever read.
 */
const tmpSuffixes = { closure: '.closure.tmp', startup: '.startup-failed.tmp', noProgress: '.no-progress.tmp', compact: '.compact.tmp' } as const;
type EvidenceKind = keyof typeof tmpSuffixes;
/**
 * Windows can refuse a metadata operation for a moment while something else - a scanner, an indexer, or
 * the other writer touching the same directory - holds the file it is about to touch. That refusal says
 * nothing about the evidence, and reading it as a decision is how a proven closure loses to a weak
 * record: the writer that was told "not now" gives up, and the weaker fact that got its write in first
 * is what stays. `saveRuntimeJson` already answers this the same way for the runtime state file; this is
 * that answer, bounded by a deadline so a filesystem that really refuses still ends in an error rather
 * than in a success that did not happen. Only Windows is retried: on POSIX these codes mean what they say.
 */
const transientFileCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);
function withTransientRetry<T>(budgetMs: number, body: () => T): T {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { return body(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !transientFileCodes.has(code ?? '') || Date.now() >= deadline) throw error;
      // Wait without spinning the event loop: this runs inside the child's final write, where holding
      // the thread for a moment is cheaper than losing the proof.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, deadline - Date.now()));
    }
  }
}
/**
 * Cleanup, never a decision. When this runs on a published record the fact is already on disk, and on a
 * lost race there is nothing to publish - so a cleanup that fails must not throw. It would otherwise
 * replace the caller's "somebody else published first, retry against what is there" with a failure and
 * abandon retries that were still available. A temporary file that survives is harmless: the next
 * writer of the same kind removes its own before publishing.
 */
function removeTemp(tmp: string) {
  try { withTransientRetry(250, () => { if (existsSync(tmp)) unlinkSync(tmp); }); } catch { /* left for the next writer of this kind */ }
}
/**
 * Publishes one record. `exclusive` is for the case where the caller decided to write *because* nothing
 * was there: a hard link is created instead of a rename, so the write either creates the file or fails
 * because somebody else published in the meantime. A rename cannot make that distinction - it replaces
 * whatever it finds - which is how a parent that checked "no closure yet" a few microseconds earlier
 * could still land on top of the real closure the child had just written. Both processes write the same
 * proof file, so the decision and the write have to be one step; when they are not, the loser of the
 * race re-reads and applies the strength rules again. A filesystem without hard links falls back to the
 * rename, which is the previous behaviour rather than a failure to record anything.
 */
function writeEvidenceFile(file: string, kind: EvidenceKind, record: ClosureEvidence, exclusive = false): boolean {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + tmpSuffixes[kind];
  // A crash between writing and renaming leaves this writer's own temporary file behind. Only the
  // writer that owns the name removes it, so cleanup can never delete a concurrent writer's work.
  removeTemp(tmp);
  withTransientRetry(500, () => writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flush: true }));
  if (!exclusive) { withTransientRetry(500, () => renameSync(tmp, file)); removeTemp(tmp); return true; }
  try {
    withTransientRetry(500, () => linkSync(tmp, file));
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') { withTransientRetry(500, () => renameSync(tmp, file)); return true; }
    return false;
  } finally {
    // On success the record now has two names and only the temporary one is dropped; on a lost race the
    // temporary file is discarded so no half-written evidence is left behind.
    removeTemp(tmp);
  }
}
/** Everything except the write timestamp, which is the one field a legitimate retry is allowed to change. */
function substance(record: ClosureEvidence) {
  const { closed_at: _ignored, ...rest } = record as ClosureEvidence & { closed_at: string };
  return JSON.stringify(rest);
}
/**
 * The one write rule every producer goes through. It answers two questions the previous code answered
 * with a bare existence check:
 *
 *  - may this record replace what is already on disk? Only a stronger fact may replace a weaker one.
 *    A real closure upgrades a no-progress record - that is the whole point of keeping the weak record
 *    around - while a no-progress record can never overwrite a closure that is already proven. Equal
 *    ranks never replace each other; a replayed write of the same facts returns what is on disk, so a
 *    retry is idempotent rather than a conflict, and a *different* write at the same rank is a genuine
 *    conflict and is refused loudly.
 *  - what does the caller get back? Always the record that is now on disk, which may be the existing
 *    stronger one rather than the one it asked to write.
 */
function saveEvidence(runtime: string, kind: EvidenceKind, record: ClosureEvidence): ClosureEvidence {
  const file = closureFile(runtime, record.command_id);
  // A record can be published by the other writer between the comparison and the write, so a caller
  // that decided to write because nothing was there retries against what it actually finds. What the
  // retry cannot do is overwrite a fact it never read: the exclusive create simply fails, which is the
  // only outcome that keeps a weak writer from replacing a strong record it did not see.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const present = existsSync(file);
    if (!present) {
      if (writeEvidenceFile(file, kind, record, true)) return record;
      continue;
    }
    const parsed = parseEvidenceFile(file);
    const existing = parsed.success ? parsed.data : null;
    requireCondition(existing && existing.command_id === record.command_id, 'GUARDIAN_UNCONFIRMED', '既有执行上下文证明无法解析，拒绝覆盖');
    requireCondition(existing.action_id === record.action_id && existing.nonce === record.nonce, 'IDEMPOTENCY_CONFLICT', '关闭证明属于另一个执行上下文');
    // Replacing a record that is already there is a deliberate act and always a stronger fact. Two
    // writers of the same or higher strength may still replace each other here - the platform offers no
    // compare-and-swap to prevent it - but neither of them can be a weaker record, and a weaker writer
    // never reaches this line at all.
    if (closureRanks[closureStrength(record)] > closureRanks[closureStrength(existing)]) { writeEvidenceFile(file, kind, record); return record; }
    requireCondition(substance(existing) === substance(record), 'IDEMPOTENCY_CONFLICT', '关闭证明已经存在且内容不同');
    return existing;
  }
  throw new AppError('IDEMPOTENCY_CONFLICT', '关闭证明写入竞争次数过多，拒绝覆盖', 409);
}
function parseEvidenceFile(file: string) {
  // A file that cannot be parsed is never treated as absent: silence about a closure proof is the same
  // fact as a bad one, and both keep the caller's isolation.
  try { return z.union([closureSchema, compactClosureSchema, startupFailureSchema, noProgressSchema]).safeParse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return { success: false as const }; }
}
export function saveClosure(runtime: string, value: GuardianClosure): ClosureEvidence {
  return saveEvidence(runtime, 'closure', closureSchema.parse(value));
}
/**
 * Written only by the parent, only while the journal phase still proves the child never executed.
 * A child that had already been sent `start` may own a browser context, so it is never recorded
 * here and the caller keeps its isolation.
 */
export function saveStartupFailure(runtime: string, value: { command_id: string; action_id: string; nonce: string; result: z.infer<typeof guardianResult>; termination?: z.infer<typeof guardianTermination>; closed_at?: string }) {
  const record = startupFailureSchema.parse({ protocol_version: 'kff.guardian-closure-startup-failed.v1', closed_at: value.closed_at ?? new Date().toISOString(), command_id: value.command_id, action_id: value.action_id, nonce: value.nonce, context_opened: false, termination: value.termination, result: value.result });
  return saveEvidence(runtime, 'startup', record) as StartupFailure;
}
export function readClosureEvidence(runtime: string, entry: ClosureIdentity): ClosureEvidence | null {
  if (!entry.guardian_nonce) return null;
  const file = closureFile(runtime, entry.command_id); if (!existsSync(file)) return null;
  const parsed = parseEvidenceFile(file);
  requireCondition(parsed.success && parsed.data.command_id === entry.command_id && parsed.data.action_id === entry.action_id && parsed.data.nonce === entry.guardian_nonce, 'GUARDIAN_UNCONFIRMED', '旧执行上下文关闭证明不匹配');
  return parsed.data;
}
/**
 * Written only by the parent, only for a child it had to end itself. It is never a normal closure:
 * `readClosure` refuses it exactly as it refuses a startup failure, because "the process is gone" is
 * not "the context is closed". Callers that need the terminal result read `readClosureEvidence`.
 *
 * The termination fact is required, and required to be a real one: a caller cannot record "the
 * process was terminated" without saying what that judgement rests on. A tree that is still `ALIVE`,
 * or one no listing could be obtained for, is written down as exactly that - the record stays honest
 * and the release decision is left to the receiver, which refuses it.
 */
export function saveNoProgress(runtime: string, value: { command_id: string; action_id: string; nonce: string; phase: GuardianLivenessPhase; termination: z.infer<typeof guardianTermination>; context_opened: boolean; submission_state: 'NOT_SUBMITTED' | 'UNKNOWN'; forced: boolean; waited_ms: number; grace_ms: number; result: z.infer<typeof guardianResult>; closed_at?: string }) {
  const record = noProgressSchema.parse({ protocol_version: 'kff.guardian-closure-no-progress.v1', closed_at: value.closed_at ?? new Date().toISOString(), command_id: value.command_id, action_id: value.action_id, nonce: value.nonce, phase: value.phase, termination: value.termination, context_opened: value.context_opened, submission_state: value.submission_state, forced: value.forced, waited_ms: value.waited_ms, grace_ms: value.grace_ms, result: value.result });
  return saveEvidence(runtime, 'noProgress', record) as NoProgress;
}
export function readClosure(runtime: string, entry: ClosureIdentity): GuardianClosure | null {
  const record = readClosureEvidence(runtime, entry);
  if (!record) return null;
  // A startup failure answers "did anything execute", not "is the browser closed". It carries no
  // `context_closed: true` and never claims to be a normal closure; callers that need the terminal
  // result read `readClosureEvidence` directly, while a caller that needs an actually closed context
  // keeps its isolation.
  if (record.protocol_version === startupFailedProtocolVersion) throw new AppError('GUARDIAN_STARTUP_FAILED', '执行进程在启动阶段退出，没有浏览器上下文可以关闭', 409);
  requireCondition(record.protocol_version === 'kff.guardian-closure.v1', 'GUARDIAN_UNCONFIRMED', '原始回执已经清理，不能重新执行或恢复原文');
  return record;
}
export function closureProof(record: ClosureEvidence): z.infer<typeof quiescenceInput> {
  // The proof keeps the fact it was derived from. A startup failure and a no-progress termination
  // both never claim a closed context, so each travels under its own version and the receiver can
  // tell all three apart. A normal and a compacted record both keep the original version, which
  // leaves every proof already on record byte-identical.
  const version = record.protocol_version === 'kff.guardian-closure-compact.v1' ? 'kff.guardian-closure.v1' : record.protocol_version;
  const base = { command_id: record.command_id, action_id: record.action_id, closed_at: record.closed_at, proof_sha256: 'proof_sha256' in record ? record.proof_sha256 : digest(record) };
  if (version === noProgressProtocolVersion) return { protocol_version: version, ...base, process_tree: (record as NoProgress).termination.process_tree };
  if (version === startupFailedProtocolVersion) {
    const termination = (record as StartupFailure).termination;
    return termination ? { protocol_version: version, ...base, process_tree: termination.process_tree } : { protocol_version: version, ...base };
  }
  return { protocol_version: version, ...base };
}
export function compactClosure(runtime: string, entry: ClosureIdentity, reason: CompactClosure['reason'], now = Date.now()) {
  const record = readClosureEvidence(runtime, entry);
  const file = closureFile(runtime, entry.command_id);
  // Compaction only ever shrinks a normal closure: it drops the bulky page result and keeps a digest.
  // A record that is already compact and a startup-failed record - which holds no page result at all -
  // both leave this function untouched, so "a context was never opened" can never be rewritten into
  // the `context_closed: true` that the compact schema carries.
  if (!record || record.protocol_version !== 'kff.guardian-closure.v1') {
    // A crash can leave an unrenamed raw file. Only the closure writer's own temporary names are swept
    // - the plain `.tmp` a pre-split version used, and the name the child writes today - because the
    // other kinds belong to writers that may still be running; nothing here is ever promoted to
    // closure evidence.
    for (const stale of [file + '.tmp', file + tmpSuffixes.closure]) if (existsSync(stale)) unlinkSync(stale);
    return record;
  }
  const compact = compactClosureSchema.parse({ protocol_version: 'kff.guardian-closure-compact.v1', command_id: record.command_id, action_id: record.action_id, nonce: record.nonce, closed_at: record.closed_at, context_closed: true,
    proof_sha256: digest(record), result_sha256: digest(record.result), page_sha256: (record.result.collection_page || record.result.inbox_page) ? digest(record.result.collection_page ?? record.result.inbox_page) : undefined, compacted_at: new Date(now).toISOString(), reason });
  writeEvidenceFile(file, 'compact', compact);
  return compact;
}
