import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fixtureCommand } from '../../helpers/commands';
import { resultInput, quiescenceInput, type TaskSnapshot, type ActionReport, type ActionState } from '../../../packages/contracts/src/index';
import { readClosure, closureProof, closureFile } from '../../../apps/agent/src/guardian-protocol';
import { digest } from '../../../packages/core/src/index';

const fixtureEnvironment = () => ({ NODE_ENV: 'test' as const, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH)$/.test(key))), KFF_ENABLE_LIVE: 'false' });

async function stopOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await stopped;
}
async function harness(scenario: TaskSnapshot['fixture_scenario'], dropReportReply = false) {
  const root = path.resolve('.kff/agent-process-tests', randomUUID()); const runtime = path.join(root, '.kff'); mkdirSync(runtime, { recursive: true });
  const command = fixtureCommand({ fixture_scenario: scenario }); const token = randomBytes(32).toString('hex');
  const reports: ActionReport[] = []; const reportRequests: ActionReport[] = []; const proofs: unknown[] = []; const children: ChildProcess[] = [];
  const state = { action: 'PREPARING' as ActionState, claims: 0, submit_count: 0, heartbeat_count: 0, continue: true, replay: false, dropped: false, errors: '' };
  const journal = () => {
    const file = path.join(runtime, 'agent', 'journal.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[command.id] as { command_id: string; action_id: string; guardian_nonce: string; guardian_pid: number; phase: string; quiesced?: boolean } : undefined;
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
      let raw = ''; for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw || '{}'); const endpoint = req.url?.replace('/api/agent/', '');
      let result: unknown;
      if (endpoint === 'heartbeats') { state.heartbeat_count++; result = { continue: state.continue }; }
      else if (endpoint === 'environment-claims') result = { command: null };
      else if (endpoint === 'claims') { state.claims++; result = { command: state.claims === 1 || state.replay ? command : null }; }
      else if (endpoint === 'commands/' + command.id + '/status') result = { state: reports.length ? 'DONE' : 'CLAIMED', action_state: state.action };
      else if (endpoint === 'commands/' + command.id + '/submit') { state.submit_count++; state.action = 'SUBMITTING'; result = { accepted: true }; }
      else if (endpoint === 'action-reports') {
        const report = resultInput.parse(body); reportRequests.push(report);
        const existing = reports.find(value => value.event_id === report.event_id);
        if (existing && digest(existing) !== digest(report)) throw new Error('Changed report replay');
        if (!existing) { reports.push(report); state.action = report.outcome; }
        if (dropReportReply && !state.dropped) { state.dropped = true; req.socket.destroy(); return; }
        result = { accepted: true, duplicate: Boolean(existing) };
      } else if (endpoint === 'commands/' + command.id + '/quiescence') {
        const proof = quiescenceInput.parse(body); const entry = journal(); const closure = entry && readClosure(runtime, entry);
        if (!closure || digest(proof) !== digest(closureProof(closure)) || !reports.length) throw new Error('Invalid guardian proof');
        proofs.push(proof); result = { quiesced: true };
      } else throw new Error('Unmatched controller request');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'TEST_CONTROLLER_REJECTED' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  writeFileSync(path.join(runtime, 'agent-config.json'), JSON.stringify({ agent_id: command.agent_id, organization_id: command.organization_id, brand_id: command.brand_id, token, controller_origin: 'http://127.0.0.1:' + address.port }), { mode: 0o600 });
  const launch = () => {
    const env = { ...fixtureEnvironment(), KFF_ROOT: root };
    const child = spawn(process.execPath, ['--import','tsx','apps/agent/src/main.ts'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    child.stderr?.on('data', data => { state.errors = (state.errors + String(data)).slice(-3000); }); children.push(child); return child;
  };
  return { command, runtime, state, reports, reportRequests, proofs, journal, launch,
    async close() { for (const child of children) await stopOwned(child); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    posts: async () => await (await fetch('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json() as unknown[],
  };
}

test('guardian closes the browser when the real Agent parent dies before submission', async () => {
  const h = await harness('slow');
  try {
    const child = h.launch(); await expect.poll(() => h.journal()?.phase).toBe('context_open'); await stopOwned(child);
    await expect.poll(() => Boolean(h.journal() && readClosure(h.runtime, h.journal()!))).toBe(true);
    expect(await h.posts()).toHaveLength(0); expect(h.state.submit_count).toBe(0);
    h.launch(); await expect.poll(() => h.journal()?.quiesced).toBe(true);
    expect(h.reports).toHaveLength(1); expect(h.reports[0].outcome).toBe('CANCELED'); expect(h.proofs).toHaveLength(1);
  } finally { await h.close(); }
});

test('Agent restart after a real synthetic write preserves unknown result and rejects old-command replay', async () => {
  const h = await harness('delayed_receipt');
  try {
    const child = h.launch(); await expect.poll(h.posts).toHaveLength(1); await stopOwned(child);
    await expect.poll(() => Boolean(h.journal() && readClosure(h.runtime, h.journal()!))).toBe(true);
    h.launch(); await expect.poll(() => h.journal()?.quiesced).toBe(true);
    expect(h.reports).toHaveLength(1); expect(h.reports[0].outcome).toBe('UNKNOWN_OUTCOME');
    h.state.replay = true; const claims = h.state.claims; await expect.poll(() => h.state.claims).toBeGreaterThanOrEqual(claims + 2);
    expect(h.state.submit_count).toBe(1); expect(await h.posts()).toHaveLength(1);
    expect(readFileSync(path.join(h.runtime, 'agent', 'journal.json'), 'utf8')).not.toContain(h.command.snapshot.body);
  } finally { await h.close(); }
});

test('killed guardian without a closure proof prevents new claims even after Agent restart', async () => {
  const h = await harness('slow');
  try {
    const child = h.launch(); await expect.poll(() => h.journal()?.phase).toBe('context_open');
    // This PID was durably recorded from the child spawned for this unique test command.
    process.kill(h.journal()!.guardian_pid, 'SIGKILL');
    await expect.poll(() => h.state.errors.includes('GUARDIAN_UNCONFIRMED')).toBe(true);
    await stopOwned(child); h.launch(); const beats = h.state.heartbeat_count;
    await expect.poll(() => h.state.heartbeat_count).toBeGreaterThanOrEqual(beats + 2);
    expect(existsSync(closureFile(h.runtime, h.command.id))).toBe(false);
    expect(h.state.claims).toBe(1); expect(h.reports).toHaveLength(0); expect(h.proofs).toHaveLength(0); expect(await h.posts()).toHaveLength(0);
  } finally { await h.close(); }
});

test('durable report is replayed with the same event after its acknowledgement connection drops', async () => {
  const h = await harness('normal', true);
  try {
    h.launch(); await expect.poll(() => h.journal()?.quiesced).toBe(true);
    expect(h.reportRequests).toHaveLength(2); expect(h.reports).toHaveLength(1);
    expect(h.reportRequests[0]).toEqual(h.reportRequests[1]); expect(h.state.submit_count).toBe(1); expect(await h.posts()).toHaveLength(1);
  } finally { await h.close(); }
});

test('controller stop closes a running guardian before its submission gate', async () => {
  const h = await harness('slow');
  try {
    h.launch(); await expect.poll(() => h.journal()?.phase).toBe('context_open'); h.state.continue = false;
    await expect.poll(() => h.journal()?.quiesced).toBe(true);
    expect(h.reports[0].outcome).toBe('CANCELED'); expect(h.state.submit_count).toBe(0); expect(await h.posts()).toHaveLength(0);
  } finally { await h.close(); }
});

test('guardian watchdog closes the context when its owner event loop freezes with IPC still connected', async () => {
  const command = fixtureCommand({ fixture_scenario: 'slow' }); const runtime = path.resolve('.kff/guardian-watchdog-tests', randomUUID());
  const child = spawn(process.execPath, ['--import','tsx','tests/helpers/guardian-owner.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], env: fixtureEnvironment() });
  let nonce: string | undefined; let frozen = false;
  child.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message) {
      if (message.type === 'identity' && 'nonce' in message) nonce = String(message.nonce);
      if (message.type === 'frozen') frozen = true;
    }
  });
  child.send({ command, runtime });
  try {
    await expect.poll(() => frozen).toBe(true);
    await expect.poll(() => readClosure(runtime, { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce }), { timeout: 27000 }).not.toBeNull();
    const record = readClosure(runtime, { command_id: command.id, action_id: command.action_id, guardian_nonce: nonce });
    expect(record?.result.outcome).toBe('CANCELED');
    expect(await (await fetch('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json()).toHaveLength(0);
  } finally { await stopOwned(child); }
});
