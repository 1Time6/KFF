import { readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { digest } from '../../packages/core/src/index';
import { flushActionJournal, maintainActionJournal } from '../../apps/agent/src/action-journal';
import { closureFile, closureProof, readClosureEvidence, startupFailedProtocolVersion } from '../../apps/agent/src/guardian-protocol';
import { collectionJournalFixture, noProgressJournalFixture, startupFailureJournalFixture } from '../helpers/collection-journal';

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

/**
 * A startup failure is a fact about what never happened, so the whole recovery chain has to keep it
 * that way: releasing the slot must not become a claim that a context was closed, and flushing the
 * same entry twice must not release the slot twice or send a second terminal report.
 */
it('releases the slot exactly once for a proven startup failure and never restates it as a closed context', async () => {
  const h = startupFailureJournalFixture(), calls: string[] = [], reports: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    calls.push(endpoint);
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'PREPARING' } as T;
    if (endpoint === 'action-reports') { reports.push(structuredClone(data)); return { accepted: true } as T; }
    expect(data).toEqual(h.proof); return {} as T;
  };
  // The report is derived from the record itself; no child ever supplied one.
  expect(h.entry.report).toBeUndefined();
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  // The report was derived from the record, and the entry was redacted as delivered once it was.
  expect(reports).toEqual([expect.objectContaining({ outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED' })]);
  expect(h.entry).toMatchObject({ acknowledged: true, quiesced: true });
  expect(calls).toEqual(['commands/' + h.entry.command_id + '/status', 'action-reports', 'commands/' + h.entry.command_id + '/quiescence']);

  // A second flush over the same settled entry performs no work at all: one slot release, one report.
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(calls).toHaveLength(3);
  expect(reports).toHaveLength(1);
  // The proof on record is still the startup failure, and the record still carries no `context_closed`.
  expect(h.entry.collection_redaction?.reason).toBe('DELIVERED');
  const record = readClosureEvidence(h.runtime, h.entry)!;
  expect(record.protocol_version).toBe(startupFailedProtocolVersion);
  expect(record).not.toHaveProperty('context_closed');
  expect(closureProof(record)).toEqual(h.proof);
  // Repeated local maintenance, including after a disk reload, leaves both the journal and the
  // closure byte-identical: retention may drop the entry's data but never the fact it records.
  const before = readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8');
  Object.assign(h.journal, h.reload()); maintainActionJournal(h.runtime, h.journal, h.save); maintainActionJournal(h.runtime, h.journal, h.save);
  expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).toBe(before);
  expect(readClosureEvidence(h.runtime, h.journal[h.entry.command_id])!.protocol_version).toBe(startupFailedProtocolVersion);
});

/**
 * The startup-failure record itself is never the thing that decides, the action's own state is.
 * If the controller ever reports an action that had already reached the submission boundary, the
 * `CANCELED` the parent recorded must not be delivered as though nothing could have happened.
 */
it('rewrites a startup failure to UNKNOWN_OUTCOME when the action state says submission had begun', async () => {
  const h = startupFailureJournalFixture(), reports: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'SUBMITTING' } as T;
    if (endpoint === 'action-reports') { reports.push(structuredClone(data)); return { accepted: true } as T; }
    expect(data).toEqual(h.proof); return {} as T;
  };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(reports).toEqual([expect.objectContaining({ outcome: 'UNKNOWN_OUTCOME', error_code: 'GUARDIAN_STARTUP_FAILED' })]);
  // The proof still travels under the startup-failure version: the uncertainty was added to the
  // outcome, it did not overwrite the fact that no context was ever opened.
  expect(readClosureEvidence(h.runtime, h.entry)!.protocol_version).toBe(startupFailedProtocolVersion);
});

it('does not transmit a raw page that expires while waiting for command status', async () => {
  const h = collectionJournalFixture(); delete h.entry.report; h.save(); const calls: string[] = [];
  const api = async <T>(endpoint: string) => { calls.push(endpoint); h.entry.collection_expires_at = new Date(0).toISOString(); return { state: 'CLAIMED', action_state: 'PREPARING' } as T; };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(false);
  expect(calls).toEqual(['commands/' + h.entry.command_id + '/status']); expectRedacted(h);
});

/**
 * Retention answers exactly one question - may this payload be kept - and the guardian's process fact
 * is not part of it. These three cases pin the boundary from both sides: a fact that exists is carried
 * through the expiry, a fact that exists only in the record is restored from it, and a record that
 * proves nothing gains nothing. The last one is as important as the first: an invented termination fact
 * would be indistinguishable from a measured one downstream.
 */
it('carries the guardian process fact through retention expiry instead of replacing the report', async () => {
  const h = noProgressJournalFixture(true, 'UNKNOWN'), reports: unknown[] = [];
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'SUBMITTING' } as T;
    if (endpoint === 'action-reports') { reports.push(structuredClone(data)); return { accepted: true } as T; }
    expect(data).toEqual(h.proof); return {} as T;
  };
  maintainActionJournal(h.runtime, h.journal, h.save);
  // The page is gone, the outcome is the retention one, and the safety fact is untouched.
  expect(h.entry.report).toMatchObject({ outcome: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS', guardian: { process_tree: 'UNKNOWN', tool: 'ERROR' } });
  expect(h.entry.report?.collection_page).toBeUndefined();
  expect(JSON.stringify(h.entry)).not.toContain('Synthetic raw page marker');
  expect(h.entry.collection_redaction?.reason).toBe('RETENTION_EXPIRED');
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  // The same fact is what the receiver is handed, unchanged by the second redaction round.
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ outcome: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS', guardian: { process_tree: 'UNKNOWN', tool: 'ERROR', enumeration: 'UNAVAILABLE' } });
  expect(h.entry.quiesced).toBe(true);
});

it('restores the guardian process fact from the record when retention had to synthesize the report', async () => {
  const h = noProgressJournalFixture(false, 'UNKNOWN'), reports: unknown[] = [];
  // A restart between the forced termination and the flush: no page, and no report either.
  expect(h.entry.report).toBeUndefined();
  maintainActionJournal(h.runtime, h.journal, h.save);
  expect(h.entry.collection_redaction?.reason).toBe('RETENTION_EXPIRED');
  expect(h.entry.report).toMatchObject({ outcome: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS', guardian: { process_tree: 'UNKNOWN' } });
  const api = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    if (endpoint.endsWith('/status')) return { state: 'CLAIMED', action_state: 'SUBMITTING' } as T;
    if (endpoint === 'action-reports') { reports.push(structuredClone(data)); return { accepted: true } as T; }
    expect(data).toEqual(h.proof); return {} as T;
  };
  expect(await flushActionJournal(h.runtime, h.journal, h.save, api)).toBe(true);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ outcome: 'BLOCKED', error_code: 'GUARDIAN_NO_PROGRESS', guardian: { process_tree: 'UNKNOWN', tool: 'ERROR' } });
});

it('invents no process fact for a record that proves the context was closed', async () => {
  const h = collectionJournalFixture();
  h.entry.collection_expires_at = new Date(0).toISOString();
  maintainActionJournal(h.runtime, h.journal, h.save);
  expect(h.entry.report).toMatchObject({ outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED' });
  expect(h.entry.report).not.toHaveProperty('guardian');
  expect(h.entry.report).not.toHaveProperty('process_tree');
  expect(h.entry.quiesced).toBeUndefined();
});
