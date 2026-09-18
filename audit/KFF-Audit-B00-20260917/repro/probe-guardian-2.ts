/**
 * B00 follow-up probe — two precise boundaries left open by probe-guardian.ts:
 *
 *  1. What `readClosure` does with a startup-failure record BEFORE compaction (probe 1 only
 *     measured the post-compaction state, because it compacted first).
 *  2. Whether `maintainActionJournal` can compact a startup failure at all. It only touches
 *     entries that carry `collection_expires_at` or a collection/inbox page. main.ts sets
 *     `collection_expires_at` only for collection/inbox commands, so the reachability of the
 *     "never opened becomes context_closed:true" path depends on the command kind. This probe
 *     runs both kinds through the shipped function.
 *
 * Read-only with respect to the KFF checkout; all files live under this audit folder.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO = 'C:/Users/17731/Desktop/KFF';

const proto = (await import(`file:///${REPO}/apps/agent/src/guardian-protocol.ts`)) as unknown as {
  readClosure: (runtime: string, entry: unknown) => unknown;
  readClosureEvidence: (runtime: string, entry: unknown) => unknown;
  saveStartupFailure: (runtime: string, value: unknown) => unknown;
};
const journalMod = (await import(`file:///${REPO}/apps/agent/src/action-journal.ts`)) as unknown as {
  maintainActionJournal: (runtime: string, journal: Record<string, unknown>, save: () => void, now?: number) => void;
};

const workRoot = mkdtempSync(path.join(tmpdir(), 'kff-b00-guardian2-'));
const closureFile = (runtime: string, id: string) => path.join(runtime, 'agent', 'closures', id + '.json');

function freshRuntime(name: string) {
  const runtime = path.join(workRoot, name);
  mkdirSync(path.join(runtime, 'agent', 'closures'), { recursive: true });
  return runtime;
}

// ---------------------------------------------------------------- 1. read semantics
const runtime1 = freshRuntime('read-semantics');
const cmd1 = randomUUID(), act1 = randomUUID(), nonce1 = 'c'.repeat(64);
proto.saveStartupFailure(runtime1, {
  command_id: cmd1, action_id: act1, nonce: nonce1,
  result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } },
});
const entry1 = { command_id: cmd1, action_id: act1, guardian_nonce: nonce1 };
let readClosureBefore: unknown;
try { readClosureBefore = { returned: proto.readClosure(runtime1, entry1) }; }
catch (error) { readClosureBefore = { threw: (error as { code?: string }).code ?? String(error) }; }
const evidenceBefore = proto.readClosureEvidence(runtime1, entry1) as { protocol_version?: string; context_opened?: unknown };

// ---------------------------------------------------------------- 2. compaction reachability
// Message-shaped entry: main.ts leaves collection_expires_at undefined for these.
const runtime2 = freshRuntime('message-command');
const cmd2 = randomUUID(), act2 = randomUUID(), nonce2 = 'd'.repeat(64);
proto.saveStartupFailure(runtime2, {
  command_id: cmd2, action_id: act2, nonce: nonce2,
  result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } },
});
// A later report carrying no collection/inbox page, which is what a real message report looks like.
const messageJournal: Record<string, unknown> = {
  [cmd2]: { command_id: cmd2, action_id: act2, phase: 'claimed', guardian_nonce: nonce2,
    report: { event_id: randomUUID(), command_id: cmd2, outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } } },
};
journalMod.maintainActionJournal(runtime2, messageJournal, () => {}, Date.now() + 86400000);
const messageAfter = JSON.parse(readFileSync(closureFile(runtime2, cmd2), 'utf8')) as Record<string, unknown>;

// Collection-shaped entry: main.ts pins collection_expires_at for these.
const runtime3 = freshRuntime('collection-command');
const cmd3 = randomUUID(), act3 = randomUUID(), nonce3 = 'e'.repeat(64);
proto.saveStartupFailure(runtime3, {
  command_id: cmd3, action_id: act3, nonce: nonce3,
  result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' } },
});
const past = new Date(Date.now() - 60000).toISOString();
const collectionJournal: Record<string, unknown> = {
  [cmd3]: { command_id: cmd3, action_id: act3, phase: 'claimed', guardian_nonce: nonce3, collection_expires_at: past,
    report: { event_id: randomUUID(), command_id: cmd3, outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED', diagnostic: { step: 'guardian-startup-failed' }, collection_page: { url: 'about:blank' } } },
};
journalMod.maintainActionJournal(runtime3, collectionJournal, () => {}, Date.now());
const collectionAfter = JSON.parse(readFileSync(closureFile(runtime3, cmd3), 'utf8')) as Record<string, unknown>;

try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* leave for inspection */ }

console.log(JSON.stringify({
  probe: 'guardian-2',
  read_semantics_before_compaction: {
    closure_protocol_on_disk: evidenceBefore.protocol_version,
    context_opened_on_disk: evidenceBefore.context_opened,
    readClosure_result: readClosureBefore,
  },
  compaction_reachability: {
    message_command: {
      reached_compaction: messageAfter.protocol_version === 'kff.guardian-closure-compact.v1',
      protocol_on_disk_after: messageAfter.protocol_version,
      context_closed_after: messageAfter.context_closed ?? null,
    },
    collection_command: {
      reached_compaction: collectionAfter.protocol_version === 'kff.guardian-closure-compact.v1',
      protocol_on_disk_after: collectionAfter.protocol_version,
      context_closed_after: collectionAfter.context_closed ?? null,
      reason: collectionAfter.reason ?? null,
    },
  },
}, null, 2));
