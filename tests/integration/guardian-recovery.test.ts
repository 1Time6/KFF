import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { startFixtureServer } from '../../scripts/fixture-server';
import { closePool, query } from '@kff/database';
import { AppError } from '@kff/core';
import { heartbeatInput, quiescenceInput, resultInput, uuid } from '@kff/contracts';
import { acceptReport, agentHeartbeat, authenticateAgent, beginSubmission, claimCommand, commandStatus, dispatchOne, recordBrowserOpened } from '../../packages/core/src/execution';
import { claimEnvironmentCommand } from '../../packages/core/src/environments';
import { recordQuiescence } from '../../packages/core/src/reconciliation';
import { createAgent } from '../../packages/core/src/controls';
import { configureFacebook, createFacebookFixture } from '../../packages/core/src/facebook-inbound';
import { configureBrowserInbox, controlBrowserInbox, prepareBrowserInboxPage, syncBrowserInboxTasks } from '../../packages/core/src/browser-inbox';
import { localSupervisionProtocol } from '../../packages/contracts/src/local-supervision';
import { closureProof, readClosureEvidence, startupFailedProtocolVersion, type GuardianClosure } from '../../apps/agent/src/guardian-protocol';
import { isProcessAlive } from '../../apps/agent/src/process-tree';
import type { JournalEntry } from '../../apps/agent/src/action-journal';
import { browserInboxSetup } from '../helpers/browser-inbox';
import { clearLeads, leadScope as scope } from '../helpers/lead-fixture';

// The real runtime root the user's own Agent runs from. Nothing in this file may write to it, so its
// state is captured first and compared last. KFF-B00-015.
const userRuntime = path.resolve('.kff/agent');
const snapshotOf = (file: string) => (existsSync(file) ? String(statSync(file).mtimeMs) + ':' + String(statSync(file).size) : 'absent');
let userRuntimeBefore: Record<string, string> = {};

// Every root this file creates is registered here so the run leaves nothing behind. Each one is
// checked against the prefix and its parent before removal, so the cleanup can only ever delete a
// directory this test itself created under the operating system's temporary directory.
const roots: string[] = [];
beforeAll(async () => {
  const database = (await query('SELECT current_database() AS name'))[0].name;
  if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Refusing non-isolated database');
  userRuntimeBefore = { journal: snapshotOf(path.join(userRuntime, 'journal.json')), lock: snapshotOf(path.join(userRuntime, 'process.lock')) };
  await migrate(); await seed();
});
beforeEach(clearLeads);
afterAll(async () => {
  // The Agent under test kept its journal, lock and browser profiles inside its own temporary root.
  expect({ journal: snapshotOf(path.join(userRuntime, 'journal.json')), lock: snapshotOf(path.join(userRuntime, 'process.lock')) }).toEqual(userRuntimeBefore);
  await closePool();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b01-recovery-')) throw new Error('Unexpected test directory');
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a browser that outlived the kill keeps a handle; the directory is still our own temp root */ }
  }
});

const kill = async (child?: ChildProcess) => { if (child && child.exitCode === null && child.signalCode === null) { const gone = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await gone; } };
const journalOf = async (root: string) => JSON.parse(await readFile(path.join(root, '.kff/agent/journal.json'), 'utf8')) as Record<string, JournalEntry>;
/**
 * Every live process whose command line names this test's runtime *directory*. A browser the guardian
 * launched is started with its profile directory there, so this answers "is anything the guardian
 * started still running" from the running system instead of inferring it from a successful kill. The
 * needle is the runtime directory rather than the root, because the Agent under test is itself started
 * from a copy of the interpreter inside the root and is supposed to still be running.
 */
function processesUnder(root: string): number[] {
  const needle = path.join(root, '.kff');
  const windows = process.platform === 'win32';
  const probe = windows
    ? spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*" + needle + "*' } | Select-Object -ExpandProperty ProcessId"], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', windowsHide: true });
  const raw = String(probe.stdout ?? '');
  const lines: string[] = windows ? [raw] : raw.split('\n').filter((line: string) => line.includes(needle) && !line.includes('ps -eo'));
  return lines.join('\n').split(/\s+/).filter((value: string) => /^\d+$/.test(value)).map(Number).filter((pid: number) => pid !== process.pid);
}
/** A failure here has to say what survived, not only its pid, or the next reader learns nothing. */
function describeProcesses(pids: number[]): string[] {
  return pids.map(pid => {
    const probe = spawnSync('powershell', ['-NoProfile', '-Command', "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; if ($p) { $p.Name + ' | ' + $p.CommandLine }"], { encoding: 'utf8', windowsHide: true });
    return String(probe.stdout ?? '').trim().slice(0, 400) || String(pid);
  });
}
/** The kill is not finished when the call returns, so the system is asked until it agrees. */
async function nothingLeftRunning(root: string, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let found = processesUnder(root);
  while (found.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1000)); found = processesUnder(root); }
  return found;
}

/**
 * The whole flow runs against a throwaway runtime root under the operating system's temporary
 * directory and an isolated test database. The Agent is launched from a *copy* of the running node
 * binary, so the test can make that binary unresolvable and turn the production `spawn` inside
 * `runGuardian` into a genuine libuv ENOENT - the exact event combination KFF-B00-002 is about - and
 * restore it afterwards for the next command. No production code is replaced or simulated: the real
 * `apps/agent/src/main.ts` process fails, records and recovers on its own.
 */
async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kff-b01-recovery-'));
  roots.push(root);
  await mkdir(path.join(root, '.kff'));
  const fixture = await startFixtureServer(0, path.join(root, 'fixture'));
  const seen: string[] = [], claimed: string[] = [], reported: string[] = [], errors: string[] = [], logs: string[] = [];
  let hold = false;
  const server = createServer(async (request, response) => {
    try {
      const agent = await authenticateAgent(new Request('http://127.0.0.1' + request.url, { headers: { authorization: request.headers.authorization ?? '' } }));
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw || '{}'), endpoint = request.url?.replace('/api/agent/', ''), match = /^commands\/([^/]+)\/(status|submit|context-opened|quiescence)$/.exec(endpoint ?? '');
      seen.push(endpoint ?? '');
      let result: unknown;
      if (endpoint === 'heartbeats') result = await agentHeartbeat(agent, heartbeatInput.parse(body).command_id);
      else if (endpoint === 'environment-claims') result = { command: await claimEnvironmentCommand(agent) };
      else if (endpoint === 'claims') { const command = await claimCommand(agent); if (command) claimed.push(command.id); result = { command }; }
      else if (endpoint === 'action-reports') { const report = resultInput.parse(body); result = await acceptReport(agent, report); reported.push(report.command_id); if (hold) { request.socket.destroy(); return; } }
      else if (match) { const id = uuid.parse(match[1]); if (match[2] === 'status') result = await commandStatus(agent, id); if (match[2] === 'submit') result = await beginSubmission(agent, id); if (match[2] === 'context-opened') result = await recordBrowserOpened(agent, id); if (match[2] === 'quiescence') result = await recordQuiescence(agent, id, quiescenceInput.parse(body)); }
      else throw new Error('Unexpected endpoint');
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Bridge failed'); response.writeHead(error instanceof AppError ? error.status : 500).end(JSON.stringify({ error: { code: 'TEST_ERROR' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  /**
   * A gate in front of the synthetic origin. While it is open the browser under test cannot tell the
   * difference; while it is closed the connection is accepted and never answered, which is a real
   * stall inside the executor's own navigation rather than a simulated one. It is what lets this file
   * produce a guardian that is alive, is making no progress, and says nothing about it.
   */
  let gateOpen = true;
  const gate = createServer((incoming, outgoing) => {
    if (!gateOpen) return;
    const upstream = httpRequest({ host: '127.0.0.1', port: Number(new URL(fixture.origin).port), path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => gate.listen(0, '127.0.0.1', resolve));
  const gateOrigin = 'http://127.0.0.1:' + (gate.address() as { port: number }).port;
  const executable = path.join(root, 'node-copy.exe'), hidden = path.join(root, 'node-hidden.exe');
  copyFileSync(process.execPath, executable);
  let child: ChildProcess | undefined;
  const launch = (options: { origin?: string; env?: Record<string, string> } = {}) => {
    const states: string[] = [];
    const spawned = spawn(executable, ['--import', 'tsx', 'apps/agent/src/main.ts'], { cwd: process.cwd(), env: { ...process.env, KFF_ROOT: root, KFF_ENABLE_LIVE: 'false', KFF_BROWSER_INBOX_FIXTURE_ORIGIN: options.origin ?? fixture.origin, ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    spawned.stdout?.on('data', chunk => logs.push(String(chunk)));
    spawned.stderr?.on('data', chunk => logs.push(String(chunk)));
    spawned.on('message', message => { if (typeof message === 'object' && message && 'protocol' in message && message.protocol === localSupervisionProtocol && 'state' in message) states.push(String(message.state)); });
    return { children: spawned, states };
  };
  const close = async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    gate.closeAllConnections(); await new Promise<void>(resolve => gate.close(() => resolve()));
    await fixture.close();
  };
  return {
    root, fixture, origin, gateOrigin, seen, claimed, reported, errors, logs, launch, close,
    get child() { return child; }, set child(value: ChildProcess | undefined) { child = value; },
    hideExecutable: () => renameSync(executable, hidden), restoreExecutable: () => renameSync(hidden, executable),
    release: () => { hold = false; }, withhold: () => { hold = true; },
    closeGate: () => { gateOpen = false; }, openGate: () => { gateOpen = true; },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
/** Queues a browser-inbox page through the real controller so the Agent receives a real command. */
async function inboxBinding(h: Harness) {
  const { writeFile } = await import('node:fs/promises');
  const paired = await createAgent(scope, { name: 'Guardian recovery supervisor' });
  await writeFile(path.join(h.root, '.kff/agent-config.json'), JSON.stringify({ ...paired.configuration, controller_origin: h.origin }));
  const account = await createFacebookFixture(scope, { request_id: randomUUID(), name: 'Guardian recovery fixture', page_id: BigInt('0x' + randomUUID().replaceAll('-', '')).toString(), agent_id: paired.agent.id });
  const binding = await browserInboxSetup(scope, account);
  await configureFacebook(scope, { request_id: randomUUID(), ...account, expected_version: 0, transport: 'BROWSER', state: 'ACTIVE', auto_reply: false, reply_window_hours: 24, policy_ref: 'kff.browser-fixture.service-window.v1' });
  const page = binding.binding.environment.configuration.operating_identity_id;
  const monitor = await configureBrowserInbox(scope, { request_id: randomUUID(), environment_id: account.environment_id, expected_version: 0, page_size: 50, interval_seconds: 10, raw_retention_hours: 1 });
  return { paired, account, monitor, page, binding };
}
/**
 * Waits for a command to reach its terminal proof. When it does not, the failure names the exact
 * state it stopped in rather than reporting a bare timeout: a guardian child that stalls after
 * `start` emits no `error`, `exit` or `close`, so nothing ever settles it and the command stays
 * claimed. That is KFF-B01-NEW-01 and this is where it shows up.
 */
async function waitForProof(h: Harness, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await journalOf(h.root))[id]?.quiesced) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const entry = (await journalOf(h.root))[id];
  const row = (await query('SELECT state, quiesced_at FROM kff.agent_commands WHERE id=$1', [id]))[0];
  throw new Error('Command ' + id + ' reached no terminal proof in ' + timeoutMs + 'ms (KFF-B01-NEW-01). journal.phase=' + String(entry?.phase) + ' journal.guardian_pid=' + String(entry?.guardian_pid) + ' controller.state=' + String(row?.state) + ' controller.quiesced_at=' + String(row?.quiesced_at));
}
const publishInquiry = (h: Harness, page: string, thread: string, body: string) =>
  fetch(h.fixture.origin + '/browser-inbox/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: page, thread_id: thread, peer_id: '999888777666555', body, display_name: 'Synthetic recovery test' }) });
const drive = () => setInterval(() => { void (async () => { try { await syncBrowserInboxTasks(); await prepareBrowserInboxPage(); await dispatchOne(); } catch { /* the controller retries on its own schedule */ } })(); }, 250);

it('recovers a real pre-start spawn failure through the normal state machine and then really runs the next command', async () => {
  const h = await harness(); const { paired, monitor, page } = await inboxBinding(h);
  const timer = drive();
  try {
    const first = h.launch(); h.child = first.children;
    await expect.poll(() => first.states.includes('RUNNING'), { timeout: 20000 }).toBe(true);

    // Command 1. The child process can never be created, so `spawn` fails before anything else happens.
    h.hideExecutable();
    await publishInquiry(h, page, '000901', 'Recovery inquiry one');
    await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'SCAN' });
    await expect.poll(() => h.claimed.length, { timeout: 45000 }).toBeGreaterThan(0);
    const one = h.claimed[0];
    await expect.poll(async () => (await journalOf(h.root))[one]?.quiesced, { timeout: 60000 }).toBe(true);

    // The evidence is the parent's own record of a fact the never-sent `ready` already proves.
    const entry = (await journalOf(h.root))[one];
    expect(entry.phase).toBe('claimed'); expect(entry.guardian_pid).toBeUndefined(); expect(entry.quarantined).toBeUndefined();
    expect(readClosureEvidence(path.join(h.root, '.kff'), entry)).toMatchObject({ protocol_version: startupFailedProtocolVersion, context_opened: false, result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED' } });
    // No submission authority was ever requested, so no platform write can have happened.
    expect(h.seen.filter(endpoint => endpoint.includes(one))).toEqual(['commands/' + one + '/status', 'commands/' + one + '/quiescence']);
    expect(h.reported.filter(id => id === one)).toHaveLength(1);

    // Terminal evidence was accepted and the execution slot came back through the normal state machine.
    expect((await query('SELECT state FROM kff.agent_commands WHERE id=$1', [one]))[0].state).toBe('DONE');
    expect((await query('SELECT quiesced_at FROM kff.agent_commands WHERE id=$1', [one]))[0].quiesced_at).not.toBeNull();
    const action = (await query('SELECT id, state FROM kff.actions WHERE id=(SELECT action_id FROM kff.agent_commands WHERE id=$1)', [one]))[0];
    expect(action.state).toBe('CANCELED');
    expect((await query("SELECT count(*)::int AS n FROM kff.agent_commands WHERE agent_id=$1 AND state IN ('READY','CLAIMED')", [paired.agent.id]))[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [action.id]))[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=$1 AND event_type=\'action.reported\'', [action.id]))[0].n).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'", [one]))[0].n).toBe(1);
    // The retention pass runs over this entry a moment after it is released. It must not rewrite
    // "no context was opened" into a closed-context proof: the record on disk keeps its own version
    // and its own fact, even though the entry itself is redacted as delivered.
    await expect.poll(() => journalOf(h.root).then(current => current[one]?.collection_redaction?.reason), { timeout: 20000 }).toBe('DELIVERED');
    const startupRecord = readClosureEvidence(path.join(h.root, '.kff'), entry)!;
    expect(startupRecord.protocol_version).toBe(startupFailedProtocolVersion);
    expect(startupRecord).not.toHaveProperty('context_closed');
    // The monitor releases its page only once the command proves it closed, so the next page is the recovery proof.
    await expect.poll(async () => (await query('SELECT current_task_id FROM kff.browser_inbox_monitors WHERE id=$1', [monitor.id]))[0].current_task_id, { timeout: 20000 }).toBeNull();

    // Command 2. An independent legal command, queued only after the slot came back.
    h.restoreExecutable();
    await publishInquiry(h, page, '000902', 'Recovery inquiry two');
    const version = (await query('SELECT version FROM kff.browser_inbox_monitors WHERE id=$1', [monitor.id]))[0].version;
    await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: version, action: 'SCAN' });
    await expect.poll(() => h.claimed.length, { timeout: 90000 }).toBeGreaterThan(1);
    const two = h.claimed.find(id => id !== one)!;
    await waitForProof(h, two, 90000);

    // The second Agent really ran: a real terminal result, a real child, a real normal closure.
    const second = (await journalOf(h.root))[two];
    expect((await query('SELECT state FROM kff.actions WHERE id=(SELECT action_id FROM kff.agent_commands WHERE id=$1)', [two]))[0].state).toBe('VERIFIED_SUCCEEDED');
    expect((await query('SELECT state FROM kff.agent_commands WHERE id=$1', [two]))[0].state).toBe('DONE');
    expect((await query('SELECT quiesced_at FROM kff.agent_commands WHERE id=$1', [two]))[0].quiesced_at).not.toBeNull();
    // Retention redaction may have compacted the page result away, which never touches the closure fact.
    const closure = readClosureEvidence(path.join(h.root, '.kff'), second) as GuardianClosure;
    expect(closure.context_closed).toBe(true);
    expect(closureProof(closure).protocol_version).toBe('kff.guardian-closure.v1');
    expect(second.guardian_pid).toBeGreaterThan(0);
    expect(h.seen).toContain('commands/' + two + '/context-opened');

    // The first command was never executed again and never replayed a second receipt.
    expect(h.claimed.filter(id => id === one)).toHaveLength(1);
    expect(h.reported.filter(id => id === one)).toHaveLength(1);
    expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [action.id]))[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM kff.agent_commands WHERE agent_id=$1', [paired.agent.id]))[0].n).toBe(2);
    expect(h.errors).toEqual([]);
  } finally {
    clearInterval(timer); await kill(h.child); await h.close();
  }
}, 300000);

/**
 * KFF-B01-NEW-01, end to end. The guardian is alive, so nothing about it looks failed: it emits no
 * `error`, no `exit` and no `close`, and without a watchdog the promise `runGuardian` returned would
 * never settle, the journal would never flush, the command would stay claimed and the single
 * execution slot would never come back. The stall is real rather than simulated: the browser under
 * test is pointed at a gate this test controls, and the gate is closed, so the executor waits inside
 * its own navigation to a synthetic origin that accepted the connection and never answered.
 */
it('ends a real guardian stalled inside a real navigation and really runs the next command afterwards', async () => {
  const h = await harness(); const { paired, monitor, page } = await inboxBinding(h);
  const timer = drive();
  try {
    // The check that nothing survived the recovery is only worth reading if the check can see a
    // process at all, so it is shown a real one first: this interpreter runs with the runtime
    // directory on its own command line, exactly where a browser the guardian launched would carry it.
    const witness = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000)', path.join(h.root, '.kff')], { stdio: 'ignore', windowsHide: true });
    try {
      await expect.poll(() => processesUnder(h.root).includes(witness.pid!), { timeout: 20000 }).toBe(true);
    } finally { witness.kill('SIGKILL'); }
    await expect.poll(() => processesUnder(h.root).includes(witness.pid!), { timeout: 20000 }).toBe(false);

    // The phase under test gets a test-scale deadline through the documented override; every other
    // budget keeps its production value, and the grace is deliberately left generous so a child that
    // can still answer gets its chance to close what it opened and write its own proof.
    const first = h.launch({ origin: h.gateOrigin, env: { KFF_GUARDIAN_AWAITING_INTENT_MS: '4000', KFF_GUARDIAN_GRACE_MS: '30000' } });
    h.child = first.children;
    await expect.poll(() => first.states.includes('RUNNING'), { timeout: 20000 }).toBe(true);

    h.closeGate();
    await publishInquiry(h, page, '000904', 'Recovery inquiry four');
    await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'SCAN' });
    await expect.poll(() => h.claimed.length, { timeout: 60000 }).toBeGreaterThan(0);
    const one = h.claimed[0];
    // The stall only begins once the context is open, which is the phase whose budget it spends.
    await expect.poll(() => h.seen.includes('commands/' + one + '/context-opened'), { timeout: 60000 }).toBe(true);
    const stalledAt = Date.now();
    await expect.poll(async () => (await journalOf(h.root))[one]?.quiesced, { timeout: 180000 }).toBe(true);
    const recoveredAfter = Date.now() - stalledAt;

    // The watchdog ended this, not the child's own navigation timeout. The child bounds that at 15
    // seconds, and the outcome below is a stop-driven one that only a stopped child can produce.
    expect(recoveredAfter).toBeLessThan(14000);
    const entry = (await journalOf(h.root))[one];
    expect(entry.phase).toBe('context_open');
    // The child was still able to answer the stop, so it closed the context and wrote its own proof.
    // Retention may have compacted the page result away by now, which never touches the closure fact.
    const proof = readClosureEvidence(path.join(h.root, '.kff'), entry)!;
    expect(closureProof(proof).protocol_version).toBe('kff.guardian-closure.v1');
    expect(proof).toMatchObject({ context_closed: true });
    // No submission authority was ever requested, so no platform write can exist, and the command was
    // never claimed, reported or attempted a second time.
    expect(h.seen.filter(endpoint => endpoint.includes(one))).toEqual(['commands/' + one + '/context-opened', 'commands/' + one + '/status', 'commands/' + one + '/quiescence']);

    // Terminal evidence was accepted, the command lifecycle closed and the slot came back through the
    // normal state machine rather than by being cleared out of the way.
    expect((await query('SELECT state FROM kff.agent_commands WHERE id=$1', [one]))[0].state).toBe('DONE');
    expect((await query('SELECT quiesced_at FROM kff.agent_commands WHERE id=$1', [one]))[0].quiesced_at).not.toBeNull();
    const action = (await query('SELECT id, state, error_code FROM kff.actions WHERE id=(SELECT action_id FROM kff.agent_commands WHERE id=$1)', [one]))[0];
    expect(action.state).toBe('CANCELED');
    expect(action.error_code).toBe('STOP_REQUESTED');
    expect((await query("SELECT count(*)::int AS n FROM kff.agent_commands WHERE agent_id=$1 AND state IN ('READY','CLAIMED')", [paired.agent.id]))[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [action.id]))[0].n).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=$1 AND event_type='action.reported'", [action.id]))[0].n).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'", [one]))[0].n).toBe(1);
    // Nothing the guardian started is still running: not the guardian, and not the browser it launched.
    expect(isProcessAlive(entry.guardian_pid)).toBe(false);
    expect(describeProcesses(await nothingLeftRunning(h.root))).toEqual([]);

    // Command 2. An independent legal command, queued only after the slot came back, and this time the
    // origin answers, so the Agent really reads the page and really finishes.
    await expect.poll(async () => (await query('SELECT current_task_id FROM kff.browser_inbox_monitors WHERE id=$1', [monitor.id]))[0].current_task_id, { timeout: 20000 }).toBeNull();
    h.openGate();
    await publishInquiry(h, page, '000905', 'Recovery inquiry five');
    const version = (await query('SELECT version FROM kff.browser_inbox_monitors WHERE id=$1', [monitor.id]))[0].version;
    await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: version, action: 'SCAN' });
    await expect.poll(() => h.claimed.length, { timeout: 90000 }).toBeGreaterThan(1);
    const two = h.claimed.find(id => id !== one)!;
    await waitForProof(h, two, 120000);

    const second = (await journalOf(h.root))[two];
    expect((await query('SELECT state FROM kff.actions WHERE id=(SELECT action_id FROM kff.agent_commands WHERE id=$1)', [two]))[0].state).toBe('VERIFIED_SUCCEEDED');
    expect((await query('SELECT state FROM kff.agent_commands WHERE id=$1', [two]))[0].state).toBe('DONE');
    expect((await query('SELECT quiesced_at FROM kff.agent_commands WHERE id=$1', [two]))[0].quiesced_at).not.toBeNull();
    const closure = readClosureEvidence(path.join(h.root, '.kff'), second) as GuardianClosure;
    expect(closure.context_closed).toBe(true);
    expect(closureProof(closure).protocol_version).toBe('kff.guardian-closure.v1');
    expect(second.guardian_pid).toBeGreaterThan(0);
    expect(h.seen).toContain('commands/' + two + '/context-opened');
    expect(h.claimed.filter(id => id === one)).toHaveLength(1);
    expect(h.reported.filter(id => id === one)).toHaveLength(1);
    expect(await nothingLeftRunning(h.root)).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    clearInterval(timer); await kill(h.child); await h.close();
  }
}, 300000);

it('resumes the same original proof after a lost acknowledgement and a restart during recovery', async () => {
  const h = await harness(); const { paired, monitor, page } = await inboxBinding(h);
  const timer = drive();
  try {
    const first = h.launch(); h.child = first.children;
    await expect.poll(() => first.states.includes('RUNNING'), { timeout: 20000 }).toBe(true);
    h.hideExecutable();
    // The controller records the terminal report but never answers it, so the Agent cannot finish the flush.
    h.withhold();
    await publishInquiry(h, page, '000903', 'Recovery inquiry three');
    await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'SCAN' });
    await expect.poll(() => h.claimed.length, { timeout: 45000 }).toBeGreaterThan(0);
    const one = h.claimed[0];
    await expect.poll(() => h.reported.filter(id => id === one).length, { timeout: 60000 }).toBeGreaterThan(0);
    // Recovery is now in flight: the report landed, the closure is proven, but nothing is acknowledged yet.
    expect((await journalOf(h.root))[one].quiesced).toBeUndefined();
    const before = (await query('SELECT state, quiesced_at FROM kff.agent_commands WHERE id=$1', [one]))[0];
    expect(before.state).toBe('DONE'); expect(before.quiesced_at).toBeNull();

    h.restoreExecutable(); h.release();
    await kill(h.child);
    const second = h.launch(); h.child = second.children;
    await expect.poll(() => second.states.includes('RUNNING'), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await journalOf(h.root))[one]?.quiesced, { timeout: 60000 }).toBe(true);

    // The restarted Agent resumed the original proof instead of inventing a new one, and only once.
    const entry = (await journalOf(h.root))[one];
    const proof = closureProof(readClosureEvidence(path.join(h.root, '.kff'), entry)!);
    expect(proof.protocol_version).toBe(startupFailedProtocolVersion);
    expect(proof.action_id).toBe(entry.action_id);
    const after = (await query('SELECT state, quiesced_at FROM kff.agent_commands WHERE id=$1', [one]))[0];
    expect(after.state).toBe(before.state); expect(after.quiesced_at).not.toBeNull();
    expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'", [one]))[0].n).toBe(1);
    expect((await query("SELECT details->'proof' AS proof FROM kff.audit_events WHERE event_type='guardian.quiesced' AND object_id=$1", [one]))[0].proof).toEqual(proof);
    expect((await query('SELECT count(*)::int AS n FROM kff.agent_commands WHERE agent_id=$1', [paired.agent.id]))[0].n).toBe(1);
    // Repeated flushes add nothing: one command, one terminal report effect, one closure, one slot release.
    expect((await query("SELECT count(*)::int AS n FROM kff.inbound_events WHERE command_id=$1", [one]))[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM kff.audit_events WHERE object_id=(SELECT action_id FROM kff.agent_commands WHERE id=$1) AND event_type=\'action.reported\'', [one]))[0].n).toBe(1);
    expect(h.claimed).toEqual([one]);
    expect(h.errors).toEqual([]);
  } finally {
    clearInterval(timer); await kill(h.child); await h.close();
  }
}, 300000);
