import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { runGuardian } from '../../apps/agent/src/guardian';
import { closureProof, closureRanks, closureStrength, readClosure, readClosureEvidence, saveClosure, saveNoProgress, saveStartupFailure } from '../../apps/agent/src/guardian-protocol';
import { guardianTimingLimits, quiescenceInput } from '../../packages/contracts/src/index';
import { fixtureCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

/**
 * Two writers, one proof file. The parent writes a weak record when it had to end a child that stopped
 * making progress; the child writes a real closure when it closed what it opened. They are different
 * processes, they can be alive at the same time, and the path they publish to is the same one - so the
 * rules that decide who wins have to be written down, exercised, and safe in both directions.
 *
 * Every write below goes through the production writers, and every read through the production readers.
 * What the test arranges is the order the two writers happen in; the decision is not re-implemented.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-evidence-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const nonce = () => randomBytes(32).toString('hex');
type Entry = { command_id: string; action_id: string; nonce: string };
const identity = (command: AgentCommand, value: string): Entry => ({ command_id: command.id, action_id: command.action_id, nonce: value });
/**
 * A record carries `nonce`; the reader's identity carries `guardian_nonce` - the same value in the two
 * shapes that meet at the proof file, and the reason a reader that is handed the record's own shape
 * answers "no proof" instead of failing loudly.
 */
const ref = (entry: Entry) => ({ command_id: entry.command_id, action_id: entry.action_id, guardian_nonce: entry.nonce });
function runtimeRoot(label: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-evidence-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', label);
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
const evidenceFiles = (runtime: string) => readdirSync(path.join(runtime, 'agent', 'closures'));
const evidenceFile = (runtime: string, commandId: string) => path.join(runtime, 'agent', 'closures', commandId + '.json');
const codeOf = (error: unknown) => (error as { code?: string }).code;
/** The honest termination fact: a tree that was listed, probed, and found gone. */
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
const startupFailure = (entry: Entry) => ({ ...entry, result: { outcome: 'CANCELED' as const, error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } } });
/** A command the child refuses before it opens anything, so it reaches its own closure within a second. */
function staleCommand(): AgentCommand { return { ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) }; }
const liveness = { 'awaiting-ready': 30000, 'awaiting-start': 30000, 'awaiting-context': 30000, 'awaiting-intent': 30000, granting: 30000, submitting: 30000, grace: 15000, force: 3000 };
function seal<T>(root: string, hangPoint: string | undefined, body: () => T): T {
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['NODE_ENV', environment.NODE_ENV], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT]] as const;
  environment.KFF_ROOT = root; environment.NODE_ENV = 'test';
  if (hangPoint) environment.KFF_TEST_GUARDIAN_HANG_AT = hangPoint; else delete environment.KFF_TEST_GUARDIAN_HANG_AT;
  try { return body(); } finally { for (const [key, value] of previous) { if (value === undefined) delete environment[key]; else environment[key] = value; } }
}

/**
 * The weak record is not decoration: it is what a run falls back on when the parent had to end the
 * child. The execution's own proof can arrive later - the child may still be running when the parent
 * gives up on it - and when it does it has to replace the weak record rather than be refused by it. The
 * release decision changes with it: the reader that refused the weak record hands out the strong one.
 */
it('upgrades the record a run had to fall back on as soon as the execution proves its own closure', async () => {
  const command = staleCommand(); const value = nonce(); const entry = identity(command, value);
  const { root, runtime } = runtimeRoot('upgrade');
  const running = seal(root, 'before-ready', () => runGuardian(command, runtime, value, {
    signal: new AbortController().signal, beforeSubmit: async () => {},
    // The child is frozen before it ever says `ready`, so the parent has to end it and writes down what
    // it could prove on its own: the process is gone, and nothing was ever opened.
    liveness: { ...liveness, 'awaiting-ready': 1500, grace: 600 },
  }));
  const outcome = await running.then(closure => ({ resolved: closure.protocol_version }), error => ({ rejected: codeOf(error) }));
  expect(outcome).toEqual({ rejected: 'GUARDIAN_NO_PROGRESS' });
  const recorded = readClosureEvidence(runtime, ref(entry))!;
  expect(recorded.protocol_version).toBe('kff.guardian-closure-no-progress.v1');
  expect(closureStrength(recorded)).toBe('PROCESS_ONLY');
  // A weak record is not a release, and the reader says so in the only way that matters: it refuses.
  expect(() => readClosure(runtime, ref(entry))).toThrow();
  // The execution's own closure, written through the writer the child process itself calls.
  const upgraded = saveClosure(runtime, strongRecord(entry));
  expect(upgraded.protocol_version).toBe('kff.guardian-closure.v1');
  const onDisk = readClosureEvidence(runtime, ref(entry))!;
  expect(onDisk).toEqual(upgraded);
  expect(closureStrength(onDisk)).toBe('PROVEN_CLOSED');
  expect(readClosure(runtime, ref(entry))).toEqual(upgraded);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
}, 30000);

/**
 * The order that must never be allowed: a weaker record arriving after a proven closure. It is neither
 * silently ignored nor accepted - it is refused loudly, and what is on disk is left exactly as it was.
 * A silently dropped write would be as wrong as an accepted one, because the caller has to learn that
 * its fact did not become the record.
 */
it('refuses a weaker record once a closure is proven, and leaves the proven one untouched', () => {
  const command = fixtureCommand(); const value = nonce(); const entry = identity(command, value);
  const { runtime } = runtimeRoot('refuse');
  const proven = saveClosure(runtime, strongRecord(entry));
  const file = evidenceFile(runtime, command.id);
  const bytes = readFileSync(file, 'utf8');
  // Strength is compared before substance: even a weak record with facts of its own is refused.
  expect(() => saveNoProgress(runtime, weakRecord(entry, { phase: 'submitting', submission_state: 'UNKNOWN' }))).toThrow();
  const refusals: (string | undefined)[] = [];
  try { saveNoProgress(runtime, weakRecord(entry)); } catch (error) { refusals.push(codeOf(error)); }
  try { saveStartupFailure(runtime, startupFailure(entry)); } catch (error) { refusals.push(codeOf(error)); }
  expect(refusals).toEqual(['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT']);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(proven);
  expect(readClosure(runtime, ref(entry))).toEqual(proven);
  // The strengths themselves, in the only order that matters.
  expect(closureRanks.PROVEN_CLOSED).toBeGreaterThan(closureRanks.NEVER_OPENED);
  expect(closureRanks.NEVER_OPENED).toBeGreaterThan(closureRanks.PROCESS_ONLY);
  expect(closureStrength(proven)).toBe('PROVEN_CLOSED');
  expect(closureStrength(saveStartupFailure(runtime, startupFailure(identity(staleCommand(), nonce()))))).toBe('NEVER_OPENED');
  expect(closureStrength(readClosureEvidence(runtime, ref(entry))!)).toBe('PROVEN_CLOSED');
});

/**
 * The ladder in its other direction, on one execution context: process-only, then never-opened, then a
 * real closure. Each step upgrades; and once a step is taken, the weaker writer that made the previous
 * one cannot come back and overwrite it.
 */
it('lets a stronger record replace a weaker one and refuses the weaker writer afterwards', () => {
  const command = fixtureCommand(); const value = nonce(); const entry = identity(command, value);
  const { runtime } = runtimeRoot('ladder');
  const weak = saveNoProgress(runtime, weakRecord(entry));
  expect(closureStrength(weak)).toBe('PROCESS_ONLY');
  const failure = saveStartupFailure(runtime, startupFailure(entry));
  expect(closureStrength(failure)).toBe('NEVER_OPENED');
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(failure);
  let refused: string | undefined;
  try { saveNoProgress(runtime, weakRecord(entry)); } catch (error) { refused = codeOf(error); }
  expect(refused).toBe('IDEMPOTENCY_CONFLICT');
  const proven = saveClosure(runtime, strongRecord(entry));
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(proven);
  expect(readClosure(runtime, ref(entry))).toEqual(proven);
});

/** A replay of the same facts is idempotent - the write timestamp is the one field a retry may change. */
it('answers a replay of the same record with the record that is already on disk', () => {
  const command = fixtureCommand(); const value = nonce(); const entry = identity(command, value);
  const { runtime } = runtimeRoot('replay');
  const first = saveNoProgress(runtime, weakRecord(entry, { closed_at: '2026-09-17T00:00:00.000Z' }));
  const replayed = saveNoProgress(runtime, weakRecord(entry, { closed_at: '2026-09-17T06:00:00.000Z' }));
  expect(replayed.closed_at).toBe(first.closed_at);
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(first);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
  // The same rank with different facts is a genuine conflict instead, and changes nothing.
  let conflicted: string | undefined;
  try { saveNoProgress(runtime, weakRecord(entry, { phase: 'granting' })); } catch (error) { conflicted = codeOf(error); }
  expect(conflicted).toBe('IDEMPOTENCY_CONFLICT');
  expect(readClosureEvidence(runtime, ref(entry))).toEqual(first);
});

/**
 * The same two writers, with the weak one running against a live child. The assertions are about the
 * end state rather than the interleaving: the real closure is what remains, the weak writer is refused
 * from the moment it loses, and neither writer leaves a temporary file behind.
 */
it('keeps the weak writer from displacing a closure written at the same time', async () => {
  const command = staleCommand(); const value = nonce(); const entry = identity(command, value);
  const { root, runtime } = runtimeRoot('concurrent');
  let weakWrites = 0;
  const running = seal(root, undefined, () => runGuardian(command, runtime, value, {
    signal: new AbortController().signal, beforeSubmit: async () => {}, liveness,
  }));
  const weak = (async () => {
    for (let attempt = 0; attempt < 4000; attempt += 1) {
      try { saveNoProgress(runtime, weakRecord(entry, { closed_at: new Date().toISOString() })); weakWrites += 1; }
      catch (error) { return codeOf(error); }
      await delay(5);
    }
    return 'gave-up-writing';
  })();
  const resolved = await running.then(closure => closure.protocol_version, error => codeOf(error));
  expect(resolved).toBe('kff.guardian-closure.v1');
  expect(weakWrites).toBeGreaterThan(0);
  // The weak writer ends by being refused, not by overwriting: the closure it never saw is the record.
  expect(await weak).toBe('IDEMPOTENCY_CONFLICT');
  const onDisk = readClosureEvidence(runtime, ref(entry))!;
  expect(onDisk.protocol_version).toBe('kff.guardian-closure.v1');
  expect(readClosure(runtime, ref(entry))).toEqual(onDisk);
  expect(evidenceFiles(runtime)).toEqual([command.id + '.json']);
}, 60000);

/**
 * The `.tmp` half of the same problem. Each kind of record writes through a name of its own, so a
 * writer that finds an unrenamed file there can only ever be removing its own crash leftover. Here each
 * writer is confronted with the other's in-flight file and leaves it alone.
 */
it('only ever cleans up the temporary file its own kind of record writes through', async () => {
  const command = fixtureCommand(); const value = nonce(); const entry = identity(command, value);
  const { root, runtime } = runtimeRoot('temporaries');
  const file = evidenceFile(runtime, command.id);
  mkdirSync(path.dirname(file), { recursive: true });
  // A weak writer finding a closure writer's half-written file: it writes its own record and leaves it.
  const foreignClosureTmp = file + '.closure.tmp';
  writeFileSync(foreignClosureTmp, '{"in-flight":"closure"}', { mode: 0o600 });
  saveNoProgress(runtime, weakRecord(entry));
  expect(existsSync(foreignClosureTmp)).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(file + '.no-progress.tmp')).toBe(false);
  rmSync(foreignClosureTmp);
  // And the other way round, with the closure written by a real child process.
  const second = staleCommand(); const secondValue = nonce(); const secondFile = evidenceFile(runtime, second.id);
  const foreignNoProgressTmp = secondFile + '.no-progress.tmp';
  writeFileSync(foreignNoProgressTmp, '{"in-flight":"no-progress"}', { mode: 0o600 });
  const resolved = await seal(root, undefined, () => runGuardian(second, runtime, secondValue, { signal: new AbortController().signal, beforeSubmit: async () => {}, liveness }))
    .then(closure => closure.protocol_version, error => codeOf(error));
  expect(resolved).toBe('kff.guardian-closure.v1');
  expect(existsSync(secondFile)).toBe(true);
  expect(existsSync(foreignNoProgressTmp)).toBe(true);
  expect(existsSync(secondFile + '.closure.tmp')).toBe(false);
}, 30000);

/**
 * Why the create path can be trusted. The parent decides to write *because* no proof exists, and the
 * child can publish one while the parent is still writing its own temporary file - a rename would
 * overwrite that closure without ever having read it. A hard link cannot: it either creates the
 * destination or fails because it is already there, which is the whole reason the exclusive path uses
 * it. Asserted here as a platform fact rather than assumed, the way the termination suite asserts
 * taskkill's exit codes.
 */
it('publishes a record atomically when the decision was that nothing was there yet', () => {
  const { runtime } = runtimeRoot('atomic');
  const directory = path.join(runtime, 'agent', 'closures'); mkdirSync(directory, { recursive: true });
  const tmp = path.join(directory, 'probe.tmp'); const destination = path.join(directory, 'probe.json');
  writeFileSync(tmp, '{"first":true}', { mode: 0o600, flush: true });
  linkSync(tmp, destination);
  unlinkSync(tmp);
  expect(existsSync(tmp)).toBe(false);
  expect(readFileSync(destination, 'utf8')).toBe('{"first":true}');
  writeFileSync(tmp, '{"second":true}', { mode: 0o600, flush: true });
  let refused: string | undefined;
  try { linkSync(tmp, destination); } catch (error) { refused = codeOf(error); }
  expect(refused).toBe('EEXIST');
  unlinkSync(tmp);
  expect(readFileSync(destination, 'utf8')).toBe('{"first":true}');
});

/**
 * The evidence schema and the runtime policy share their bounds, so a legal policy can never produce a
 * record the schema would then refuse - which would discard a proof after the run had already settled,
 * when there is no second chance to record it. The other half of this pair - the policy's own range and
 * its startup validation - is in `guardian-liveness-policy.test.ts`.
 */
it('refuses a recorded duration its policy could not have produced, and a record without a process fact', () => {
  const { runtime } = runtimeRoot('bounds');
  const ceiling = guardianTimingLimits.max_total_ms;
  const entry = identity(fixtureCommand(), nonce());
  // Exactly the ceiling is a legal recording: it is what the largest legal policy can accumulate.
  expect(() => saveNoProgress(runtime, weakRecord(entry, { waited_ms: ceiling, grace_ms: ceiling }))).not.toThrow();
  expect(readClosureEvidence(runtime, ref(entry))).toMatchObject({ waited_ms: ceiling, grace_ms: ceiling });
  // One millisecond past it is not: nothing in the runtime can produce that number.
  expect(() => saveNoProgress(runtime, weakRecord(identity(fixtureCommand(), nonce()), { waited_ms: ceiling + 1 }))).toThrow();
  expect(() => saveNoProgress(runtime, weakRecord(identity(fixtureCommand(), nonce()), { grace_ms: ceiling + 1 }))).toThrow();
  expect(() => saveNoProgress(runtime, weakRecord(identity(fixtureCommand(), nonce()), { waited_ms: -1 }))).toThrow();
  // A record that cannot say what happened to the process tree is not written at all, and the old
  // boolean shape is gone rather than optional: the writer takes the fields it knows, so a legacy caller
  // cannot smuggle the boolean into a record, and a file that carries it is not evidence either.
  const { termination: _dropped, ...withoutTermination } = weakRecord(identity(fixtureCommand(), nonce()));
  expect(() => saveNoProgress(runtime, withoutTermination as NoProgressInput)).toThrow();
  expect(() => saveNoProgress(runtime, weakRecord(identity(fixtureCommand(), nonce()), { termination: { ...termination, process_tree: 'MAYBE' } as unknown as NoProgressInput['termination'] }))).toThrow();
  const legacyEntry = identity(fixtureCommand(), nonce());
  const written = saveNoProgress(runtime, { ...weakRecord(legacyEntry), process_terminated: true } as unknown as NoProgressInput);
  const legacyFile = evidenceFile(runtime, legacyEntry.command_id);
  expect(readFileSync(legacyFile, 'utf8')).not.toContain('process_terminated');
  expect(written).not.toHaveProperty('process_terminated');
  writeFileSync(legacyFile, JSON.stringify({ ...written, process_terminated: true }), { mode: 0o600 });
  let legacyRead: string | undefined;
  try { readClosureEvidence(runtime, ref(legacyEntry)); } catch (error) { legacyRead = codeOf(error); }
  expect(legacyRead).toBe('GUARDIAN_UNCONFIRMED');
  // And the proof derived from such a record carries the fact the receiver validates, so a proof that
  // had dropped it would not parse at all.
  const proof = closureProof(readClosureEvidence(runtime, ref(entry))!);
  expect(proof).toMatchObject({ protocol_version: 'kff.guardian-closure-no-progress.v1', process_tree: 'DEAD' });
  expect(quiescenceInput.safeParse(proof).success).toBe(true);
  const { process_tree: _omitted, ...withoutFact } = proof as unknown as Record<string, unknown>;
  expect(quiescenceInput.safeParse(withoutFact).success).toBe(false);
});
