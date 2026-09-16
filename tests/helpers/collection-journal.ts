import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../../packages/core/src/index';
import type { CollectionPage } from '../../packages/contracts/src/index';
import { saveClosure, closureProof, type GuardianClosure } from '../../apps/agent/src/guardian-protocol';
import type { JournalEntry } from '../../apps/agent/src/action-journal';

export function collectionJournalFixture() {
  const root = path.resolve('.kff/collection-journal-tests', randomUUID()), runtime = path.join(root, '.kff');
  const page: CollectionPage = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: randomUUID(), account_external_id: '10000001', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'SYNTHETIC_SAMPLE', rows: [{ source_object_id: 'synthetic_1', source_url: 'http://127.0.0.1:4311/collection-object/1', fields: { message: { kind: 'VALUE', value: 'Synthetic raw page marker ' + randomUUID() } } }] };
  const entry: JournalEntry = { command_id: randomUUID(), action_id: randomUUID(), phase: 'context_open', guardian_nonce: digest(randomUUID()), collection_expires_at: new Date(Date.now() + 3600000).toISOString() };
  const closure: GuardianClosure = { protocol_version: 'kff.guardian-closure.v1', command_id: entry.command_id, action_id: entry.action_id, nonce: entry.guardian_nonce!, closed_at: new Date().toISOString(), context_closed: true, result: { outcome: 'VERIFIED_SUCCEEDED', collection_page: page, receipt: { remote_id: 'synthetic-page', actual_account_id: page.account_external_id, content_hash: digest(page), evidence_kind: 'synthetic_dom', observed_at: page.observed_at }, diagnostic: { step: 'journal-fixture' } } };
  entry.report = { ...closure.result, command_id: entry.command_id, event_id: randomUUID() };
  const journal = { [entry.command_id]: entry }, file = path.join(runtime, 'agent', 'journal.json');
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(journal), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file); };
  saveClosure(runtime, closure); save();
  return { root, runtime, file, journal, entry, save, page, closure, proof: closureProof(closure), reload: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, JournalEntry> };
}
