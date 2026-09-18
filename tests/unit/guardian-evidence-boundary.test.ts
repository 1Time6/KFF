import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { readClosure, readClosureEvidence, saveClosure, saveNoProgress, saveStartupFailure } from '../../apps/agent/src/guardian-protocol';
import { fixtureCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

/**
 * NEW-B012-02: what a failing cleanup is allowed to change.
 *
 * `writeEvidenceFile` removes a temporary file twice - once before it writes, to clear its own crash
 * leftover, and again in a `finally` after the exclusive create. Both are cleanup, and the rule the
 * batch has to be able to defend is that neither one decides anything: a cleanup that fails must not
 * replace the caller's verdict, must not cost it a retry that was still available, and must not destroy
 * a proof that was already published.
 *
 * Why this file exists rather than more repetitions of the happy path. The interesting branch is the one
 * where cleanup *fails*, and on a healthy filesystem it never runs, so sixteen green runs say nothing
 * about it - they are sixteen observations of the branch not being taken. The faults below are injected
 * instead, and each one is a state a real machine reaches: a temporary file that is suddenly not a file
 * any more, left by a crashed writer or by anything else that put a directory at that name.
 *
 * The three properties are checked separately and none of them is assumed. Where a property does not
 * hold, the test says so rather than being written around it.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-boundary-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const nonce = () => randomBytes(32).toString('hex');
type Entry = { command_id: string; action_id: string; nonce: string };
const identity = (command: AgentCommand, value: string): Entry => ({ command_id: command.id, action_id: command.action_id, nonce: value });
const ref = (entry: Entry) => ({ command_id: entry.command_id, action_id: entry.action_id, guardian_nonce: entry.nonce });
function runtimeRoot(label: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-boundary-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', label);
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
const evidenceFiles = (runtime: string) => readdirSync(path.join(runtime, 'agent', 'closures'));
const evidenceFile = (runtime: string, commandId: string) => path.join(runtime, 'agent', 'closures', commandId + '.json');
const codeOf = (error: unknown) => (error as { code?: string }).code;
/** Runs `body` and returns the error it threw, failing the test if it did not throw at all. */
function capture(body: () => unknown): unknown {
  try { body(); } catch (error) { return error; }
  throw new Error('expected the write to fail');
}
/**
 * The failure codes are read off this platform instead of being hardcoded, because the assertion below
 * is a *comparison* between two operations and hardcoding either one would hide a platform that answers
 * differently. What is being established is which operation refused, not what Windows happens to call it.
 */
function fsFailureCode(operation: (target: string) => void): string | undefined {
  // Deliberately the same prefix as the runtimes above, so the `afterAll` guard that refuses to delete
  // anything it did not create also covers these.
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-boundary-probe-')); roots.push(root);
  const directory = path.join(root, 'occupied');
  mkdirSync(directory); writeFileSync(path.join(directory, 'member'), 'x');
  try { operation(directory); return undefined; } catch (error) { return codeOf(error); }
}
const termination = { process_tree: 'DEAD', tool: 'SUCCESS', root: 'DEAD', descendants: 'DEAD', sampled: 2, enumeration: 'LISTED', elapsed_ms: 120 } as const;
type NoProgressInput = Parameters<typeof saveNoProgress>[1];
type ClosureInput = Parameters<typeof saveClosure>[1];
const weakRecord = (entry: Entry, overrides: Partial<NoProgressInput> = {}): NoProgressInput => ({
  ...entry, phase: 'awaiting-ready', termination, context_opened: false, submission_state: 'NOT_SUBMITTED', forced: true,
  waited_ms: 1500, grace_ms: 600, result: { outcome: 'CANCELED', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } }, ...overrides,
});
const strongRecord = (entry: Entry, overrides: Partial<ClosureInput> = {}): ClosureInput => ({
  protocol_version: 'kff.guardian-closure.v1', ...entry, closed_at: new Date().toISOString(), context_closed: true,
  result: { outcome: 'BLOCKED', error_code: 'APPROVAL_STALE', diagnostic: { step: 'executor-failed' } }, ...overrides,
});
/** Puts a non-empty directory where the writer expects its temporary file: unremovable and unwritable. */
function obstruct(tmp: string) {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, 'member'), 'left behind by a writer that died');
}

/**
 * Property one and two, on the reachable fault. The stale temporary file cannot be unlinked, so the
 * pre-write `removeTemp` fails - and the write is what refuses, not the cleanup. That comparison is the
 * observable form of `removeTemp` swallowing its own failure: if it propagated, the caller would be
 * holding an unlink error instead, and execution would never have reached the write at all.
 *
 * What the caller gets is a raw filesystem error rather than a domain refusal, which is recorded as a
 * finding rather than asserted away here - the safety question and the reporting question are separate,
 * and only the safety one is settled by this test.
 */
it('refuses the write, not the cleanup, when a stale temporary file cannot be removed', () => {
  const command = fixtureCommand(); const entry = identity(command, nonce());
  const { runtime } = runtimeRoot('blocked-tmp');
  const file = evidenceFile(runtime, command.id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.closure.tmp';
  obstruct(tmp);
  const failure = capture(() => saveClosure(runtime, strongRecord(entry)));
  const writeCode = fsFailureCode(target => writeFileSync(target, 'x'));
  const unlinkCode = fsFailureCode(target => unlinkSync(target));
  // Calibrated, then compared: the two operations really do answer differently on this platform, so the
  // assertion has something to distinguish. A platform where they agree cannot support this test.
  expect(writeCode).toBeDefined();
  expect(unlinkCode).toBeDefined();
  expect(writeCode).not.toBe(unlinkCode);
  expect(codeOf(failure)).toBe(writeCode);
  expect(codeOf(failure)).not.toBe(unlinkCode);
  // Fail closed and total: no record was published. The only thing in the directory is the obstruction
  // this test placed there, which is why the assertion is about records rather than about an empty
  // directory - the obstructed temporary name is still sitting exactly where it was left.
  expect(existsSync(file)).toBe(false);
  expect(readClosureEvidence(runtime, ref(entry))).toBeNull();
  expect(evidenceFiles(runtime)).toEqual([path.basename(tmp)]);
  // Recoverable, which is the point of keeping the failure loud: the obstruction was the whole problem,
  // and once it is gone the same write publishes normally.
  rmSync(tmp, { recursive: true, force: true });
  const published = saveClosure(runtime, strongRecord(entry));
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(published);
  expect(readClosure(runtime, ref(entry))).toEqual(published);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
}, 30000);

/**
 * Property three, and the one that would actually cost something. A proof is already on disk; every
 * later writer is then made to fail as hard as this platform allows. The proven closure has to survive
 * byte for byte, because the alternative is a weak writer destroying a strong fact it never read.
 *
 * The weak writer is refused on strength before substance, so it never reaches the write at all - that
 * is the designed order and it is what makes the obstruction harmless here. The unparseable case below
 * is the one that has to be carried by the reader instead.
 */
it('leaves a published closure byte-identical through every failing write that follows it', () => {
  const command = fixtureCommand(); const entry = identity(command, nonce());
  const { runtime } = runtimeRoot('survives');
  const proven = saveClosure(runtime, strongRecord(entry));
  const file = evidenceFile(runtime, command.id);
  const bytes = readFileSync(file, 'utf8');
  // Every temporary name the module knows, all obstructed at once, so no writer of any kind can clean up.
  for (const suffix of ['.closure.tmp', '.startup-failed.tmp', '.no-progress.tmp']) obstruct(file + suffix);
  const refusals: (string | undefined)[] = [];
  for (const body of [
    () => saveNoProgress(runtime, weakRecord(entry)),
    () => saveNoProgress(runtime, weakRecord(entry, { phase: 'submitting', submission_state: 'UNKNOWN' })),
    () => saveStartupFailure(runtime, { ...entry, result: { outcome: 'CANCELED' as const, error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } } }),
  ]) {
    try { body(); refusals.push(undefined); } catch (error) { refusals.push(codeOf(error)); }
  }
  // Refused loudly and for the right reason - a strength refusal, not a filesystem one that happened to
  // stop them. A silent no-op would be as wrong as an overwrite.
  expect(refusals).toEqual(['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT']);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(proven);
  expect(readClosure(runtime, ref(entry))).toEqual(proven);
});

/**
 * The same survival question where the reader, not the writer, is the last line of defence. The file on
 * disk is not parseable, so no writer can learn what is there - and the rule is that unreadable is not
 * absent. A writer that is willing to create the record must be refused rather than allowed to replace
 * a proof it could not read, and the damaged file must be left exactly as it was for a human to look at.
 */
it('refuses to write over a proof it cannot read, and does not delete it', () => {
  const command = fixtureCommand(); const entry = identity(command, nonce());
  const { runtime } = runtimeRoot('unreadable');
  const file = evidenceFile(runtime, command.id);
  mkdirSync(path.dirname(file), { recursive: true });
  // A directory where the record should be: `existsSync` sees something, the parser cannot read it.
  mkdirSync(file, { recursive: true });
  writeFileSync(path.join(file, 'member'), 'not a record');
  const failure = capture(() => saveNoProgress(runtime, weakRecord(entry)));
  expect(codeOf(failure)).toBe('GUARDIAN_UNCONFIRMED');
  // Still there, still not a record, and no second file was created beside it.
  expect(existsSync(path.join(file, 'member'))).toBe(true);
  expect(readdirSync(path.dirname(file))).toEqual([command.id + '.json']);
  // And the reader agrees with the writer: unreadable is refused, never reported as "no proof yet".
  let read: string | undefined;
  try { readClosureEvidence(runtime, ref(entry)); } catch (error) { read = codeOf(error); }
  expect(read).toBe('GUARDIAN_UNCONFIRMED');
});

/**
 * The `finally` branch, and the honest limit of what can be shown about it.
 *
 * This test pins the part that is reachable: a leftover temporary file from a writer that died is
 * cleared *before* the next write, so it cannot block the next writer of the same kind, and the publish
 * leaves no temporary name behind.
 *
 * It deliberately does not claim to exercise a *failing* cleanup in the `finally`, because that state
 * cannot be constructed. `writeEvidenceFile` removes the temporary file and then writes it through the
 * same path, so anything that makes the unlink fail also makes the write fail - control never reaches
 * the `finally` at all. The branch is therefore proved by reading it, not by running it: `removeTemp`
 * wraps both its retry loop and its unlink in a bare catch, and it is the only cleanup in the module, so
 * there is no path by which a cleanup error can reach a caller. Repeating a green run would only be
 * another observation of the branch not being taken.
 */
it('clears a dead writer\'s leftover before publishing, and leaves no temporary behind', () => {
  const command = fixtureCommand(); const entry = identity(command, nonce());
  const { runtime } = runtimeRoot('leftover');
  const file = evidenceFile(runtime, command.id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.closure.tmp';
  // Exactly the crash leftover: a real, removable file that a previous writer never renamed.
  writeFileSync(tmp, '{"in-flight":"closure"}', { mode: 0o600 });
  const published = saveClosure(runtime, strongRecord(entry));
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(published));
  expect(existsSync(tmp)).toBe(false);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
  // The same write again is idempotent, and the second answer is the record on disk rather than a new
  // one - the published fact is what the caller receives both times.
  expect(saveClosure(runtime, { ...strongRecord(entry), closed_at: new Date(Date.now() + 60000).toISOString() })).toEqual(published);
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(published);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
});
