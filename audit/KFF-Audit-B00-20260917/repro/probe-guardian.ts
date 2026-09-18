/**
 * B00 independent verification probe — Guardian startup-failure evidence.
 *
 * Fault injection through the REAL product path: it calls the real `runGuardian` from
 * apps/agent/src/guardian.ts and makes the real `child_process.spawn` fail with a real
 * ENOENT from libuv, by pointing the *process working directory* at a path that does not
 * exist. guardian.ts spawns with `cwd: process.cwd()`, so this needs no patching of the
 * module and no second execution system: the spawn call, the event wiring and the closure
 * writers under test are the shipped ones.
 *
 * Nothing is written inside the KFF checkout. Runtime dirs live under this audit folder.
 * No database, no network, no browser, no real platform.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const REPO = 'C:/Users/17731/Desktop/KFF';
const realCwd = process.cwd();

const guardian = (await import(`file:///${REPO}/apps/agent/src/guardian.ts`)) as unknown as {
  runGuardian: (command: unknown, runtime: string, nonce: string, hooks: unknown) => Promise<unknown>;
};
const journalMod = (await import(`file:///${REPO}/apps/agent/src/action-journal.ts`)) as unknown as {
  flushActionJournal: (runtime: string, journal: Record<string, unknown>, save: () => void, api: unknown) => Promise<boolean>;
};

const results: Record<string, unknown> = {};
const workRoot = mkdtempSync(path.join(tmpdir(), 'kff-b00-guardian-'));

function closurePath(runtime: string, commandId: string) {
  return path.join(runtime, 'agent', 'closures', commandId + '.json');
}

// ---------------------------------------------------------------- Experiment 1
// What events does Node actually emit when spawn's cwd does not exist?
// Uses the same option shape guardian.ts uses (detached on win32, ipc stdio).
async function observeSpawnEvents(): Promise<Record<string, unknown>> {
  const events: string[] = [];
  const missing = path.join(tmpdir(), 'kff-b00-does-not-exist-' + randomUUID());
  const child = spawn(process.execPath, ['--version'], {
    cwd: missing,
    windowsHide: true,
    detached: process.platform === 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; setTimeout(resolve, 250); } };
    child.once('error', error => { events.push('error:' + (error as NodeJS.ErrnoException).code); finish(); });
    child.once('exit', code => { events.push('exit:' + String(code)); finish(); });
    child.once('close', code => { events.push('close:' + String(code)); finish(); });
    setTimeout(finish, 5000);
  });
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  return { events, cwd_used: missing, exit_event_emitted: events.some(e => e.startsWith('exit')) };
}

// ---------------------------------------------------------------- Experiment 2
// Drive the REAL runGuardian until the REAL spawn fails, then ask the shipped evidence
// writers what they recorded.
async function guardianErroredSpawn(): Promise<Record<string, unknown>> {
  const runtime = path.join(workRoot, 'exp2');
  mkdirSync(runtime, { recursive: true });
  const commandId = randomUUID();
  const actionId = randomUUID();
  const nonce = 'a'.repeat(64);
  const command = { id: commandId, action_id: actionId, snapshot: {}, expires_at: new Date(Date.now() + 60000).toISOString() };

  let rejectedWith: Record<string, unknown> | null = null;
  // guardian.ts spawns with `cwd: process.cwd()`. Point that at a path that does not exist.
  const missingCwd = path.join(tmpdir(), 'kff-b00-missing-cwd-' + randomUUID());
  (process as unknown as { cwd: () => string }).cwd = () => missingCwd;
  try {
    await guardian.runGuardian(command, runtime, nonce, {
      beforeSubmit: async () => {},
      signal: new AbortController().signal,
      onSpawn: () => {},
      onContextOpened: async () => {},
    });
  } catch (error) {
    const e = error as { code?: string; name?: string; message?: string };
    rejectedWith = { code: e.code ?? null, name: e.name ?? null, message: String(e.message ?? '').slice(0, 200) };
  } finally {
    (process as unknown as { cwd: () => string }).cwd = () => realCwd;
  }

  const file = closurePath(runtime, commandId);
  const evidenceExists = existsSync(file);
  // Whatever happened, ask the shipped flusher whether this command can ever be closed.
  const journal: Record<string, unknown> = {
    [commandId]: { command_id: commandId, action_id: actionId, phase: 'claimed', guardian_nonce: nonce },
  };
  let flushResult: unknown;
  let flushThrew: string | null = null;
  const calls: string[] = [];
  const fakeApi = async (endpoint: string) => { calls.push(endpoint); return { state: 'DONE', action_state: 'CANCELED' }; };
  try {
    flushResult = await journalMod.flushActionJournal(runtime, journal, () => {}, fakeApi);
  } catch (error) {
    flushThrew = String((error as Error).message ?? error).slice(0, 200);
  }

  return {
    injected_failure: 'spawn cwd does not exist (real ENOENT from libuv)',
    caller_rejected_with: rejectedWith,
    startup_failure_record_written: evidenceExists,
    record_contents: evidenceExists ? JSON.parse(readFileSync(file, 'utf8')) : null,
    journal_after: journal[commandId],
    flushActionJournal_result: flushResult,
    flushActionJournal_threw: flushThrew,
    controller_calls_made: calls,
  };
}

// ---------------------------------------------------------------- Experiment 3
// The first-party fault switch the code ships for this exact case. It proves the intended
// path works, so Experiment 2 isolates a genuine divergence rather than a broken harness.
async function intendedFaultSwitch(): Promise<Record<string, unknown>> {
  const root = path.join(workRoot, 'root');
  const runtime = path.join(root, '.kff', 'agent-process-tests', 'exp3');
  mkdirSync(runtime, { recursive: true });
  const commandId = randomUUID();
  const actionId = randomUUID();
  const nonce = 'b'.repeat(64);
  const command = { id: commandId, action_id: actionId, snapshot: {}, expires_at: new Date(Date.now() + 60000).toISOString() };

  process.env.NODE_ENV = 'test';
  process.env.KFF_ROOT = root;
  process.env.KFF_TEST_GUARDIAN_DIES_BEFORE_READY = 'true';
  const { guardianStartupFaultInjectionEnabled } = guardian as unknown as {
    guardianStartupFaultInjectionEnabled?: (r: string) => boolean;
  };
  const switchOn = typeof guardianStartupFaultInjectionEnabled === 'function'
    ? guardianStartupFaultInjectionEnabled(runtime) : null;

  let rejectedWith: Record<string, unknown> | null = null;
  try {
    await guardian.runGuardian(command, runtime, nonce, {
      beforeSubmit: async () => {},
      signal: new AbortController().signal,
      onSpawn: () => {},
      onContextOpened: async () => {},
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    rejectedWith = { code: e.code ?? null, message: String(e.message ?? '').slice(0, 200) };
  }
  const file = closurePath(runtime, commandId);
  const exists = existsSync(file);
  delete process.env.KFF_TEST_GUARDIAN_DIES_BEFORE_READY;
  delete process.env.KFF_ROOT;
  delete process.env.NODE_ENV;
  return {
    fault_switch_active: switchOn,
    caller_rejected_with: rejectedWith,
    startup_failure_record_written: exists,
    record_contents: exists ? JSON.parse(readFileSync(file, 'utf8')) : null,
  };
}

// ---------------------------------------------------------------- Experiment 4
// Does closureProof launder a startup-failure record into the ordinary closure protocol,
// and does compactClosure turn "never opened" into context_closed:true?
async function evidenceSemantics(startupRecord: unknown): Promise<Record<string, unknown>> {
  const proto = (await import(`file:///${REPO}/apps/agent/src/guardian-protocol.ts`)) as unknown as {
    closureProof: (r: unknown) => Record<string, unknown>;
    compactClosure: (runtime: string, entry: unknown, reason: string, now: number) => Record<string, unknown> | null;
    readClosure: (runtime: string, entry: unknown) => unknown;
  };
  const proof = proto.closureProof(startupRecord);
  const runtime = path.join(workRoot, 'exp4');
  mkdirSync(path.join(runtime, 'agent', 'closures'), { recursive: true });
  const rec = startupRecord as { command_id: string; action_id: string; nonce: string };
  writeFileSync(closurePath(runtime, rec.command_id), JSON.stringify(startupRecord), { mode: 0o600 });
  const entry = { command_id: rec.command_id, action_id: rec.action_id, guardian_nonce: rec.nonce };
  const compacted = proto.compactClosure(runtime, entry, 'DELIVERED', Date.now());
  let readClosureOutcome: unknown;
  try { readClosureOutcome = { returned: proto.readClosure(runtime, entry) }; }
  catch (error) { readClosureOutcome = { threw: (error as { code?: string }).code ?? String(error) }; }
  return {
    startup_record_protocol: (startupRecord as { protocol_version?: string }).protocol_version,
    startup_record_context_opened: (startupRecord as { context_opened?: unknown }).context_opened,
    closureProof_for_startup_failure: proof,
    compacted_from_startup_failure: compacted,
    readClosure_on_startup_failure: readClosureOutcome,
  };
}

results.spawn_event_observation = await observeSpawnEvents();
results.guardian_real_spawn_error = await guardianErroredSpawn();
results.guardian_intended_fault_switch = await intendedFaultSwitch();

const startupRecord = (results.guardian_intended_fault_switch as { record_contents?: unknown }).record_contents
  ?? (results.guardian_real_spawn_error as { record_contents?: unknown }).record_contents;
results.evidence_semantics = startupRecord
  ? await evidenceSemantics(startupRecord)
  : { note: 'no startup-failure record was produced by either path, so the semantics question is moot here' };

try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* leave for inspection */ }

console.log(JSON.stringify({ probe: 'guardian', repo: REPO, ...results }, null, 2));
