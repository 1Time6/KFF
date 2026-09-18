import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { AppError } from '@kff/core';
import { saveNoProgress } from '../../apps/agent/src/guardian-protocol';
import { flushActionJournal, type JournalEntry } from '../../apps/agent/src/action-journal';
import { fixtureCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

/**
 * §8-H: which refusal the flush is actually making.
 *
 * `flushActionJournal` returning `false` has four distinct causes, and they are not interchangeable: two
 * of them quarantine the entry and two do not, one of them is a domain refusal and one is a local
 * bookkeeping decision that never reaches the controller at all. Under load the integration case sees
 * only the `false`, which is why the earlier round could not name the branch and had to record the
 * mechanism as unproved.
 *
 * So each cause is forced here, one per case, through the only two inputs the function has: the closure
 * evidence on disk and the controller it is handed. A fake controller is what makes this deterministic -
 * it refuses on command instead of when the machine happens to be busy - and it also records the calls,
 * so "which endpoints were reached" is an assertion rather than an inference.
 *
 * What this file does *not* do is explain the integration failure by itself. It fixes the vocabulary:
 * after it, a recorded call sequence names a branch. §8-G supplies the sequence from the real run.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-flush-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
function runtimeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-flush-')); roots.push(root);
  const runtime = path.join(root, '.kff', 'agent-process-tests', 'flush');
  mkdirSync(runtime, { recursive: true });
  return runtime;
}
const termination = { process_tree: 'DEAD', tool: 'SUCCESS', root: 'DEAD', descendants: 'DEAD', sampled: 2, enumeration: 'LISTED', elapsed_ms: 120 } as const;
type Result = Parameters<typeof saveNoProgress>[1]['result'];
const result = (overrides: Partial<Result> = {}): Result => ({ outcome: 'CANCELED', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' }, ...overrides });

/**
 * A page-shaped result, which is what retention owns and what makes the flush's third refusal reachable.
 * It has to be a real page rather than a placeholder because the record is parsed strictly on the way in
 * and on the way out - a shape the schema would reject is a shape the module never sees.
 */
const collectionPage = () => ({
  schema_version: 'kff.collection-page.v1' as const, source_key: 'kff.fixture.page.posts' as const, source_version: 'fixture-page-posts-v1' as const,
  query_id: randomUUID(), account_external_id: '100000000000000001', cursor: null, next_cursor: null,
  observed_at: new Date().toISOString(), reported_total: null, coverage: 'SYNTHETIC_SAMPLE' as const, rows: [],
});
type Entry = { command_id: string; action_id: string; nonce: string };
const identity = (command: AgentCommand, nonce: string): Entry => ({ command_id: command.id, action_id: command.action_id, nonce });
/** The record the flush reads: a proven termination that is explicitly *not* a closure. */
function prove(runtime: string, entry: Entry, overrides: Partial<Result> = {}) {
  return saveNoProgress(runtime, {
    ...entry, phase: 'granting', termination, context_opened: true, submission_state: 'UNKNOWN', forced: true,
    waited_ms: 1500, grace_ms: 1000, result: result(overrides),
  });
}
const journalFor = (command: AgentCommand, nonce: string): Record<string, JournalEntry> => ({
  [command.id]: { command_id: command.id, action_id: command.action_id, phase: 'submitting', guardian_nonce: nonce },
});

type Behaviour = { status?: { state: string; action_state: string }; failReportWith?: string };
/**
 * The controller the flush talks to, with its refusals under the test's control. `calls` is the whole
 * point of it: the branch is identified by which endpoints were reached and what came back, so the
 * recorder and the injector have to be the same object.
 */
function fakeController(behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    const parts = endpoint.split('/');
    if (endpoint === 'action-reports') {
      calls.push('action-reports');
      if (behaviour.failReportWith) throw new AppError(behaviour.failReportWith, 'injected refusal');
      return {} as T;
    }
    if (parts[0] === 'commands' && parts[2] === 'status') { calls.push('status:' + (behaviour.status?.state ?? 'CLAIMED')); return (behaviour.status ?? { state: 'CLAIMED', action_state: 'SUBMITTING' }) as T; }
    if (parts[0] === 'commands' && parts[2] === 'quiescence') { calls.push('quiescence'); return {} as T; }
    throw new Error('Unexpected controller endpoint ' + endpoint + ' ' + String(data));
  };
  return { api, calls };
}

/**
 * The control. Without it the refusals below prove nothing, because a function that always returned
 * `false` would satisfy every one of them. This is the ordinary path: the command is still claimable,
 * the report is accepted, quiescence is recorded, and the entry ends quiesced.
 */
it('accepts the ordinary path, so the refusals below are distinguishable from a function that never works', async () => {
  const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex'); const entry = identity(command, nonce);
  const runtime = runtimeRoot(); const proven = prove(runtime, entry);
  const journal = journalFor(command, nonce); const { api, calls } = fakeController();
  expect(await flushActionJournal(runtime, journal, () => {}, api)).toBe(true);
  expect(calls).toEqual(['status:CLAIMED', 'action-reports', 'quiescence']);
  expect(journal[command.id].quiesced).toBe(true);
  expect(journal[command.id].quarantined).toBeUndefined();
  expect(journal[command.id].report).toMatchObject({ outcome: 'UNKNOWN_OUTCOME', error_code: 'GUARDIAN_NO_PROGRESS' });
  expect(proven.command_id).toBe(command.id);
});

/**
 * Cause one: the command lifecycle moved on. A command that is no longer `READY` or `CLAIMED` must not
 * have a report written against it, so the flush stops, quarantines the entry, and never reaches the
 * controller's write endpoints. It is a local decision about a fact the controller reported.
 */
it('refuses, quarantines and never writes when the command is no longer claimable', async () => {
  const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex');
  const runtime = runtimeRoot(); prove(runtime, identity(command, nonce));
  const journal = journalFor(command, nonce); const { api, calls } = fakeController({ status: { state: 'SUBMITTING', action_state: 'SUBMITTING' } });
  expect(await flushActionJournal(runtime, journal, () => {}, api)).toBe(false);
  expect(calls).toEqual(['status:SUBMITTING']);
  expect(journal[command.id].quarantined).toBe(true);
  expect(journal[command.id].quiesced).toBeUndefined();
});

/**
 * Cause two: the controller refuses the write itself, on freshness grounds. This is the only cause that
 * carries a domain code, and the code is what distinguishes it - the batch treats a stale lease and a
 * version conflict alike, so both are forced here rather than assuming one stands for the other.
 *
 * Note what is *not* asserted: that the refusal was correct. Whether the lease really was stale is the
 * question §8-G answers from the real run; here the code is injected, so the point is only that this
 * code and this branch are the same thing.
 */
for (const code of ['LEASE_STALE', 'VERSION_CONFLICT']) {
  it('refuses and quarantines when the controller rejects the write with ' + code, async () => {
    const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex');
    const runtime = runtimeRoot(); prove(runtime, identity(command, nonce));
    const journal = journalFor(command, nonce); const { api, calls } = fakeController({ failReportWith: code });
    expect(await flushActionJournal(runtime, journal, () => {}, api)).toBe(false);
    expect(calls).toEqual(['status:CLAIMED', 'action-reports']);
    expect(journal[command.id].quarantined).toBe(true);
    expect(journal[command.id].quiesced).toBeUndefined();
    expect(journal[command.id].acknowledged).toBeUndefined();
  });
}

/**
 * Cause three: retention redacted the page while the flush was mid-flight. The distinguishing feature is
 * that nothing failed and nothing was quarantined - the flush simply must not send a report whose
 * payload it just replaced - so the sequence alone would be ambiguous without the journal state.
 *
 * The redaction is reached the way the module actually reaches it: the record carries a collection page,
 * so the report built from it has one, and the retention pass that runs immediately afterwards sees a
 * page it owns and compacts.
 */
it('refuses without quarantining when retention redacts the page mid-flush', async () => {
  const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex');
  const runtime = runtimeRoot();
  prove(runtime, identity(command, nonce), { collection_page: collectionPage() });
  const journal = journalFor(command, nonce); const { api, calls } = fakeController();
  expect(await flushActionJournal(runtime, journal, () => {}, api)).toBe(false);
  expect(calls).toEqual(['status:CLAIMED']);
  expect(journal[command.id].collection_redaction).toBeDefined();
  expect(journal[command.id].quarantined).toBeUndefined();
  expect(journal[command.id].quiesced).toBeUndefined();
});

/**
 * Cause four: there is no proof at all. The flush must not invent one and must not write anything, which
 * is why the assertion is that the controller was never called - absence of evidence has to stop the
 * work rather than be quietly skipped.
 */
it('refuses without touching the controller when there is no closure evidence', async () => {
  const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex');
  const runtime = runtimeRoot();
  const journal = journalFor(command, nonce); const { api, calls } = fakeController();
  expect(await flushActionJournal(runtime, journal, () => {}, api)).toBe(false);
  expect(calls).toEqual([]);
  expect(journal[command.id].quarantined).toBeUndefined();
  expect(journal[command.id].quiesced).toBeUndefined();
});

/**
 * The property that ties the causes together, and the one the ruling actually cares about: none of these
 * refusals is allowed to look like success. A reader of the journal can tell a quarantined entry from a
 * quiesced one from an untouched one, and only the last of those four states licenses freeing the slot.
 */
it('leaves every refusal distinguishable from a quiesced entry', async () => {
  const seen: string[] = [];
  for (const behaviour of [{}, { status: { state: 'DONE', action_state: 'SUBMITTED' } }, { failReportWith: 'LEASE_STALE' }]) {
    const command = fixtureCommand(); const nonce = randomBytes(32).toString('hex');
    const runtime = runtimeRoot(); prove(runtime, identity(command, nonce));
    const journal = journalFor(command, nonce); const { api } = fakeController(behaviour);
    await flushActionJournal(runtime, journal, () => {}, api);
    const entry = journal[command.id];
    seen.push(entry.quiesced ? 'QUIESCED' : entry.quarantined ? 'QUARANTINED' : 'UNTOUCHED');
  }
  expect(seen).toEqual(['QUIESCED', 'QUARANTINED', 'QUARANTINED']);
});
