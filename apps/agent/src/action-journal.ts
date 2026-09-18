import { randomUUID } from 'node:crypto';
import type { ActionReport, ActionState } from '@kff/contracts';
import { AppError, digest } from '@kff/core';
import { closureProof, compactClosure, noProgressProtocolVersion, readClosureEvidence, type ClosureEvidence } from './guardian-protocol';

export interface JournalEntry {
  command_id: string; action_id: string; phase: string; guardian_nonce?: string; guardian_pid?: number;
  report?: ActionReport; acknowledged?: boolean; quarantined?: boolean; quiesced?: boolean;
  // Legacy field name shared by collection and Inbox page journals.
  collection_expires_at?: string;
  collection_redaction?: { reason: 'DELIVERED' | 'RETENTION_EXPIRED'; at: string; report_event_id?: string; report_sha256?: string };
}
type Journal = Record<string, JournalEntry>;
type Controller = <T>(endpoint: string, data?: unknown) => Promise<T>;
/**
 * The part of a report that states a safety fact rather than a business result, carried across a
 * retention redaction. It is read from the closure record rather than from the report, because the
 * record is the authority on both facts and because the two are not always present together: retention
 * also synthesizes a report for an entry that never received one - a restart after the page expired -
 * and the record is then the only place the fact exists.
 *
 * The list is deliberately explicit: anything not named here is business state that retention owns and
 * may replace, so adding a field means deciding, once, which half it belongs to.
 */
function retainedSafety(record: ClosureEvidence | null) {
  const guardian = record && 'termination' in record ? record.termination : undefined;
  return {
    ...(guardian ? { guardian } : {}),
    ...(record?.protocol_version === noProgressProtocolVersion ? { error_code: 'GUARDIAN_NO_PROGRESS' as const } : {}),
  };
}

/** Entirely local: a failed controller heartbeat must never postpone retention cleanup. */
export function maintainActionJournal(runtime: string, journal: Journal, save: () => void, now = Date.now()) {
  for (const entry of Object.values(journal)) {
    if (!entry.collection_expires_at && !entry.report?.collection_page && !entry.report?.inbox_page && !entry.collection_redaction) continue;
    const delivered = Boolean(entry.quiesced && (entry.acknowledged || entry.quarantined));
    // Legacy collection journals have no pinned expiry. Do not extend their retention on restart.
    const expired = !entry.collection_expires_at || !(Date.parse(entry.collection_expires_at) > now);
    if (!delivered && !expired && !entry.collection_redaction) continue;
    if (!entry.collection_redaction) {
      // Read before anything is mutated: a record that cannot be trusted has to stop the redaction
      // outright rather than leave a half-applied one behind.
      const safety = retainedSafety(delivered ? null : readClosureEvidence(runtime, entry));
      entry.collection_redaction = { reason: delivered ? 'DELIVERED' : 'RETENTION_EXPIRED', at: new Date(now).toISOString(),
        ...(entry.report ? { report_event_id: entry.report.event_id, report_sha256: digest(entry.report) } : {}) };
      if (delivered) delete entry.report;
      // Retention owns the page payload and the terminal outcome, and nothing else. The safety facts
      // come from the record, so replacing the report - as this used to do wholesale - can no longer
      // turn "the guardian never proved this browser closed" into "the page expired, nothing was at
      // risk", which is how a quarantined environment became an idle one the moment its payload
      // expired. This holds for the entry that never received a report at all, which is the same
      // restart more than one page length later.
      else entry.report = { event_id: randomUUID(), command_id: entry.command_id, outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED', diagnostic: { step: 'collection-retention-expired' }, ...safety };
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
          // The process fact travels with the report whenever there is one. The receiver has to decide
          // whether an execution slot may be freed, and it cannot make that decision from an outcome
          // string alone: "the command stopped" and "the tree is dead" are different facts, and only
          // the second one licenses reuse.
          const result = { ...closure.result, ...('termination' in closure && closure.termination ? { guardian: closure.termination } : {}) };
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
