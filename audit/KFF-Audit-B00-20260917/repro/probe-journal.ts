/**
 * B00 — read the machine's real agent journal and report its shape.
 * Read-only: opens the journal, never writes to it.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/17731/Desktop/KFF';
const journalFile = path.join(ROOT, '.kff/agent/journal.json');
const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as Record<string, Record<string, unknown>>;

const entries = Object.entries(journal);
const phases: Record<string, number> = {};
const summary = entries.map(([id, e]) => {
  const phase = String(e.phase ?? 'unknown');
  phases[phase] = (phases[phase] ?? 0) + 1;
  return {
    command_id: id,
    action_id: e.action_id,
    phase,
    guardian_pid: e.guardian_pid ?? null,
    has_nonce: Boolean(e.guardian_nonce),
    acknowledged: Boolean(e.acknowledged),
    quarantined: Boolean(e.quarantined),
    quiesced: Boolean(e.quiesced),
    outcome: (e.report as { outcome?: string } | undefined)?.outcome ?? null,
    error_code: (e.report as { error_code?: string } | undefined)?.error_code ?? null,
    collection_expires_at: e.collection_expires_at ?? null,
    has_redaction: Boolean(e.collection_redaction),
  };
});

// Which closure files actually exist on disk for these commands, and of which kind.
const closuresDir = path.join(ROOT, '.kff/agent/closures');
const closures = existsSync(closuresDir) ? readdirSync(closuresDir) : [];
const closureKinds: Record<string, number> = {};
const closureDetail: { file: string; protocol: string; context_opened: unknown; context_closed: unknown; command_id: string }[] = [];
for (const file of closures) {
  if (!file.endsWith('.json')) continue;
  try {
    const record = JSON.parse(readFileSync(path.join(closuresDir, file), 'utf8')) as Record<string, unknown>;
    const protocol = String(record.protocol_version ?? 'unknown');
    closureKinds[protocol] = (closureKinds[protocol] ?? 0) + 1;
    closureDetail.push({ file, protocol, context_opened: record.context_opened ?? null, context_closed: record.context_closed ?? null, command_id: String(record.command_id ?? '') });
  } catch { closureKinds.unreadable = (closureKinds.unreadable ?? 0) + 1; }
}

// A command is "stranded" when it has no closure evidence and never reached a terminal ack.
const closureCommandIds = new Set(closureDetail.map(c => c.command_id));
const stranded = summary.filter(s => !s.quiesced);

console.log(JSON.stringify({
  probe: 'journal',
  journal_path: journalFile,
  entry_count: entries.length,
  phase_histogram: phases,
  closures_dir: closuresDir,
  closure_file_count: closures.length,
  closure_protocol_histogram: closureKinds,
  startup_failure_records: closureDetail.filter(c => c.protocol.includes('startup-failed')),
  stranded_entries: stranded,
  stranded_count: stranded.length,
  entries_without_closure_record: stranded.map(s => ({ command_id: s.command_id, has_closure: closureCommandIds.has(s.command_id), phase: s.phase })),
}, null, 2));
