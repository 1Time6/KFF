import { readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { digest } from '../../packages/core/src/index';
import { flushActionJournal, maintainActionJournal } from '../../apps/agent/src/action-journal';
import { closureFile, closureProof, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { collectionJournalFixture } from '../helpers/collection-journal';

const offline = () => { throw new Error('Controller unavailable'); };
function expectRedacted(h: ReturnType<typeof collectionJournalFixture>) {
  expect(readFileSync(h.file, 'utf8')).not.toContain('Synthetic raw page marker');
  const closure = readClosureEvidence(h.runtime, h.entry)!;
  expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).not.toContain('Synthetic raw page marker');
  expect(closureProof(closure)).toEqual(h.proof);
  expect(closure).toMatchObject({ result_sha256: digest(h.closure.result), page_sha256: digest(h.page) });
}

it('replays the exact page event after lost acknowledgement, then removes raw data after quiescence', async () => {
  const h = collectionJournalFixture(), requests: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint === 'action-reports') { requests.push(structuredClone(data)); if (requests.length === 1) offline(); }
    else expect(data).toEqual(h.proof);
    return {} as T;
  };
  await expect(flushActionJournal(h.runtime, h.journal, h.save, api)).rejects.toThrow('unavailable');
  expect(h.entry.report?.collection_page).toEqual(h.page);
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(h.entry).toMatchObject({ acknowledged: true, quiesced: true, collection_redaction: { reason: 'DELIVERED' } });
  expectRedacted(h);
});

it('retains the original proof through an acknowledgement followed by a quiescence outage and expiry', async () => {
  const h = collectionJournalFixture();
  await expect(flushActionJournal(h.runtime, h.journal, h.save, async <T>(endpoint: string) => {
    if (endpoint !== 'action-reports') offline(); return {} as T;
  })).rejects.toThrow('unavailable');
  expect(h.entry.acknowledged).toBe(true); expect(h.entry.report?.collection_page).toBeDefined();
  h.entry.collection_expires_at = new Date(0).toISOString(); h.save();
  maintainActionJournal(h.runtime, h.journal, h.save); expectRedacted(h);
  const endpoints: string[] = [];
  expect(await flushActionJournal(h.runtime, h.journal, h.save, async <T>(endpoint: string, data?: unknown) => { endpoints.push(endpoint); expect(data).toEqual(h.proof); return {} as T; })).toBe(true);
  expect(endpoints).toEqual(['commands/' + h.entry.command_id + '/quiescence']);
});

it('expires offline and resolves a lost original acknowledgement after a disk reload without re-sending the page', async () => {
  const h = collectionJournalFixture(), original = structuredClone(h.entry.report);
  h.entry.collection_expires_at = new Date(0).toISOString(); h.save();
  maintainActionJournal(h.runtime, h.journal, h.save); expectRedacted(h);
  expect(h.entry.collection_redaction).toMatchObject({ report_event_id: original!.event_id, report_sha256: digest(original) });
  Object.assign(h.journal, h.reload());
  const calls: string[] = [];
  const api = async <T>(endpoint: string, data?: unknown) => { calls.push(endpoint); if (endpoint.endsWith('/status')) return { state: 'DONE', action_state: 'VERIFIED_SUCCEEDED' } as T; expect(data).toEqual(h.proof); return {} as T; };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(false);
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(calls).toEqual(['commands/' + h.entry.command_id + '/status', 'commands/' + h.entry.command_id + '/quiescence']);
});

it('sends only a stable expiry failure when the original page was never accepted', async () => {
  const h = collectionJournalFixture(), originalId = h.entry.report!.event_id, requests: unknown[] = [];
  h.entry.collection_expires_at = new Date(0).toISOString(); h.save();
  const api = async <T>(endpoint: string, data?: unknown) => {
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'PREPARING' } as T;
    if (endpoint === 'action-reports') { requests.push(structuredClone(data)); if (requests.length === 1) offline(); }
    else expect(data).toEqual(h.proof);
    return {} as T;
  };
  await expect(flushActionJournal(h.runtime, h.journal, h.save, api)).rejects.toThrow('unavailable');
  expect(h.entry.report).toMatchObject({ outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED' });
  expect(h.entry.report!.event_id).not.toBe(originalId); expectRedacted(h);
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(requests[0]).toEqual(requests[1]); expect(JSON.stringify(requests)).not.toContain('Synthetic raw page marker');
});

it('never invents closure evidence or releases a missing guardian after raw data expires', async () => {
  const h = collectionJournalFixture(), file = closureFile(h.runtime, h.entry.command_id);
  writeFileSync(file + '.tmp', readFileSync(file)); unlinkSync(file);
  h.entry.collection_expires_at = new Date(0).toISOString();
  expect(await flushActionJournal(h.runtime, h.journal, h.save, async () => offline())).toBe(false);
  expect(h.entry.quiesced).toBeUndefined(); expect(h.entry.report?.collection_page).toBeUndefined();
  expect(existsSync(file + '.tmp')).toBe(false);
});

it('recovers a crash after journal redaction intent but before replacing the raw closure', () => {
  const h = collectionJournalFixture(); h.entry.acknowledged = true; h.entry.quiesced = true;
  expect(() => maintainActionJournal(h.runtime, h.journal, () => { h.save(); throw new Error('Power loss'); })).toThrow('Power loss');
  expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).toContain('Synthetic raw page marker');
  Object.assign(h.journal, h.reload()); maintainActionJournal(h.runtime, h.journal, h.save); expectRedacted(h);
});

it('cleans legacy delivered collection entries and leaves ordinary action records alone', () => {
  const h = collectionJournalFixture(); delete h.entry.collection_expires_at; h.entry.acknowledged = true; h.entry.quiesced = true;
  maintainActionJournal(h.runtime, h.journal, h.save); expectRedacted(h);
  const ordinary = collectionJournalFixture(); delete ordinary.entry.collection_expires_at; delete ordinary.entry.report!.collection_page;
  ordinary.save(); const before = readFileSync(ordinary.file, 'utf8');
  maintainActionJournal(ordinary.runtime, ordinary.journal, ordinary.save);
  expect(readFileSync(ordinary.file, 'utf8')).toBe(before);
});

it('rejects a substituted nonce even when cleanup is due', () => {
  const h = collectionJournalFixture(); h.entry.guardian_nonce = digest('wrong guardian'); h.entry.collection_expires_at = new Date(0).toISOString();
  expect(() => maintainActionJournal(h.runtime, h.journal, h.save)).toThrow('不匹配');
  expect(h.entry.quiesced).toBeUndefined();
});

it('does not transmit a raw page that expires while waiting for command status', async () => {
  const h = collectionJournalFixture(); delete h.entry.report; h.save(); const calls: string[] = [];
  const api = async <T>(endpoint: string) => { calls.push(endpoint); h.entry.collection_expires_at = new Date(0).toISOString(); return { state: 'CLAIMED', action_state: 'PREPARING' } as T; };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(false);
  expect(calls).toEqual(['commands/' + h.entry.command_id + '/status']); expectRedacted(h);
});
