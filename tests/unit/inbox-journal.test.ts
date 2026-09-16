import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { it, expect } from 'vitest';
import { collectionJournalFixture } from '../helpers/collection-journal';
import { browserInboxPage } from '../../packages/contracts/src/browser-inbox';
import { inboxFixtureMessages } from '../../packages/adapters/src/browser-inbox-fixture';
import { saveClosure, closureFile, closureProof, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { flushActionJournal, maintainActionJournal } from '../../apps/agent/src/action-journal';
import { digest } from '@kff/core';

function fixture() {
  const h = collectionJournalFixture(), messages = inboxFixtureMessages(); messages[0].body = 'Private inbox raw marker';
  const page = browserInboxPage.parse({ monitor_id: randomUUID(), cursor: null, next_cursor: null, has_more: false, batch: { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: '800001', operating_identity_id: '10000001', observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages } });
  delete h.closure.result.collection_page; h.closure.result.inbox_page = page; h.closure.result.receipt!.content_hash = digest(page);
  h.entry.report = { ...h.closure.result, event_id: randomUUID(), command_id: h.entry.command_id }; unlinkSync(closureFile(h.runtime, h.entry.command_id)); saveClosure(h.runtime, h.closure); h.save();
  return { ...h, page, proof: closureProof(h.closure) };
}
it('replays an Inbox page unchanged after lost acknowledgement and compacts only after closure acknowledgement', async () => {
  const h = fixture(), reports: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint === 'action-reports') { reports.push(structuredClone(data)); if (reports.length === 1) throw new Error('Offline after receipt'); }
    else expect(data).toEqual(h.proof); return {} as T;
  };
  await expect(flushActionJournal(h.runtime, h.journal, h.save, api)).rejects.toThrow('Offline');
  expect(readFileSync(h.file, 'utf8')).toContain('Private inbox raw marker');
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true); expect(reports[0]).toEqual(reports[1]);
  expect(readFileSync(h.file, 'utf8')).not.toContain('Private inbox raw marker'); expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).not.toContain('Private inbox raw marker');
  expect(readClosureEvidence(h.runtime, h.entry)).toMatchObject({ page_sha256: digest(h.page) }); expect(closureProof(readClosureEvidence(h.runtime, h.entry)!)).toEqual(h.proof);
});
it('expires Inbox raw data locally while offline and never replays an expired page after restart', async () => {
  const h = fixture(); h.entry.collection_expires_at = new Date(0).toISOString(); h.save();
  maintainActionJournal(h.runtime, h.journal, h.save); const reloaded = h.reload();
  expect(readFileSync(h.file, 'utf8')).not.toContain('Private inbox raw marker');
  const endpoints: string[] = [];
  await flushActionJournal(h.runtime, reloaded, () => {}, async <T>(endpoint: string, data?: unknown) => { endpoints.push(endpoint); if (endpoint.endsWith('/quiescence')) expect(data).toEqual(h.proof); return { state: 'DONE', action_state: 'VERIFIED_SUCCEEDED' } as T; });
  await flushActionJournal(h.runtime, reloaded, () => {}, async <T>(endpoint: string, data?: unknown) => { endpoints.push(endpoint); expect(data).toEqual(h.proof); return {} as T; });
  expect(endpoints).not.toContain('action-reports'); expect(closureProof(readClosureEvidence(h.runtime, h.entry)!)).toEqual(h.proof);
});
