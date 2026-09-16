import { randomUUID } from 'node:crypto';
import type { ActionReport, ActionState } from '@kff/contracts';
import { AppError, digest } from '@kff/core';
import { closureProof, compactClosure, readClosureEvidence } from './guardian-protocol';

export interface JournalEntry {
  command_id: string; action_id: string; phase: string; guardian_nonce?: string; guardian_pid?: number;
  report?: ActionReport; acknowledged?: boolean; quarantined?: boolean; quiesced?: boolean;
  // Legacy field name shared by collection and Inbox page journals.
  collection_expires_at?: string;
  collection_redaction?: { reason: 'DELIVERED' | 'RETENTION_EXPIRED'; at: string; report_event_id?: string; report_sha256?: string };
}
type Journal = Record<string, JournalEntry>;
type Controller = <T>(endpoint: string, data?: unknown) => Promise<T>;

/** Entirely local: a failed controller heartbeat must never postpone retention cleanup. */
export function maintainActionJournal(runtime: string, journal: Journal, save: () => void, now = Date.now()) {
  for (const entry of Object.values(journal)) {
    if (!entry.collection_expires_at && !entry.report?.collection_page && !entry.report?.inbox_page && !entry.collection_redaction) continue;
    const delivered = Boolean(entry.quiesced && (entry.acknowledged || entry.quarantined));
    // Legacy collection journals have no pinned expiry. Do not extend their retention on restart.
    const expired = !entry.collection_expires_at || !(Date.parse(entry.collection_expires_at) > now);
    if (!delivered && !expired && !entry.collection_redaction) continue;
    if (!entry.collection_redaction) {
      entry.collection_redaction = { reason: delivered ? 'DELIVERED' : 'RETENTION_EXPIRED', at: new Date(now).toISOString(),
        ...(entry.report ? { report_event_id: entry.report.event_id, report_sha256: digest(entry.report) } : {}) };
      if (delivered) delete entry.report;
      else entry.report = { event_id: randomUUID(), command_id: entry.command_id, outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED', diagnostic: { step: 'collection-retention-expired' } };
      // Persist the redaction intent before replacing the closure. Either crash point is resumed locally.
      save();
    }
    if (delivered && entry.report) { delete entry.report; save(); }
    compactClosure(runtime, entry, entry.collection_redaction.reason, now);
  }
}

export async function flushActionJournal(runtime: string, journal: Journal, save: () => void, api: Controller) {
  maintainActionJournal(runtime, journal, save);
  for (const entry of Object.values(journal).filter(value => !value.quiesced)) {
    const closure = readClosureEvidence(runtime, entry);
    // Absence of a proof still blocks new work, including after the raw page expires.
    if (!closure) return false;
    try {
      if (entry.acknowledged || entry.quarantined) {
        await api('commands/' + entry.command_id + '/quiescence', closureProof(closure)); entry.quiesced = true; save();
        maintainActionJournal(runtime, journal, save); continue;
      }
      // After expiry, first resolve a possibly lost acknowledgement of the original event.
      if (!entry.report || entry.collection_redaction) {
        const status = await api<{ state: string; action_state: ActionState }>('commands/' + entry.command_id + '/status');
        if (!['READY', 'CLAIMED'].includes(status.state)) { entry.quarantined = true; save(); continue; }
        if (!entry.report) {
          if (!('result' in closure)) throw new AppError('GUARDIAN_UNCONFIRMED', '原始回执已经清理，缺少可发送的终止回执');
          const result = { ...closure.result };
          if (['SUBMITTING', 'SUBMITTED'].includes(status.action_state) && result.outcome !== 'VERIFIED_SUCCEEDED') result.outcome = 'UNKNOWN_OUTCOME';
          entry.report = { ...result, event_id: randomUUID(), command_id: entry.command_id }; save();
        }
      }
      const wasRedacted = Boolean(entry.collection_redaction);
      maintainActionJournal(runtime, journal, save);
      if (!wasRedacted && entry.collection_redaction) return false;
      await api('action-reports', entry.report); entry.acknowledged = true; save();
      await api('commands/' + entry.command_id + '/quiescence', closureProof(closure)); entry.quiesced = true; save();
      maintainActionJournal(runtime, journal, save);
    } catch (error) {
      if (error instanceof AppError && ['LEASE_STALE', 'VERSION_CONFLICT'].includes(error.code)) { entry.quarantined = true; save(); }
      else throw error;
    }
  }
  return Object.values(journal).every(entry => entry.quiesced);
}
