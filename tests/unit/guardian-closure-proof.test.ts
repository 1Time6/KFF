import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { digest } from '../../packages/core/src/index';
import { quiescenceInput, type CollectionPage } from '../../packages/contracts/src/index';
import { flushActionJournal, maintainActionJournal, type JournalEntry } from '../../apps/agent/src/action-journal';
import { closureFile, closureProof, compactClosure, readClosureEvidence, saveClosure, saveStartupFailure, startupFailedProtocolVersion, type GuardianClosure } from '../../apps/agent/src/guardian-protocol';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b01-closure-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
const syntheticPage = (): CollectionPage => ({ schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: randomUUID(), account_external_id: '10000001', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'SYNTHETIC_SAMPLE', rows: [] });

/** A runtime root of its own, so no assertion below can reach the project's real journal or closures. */
function fixture(options: { page?: boolean; expires?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-closure-')); roots.push(root);
  const runtime = path.join(root, '.kff');
  const entry: JournalEntry = { command_id: randomUUID(), action_id: randomUUID(), phase: 'claimed', guardian_nonce: digest(randomUUID()) };
  if (options.expires) entry.collection_expires_at = new Date(0).toISOString();
  const failure = saveStartupFailure(runtime, { command_id: entry.command_id, action_id: entry.action_id, nonce: entry.guardian_nonce!, result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' }, ...(options.page ? { collection_page: syntheticPage() } : {}) } });
  const journal: Record<string, JournalEntry> = { [entry.command_id]: entry };
  const file = path.join(runtime, 'agent', 'journal.json');
  return { runtime, entry, failure, journal, file, save: () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); } };
}
function normalClosure(): { runtime: string; closure: GuardianClosure } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-closure-')); roots.push(root);
  const runtime = path.join(root, '.kff');
  const closure: GuardianClosure = { protocol_version: 'kff.guardian-closure.v1', command_id: randomUUID(), action_id: randomUUID(), nonce: digest(randomUUID()), closed_at: new Date().toISOString(), context_closed: true, result: { outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: 'synthetic', actual_account_id: '10000001', evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: { step: 'proof-fixture' } } };
  saveClosure(runtime, closure);
  return { runtime, closure };
}

it('carries a startup failure under its own protocol version instead of the closed-context one', () => {
  const h = fixture();
  expect(closureProof(h.failure)).toEqual({ protocol_version: startupFailedProtocolVersion, command_id: h.entry.command_id, action_id: h.entry.action_id, closed_at: h.failure.closed_at, proof_sha256: digest(h.failure) });
  expect(closureProof(h.failure).protocol_version).not.toBe('kff.guardian-closure.v1');
  expect(quiescenceInput.parse(closureProof(h.failure))).toEqual(closureProof(h.failure));
});

it('leaves the proof of a real closure and of a compacted closure byte-identical', () => {
  const { runtime, closure } = normalClosure();
  const entry = { command_id: closure.command_id, action_id: closure.action_id, guardian_nonce: closure.nonce };
  const original = digest(closureProof(closure));
  expect(closureProof(closure)).toEqual({ protocol_version: 'kff.guardian-closure.v1', command_id: closure.command_id, action_id: closure.action_id, closed_at: closure.closed_at, proof_sha256: digest(closure) });
  const compact = compactClosure(runtime, entry, 'DELIVERED')!;
  expect(compact.protocol_version).toBe('kff.guardian-closure-compact.v1');
  expect(digest(closureProof(compact))).toBe(original);
});

it('never compacts a startup failure into a claim that a context was closed', () => {
  const h = fixture(); const file = closureFile(h.runtime, h.entry.command_id);
  const before = readFileSync(file, 'utf8');
  expect(compactClosure(h.runtime, h.entry, 'RETENTION_EXPIRED')).toMatchObject({ protocol_version: startupFailedProtocolVersion, context_opened: false });
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readFileSync(file, 'utf8')).not.toContain('context_closed');
  expect(existsSync(file + '.tmp')).toBe(false);
});

it('keeps a startup failure recognisable even when it is shaped like a collection record and is due for cleanup', () => {
  const h = fixture({ page: true, expires: true }); const file = closureFile(h.runtime, h.entry.command_id);
  const proof = closureProof(h.failure); const before = readFileSync(file, 'utf8');
  maintainActionJournal(h.runtime, h.journal, h.save);
  const record = readClosureEvidence(h.runtime, h.entry)!;
  expect(record.protocol_version).toBe(startupFailedProtocolVersion);
  expect(record).toMatchObject({ context_opened: false });
  expect(record).not.toHaveProperty('context_closed');
  expect(closureProof(record)).toEqual(proof);
  expect(readFileSync(file, 'utf8')).toBe(before);
});

it('resolves the journal from a startup failure and reports the command as canceled, not as submitted', async () => {
  const h = fixture(); const calls: string[] = []; const sent: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    calls.push(endpoint);
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'PREPARING' } as T;
    sent.push(structuredClone(data)); return {} as T;
  };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(h.entry.report).toMatchObject({ outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } });
  expect(h.entry).toMatchObject({ acknowledged: true, quiesced: true });
  expect(calls).toEqual(['commands/' + h.entry.command_id + '/status', 'action-reports', 'commands/' + h.entry.command_id + '/quiescence']);
  // The receiver is told which fact this is, on the wire, for every attempt.
  expect(sent[1]).toEqual({ protocol_version: startupFailedProtocolVersion, command_id: h.entry.command_id, action_id: h.entry.action_id, closed_at: h.failure.closed_at, proof_sha256: digest(h.failure) });
  expect(JSON.stringify(sent)).not.toContain('"protocol_version":"kff.guardian-closure.v1"');
});

it('rejects a proof that names neither closure protocol', () => {
  expect(quiescenceInput.safeParse({ protocol_version: 'kff.guardian-closure-compact.v1', command_id: randomUUID(), action_id: randomUUID(), closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) }).success).toBe(false);
  expect(quiescenceInput.safeParse({ protocol_version: 'kff.guardian-closure.v1', command_id: randomUUID(), action_id: randomUUID(), closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) }).success).toBe(true);
});
