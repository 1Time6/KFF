import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { digest } from '../../packages/core/src/index';
import type { CollectionPage } from '../../packages/contracts/src/index';
import { saveClosure, saveNoProgress, saveStartupFailure, closureProof, type GuardianClosure } from '../../apps/agent/src/guardian-protocol';
import type { JournalEntry } from '../../apps/agent/src/action-journal';

// A fixture call has no teardown of its own, so every root it creates is recorded here and removed
// by the importing file's own teardown. The prefix and parent checks mean the cleanup can only ever
// delete a directory this fixture created under the operating system's temporary directory.
const created: string[] = [];
function discardAfterFile(root: string) { created.push(root); }
afterAll(() => {
  for (const root of created.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-collection-journal-')) throw new Error('Unexpected test directory');
    try { rmSync(root, { recursive: true, force: true }); } catch { /* a held handle leaves our own temp directory behind, never project state */ }
  }
});

/**
 * The same container, holding the record the parent writes for a child that died before `ready`.
 * Two details differ from a normal entry, and both are what the production journal really looks
 * like: the phase is still `claimed` because no executor ever ran, and there is no report yet -
 * the flush derives one from the record rather than receiving it from a child.
 */
export function startupFailureJournalFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-collection-journal-')), runtime = path.join(root, '.kff');
  discardAfterFile(root);
  const entry: JournalEntry = { command_id: randomUUID(), action_id: randomUUID(), phase: 'claimed', guardian_nonce: digest(randomUUID()), collection_expires_at: new Date(Date.now() + 3600000).toISOString() };
  const record = saveStartupFailure(runtime, { command_id: entry.command_id, action_id: entry.action_id, nonce: entry.guardian_nonce!, result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } } });
  const journal = { [entry.command_id]: entry }, file = path.join(runtime, 'agent', 'journal.json');
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); };
  save();
  return { root, runtime, file, journal, entry, save, record, proof: closureProof(record), reload: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, JournalEntry> };
}

/**
 * The container for the other ending: a child the parent had to end itself. The record proves the
 * process is gone and deliberately says nothing about the browser, so it is exactly the fact whose loss
 * would hand a quarantined environment back.
 *
 * `withReport` is the two states a real journal is found in when a page expires. A run that produced a
 * child outcome has a report; a restart between the forced termination and the flush has none, and the
 * flush then derives one from the record. `tree` is the judgement the parent actually reached - the
 * default is the one that must never release anything.
 */
export function noProgressJournalFixture(withReport: boolean, tree: 'DEAD' | 'UNKNOWN' = 'UNKNOWN') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-collection-journal-')), runtime = path.join(root, '.kff');
  discardAfterFile(root);
  const entry: JournalEntry = { command_id: randomUUID(), action_id: randomUUID(), phase: 'submitting', guardian_nonce: digest(randomUUID()), collection_expires_at: new Date(Date.now() - 1000).toISOString() };
  const record = saveNoProgress(runtime, {
    command_id: entry.command_id, action_id: entry.action_id, nonce: entry.guardian_nonce!, phase: 'submitting',
    termination: { process_tree: tree, tool: 'ERROR', root: 'ALIVE', descendants: 'DEAD', sampled: 0, enumeration: 'UNAVAILABLE', elapsed_ms: 30 },
    context_opened: true, submission_state: 'UNKNOWN', forced: true, waited_ms: 900000, grace_ms: 15000,
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS', diagnostic: { step: 'guardian-no-progress' } },
  });
  if (withReport) entry.report = { ...record.result, event_id: randomUUID(), command_id: entry.command_id, guardian: record.termination };
  const journal = { [entry.command_id]: entry }, file = path.join(runtime, 'agent', 'journal.json');
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); };
  save();
  return { root, runtime, file, journal, entry, save, record, proof: closureProof(record), reload: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, JournalEntry> };
}

export function collectionJournalFixture() {
  // A fixture's journal, closures and profile root belong in the operating system's temporary
  // directory: a unit test must never write runtime state into the project's real `.kff` root.
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-collection-journal-')), runtime = path.join(root, '.kff');
  discardAfterFile(root);
  const page: CollectionPage = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: randomUUID(), account_external_id: '10000001', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'SYNTHETIC_SAMPLE', rows: [{ source_object_id: 'synthetic_1', source_url: 'http://127.0.0.1:4311/collection-object/1', fields: { message: { kind: 'VALUE', value: 'Synthetic raw page marker ' + randomUUID() } } }] };
  const entry: JournalEntry = { command_id: randomUUID(), action_id: randomUUID(), phase: 'context_open', guardian_nonce: digest(randomUUID()), collection_expires_at: new Date(Date.now() + 3600000).toISOString() };
  const closure: GuardianClosure = { protocol_version: 'kff.guardian-closure.v1', command_id: entry.command_id, action_id: entry.action_id, nonce: entry.guardian_nonce!, closed_at: new Date().toISOString(), context_closed: true, result: { outcome: 'VERIFIED_SUCCEEDED', collection_page: page, receipt: { remote_id: 'synthetic-page', actual_account_id: page.account_external_id, content_hash: digest(page), evidence_kind: 'synthetic_dom', observed_at: page.observed_at }, diagnostic: { step: 'journal-fixture' } } };
  entry.report = { ...closure.result, command_id: entry.command_id, event_id: randomUUID() };
  const journal = { [entry.command_id]: entry }, file = path.join(runtime, 'agent', 'journal.json');
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); };
  saveClosure(runtime, closure); save();
  return { root, runtime, file, journal, entry, save, page, closure, proof: closureProof(closure), reload: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, JournalEntry> };
}
