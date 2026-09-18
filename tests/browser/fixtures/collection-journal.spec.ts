import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectionJournalFixture, discardCollectionJournalFixtures } from '../../helpers/collection-journal';
import { digest } from '../../../packages/core/src/index';
import { resultInput, quiescenceInput, type ActionReport } from '../../../packages/contracts/src/index';
import { closureFile, closureProof, readClosureEvidence } from '../../../apps/agent/src/guardian-protocol';

test.afterAll(discardCollectionJournalFixtures);

async function harness(offline: boolean, dropReply = false) {
  const h = collectionJournalFixture(), token = randomBytes(32).toString('hex');
  if (offline) { h.entry.collection_expires_at = new Date(Date.now() + 3000).toISOString(); h.save(); }
  const state = { online: !offline, beats: 0, claims: 0, dropped: false, errors: '' };
  const reports: ActionReport[] = [], requests: ActionReport[] = [], proofs: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) throw new Error('Pairing rejected');
      let raw = ''; for await (const chunk of req) raw += String(chunk);
      const data = JSON.parse(raw || '{}'), endpoint = req.url?.replace('/api/agent/', '');
      if (endpoint === 'heartbeats') state.beats++;
      if (!state.online) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'CONTROL_UNAVAILABLE' } })); return; }
      let result: unknown = {};
      if (endpoint === 'heartbeats') result = { continue: true };
      else if (endpoint === 'claims' || endpoint === 'environment-claims') { state.claims++; result = { command: null }; }
      else if (endpoint?.endsWith('/status')) result = { state: reports.length ? 'DONE' : 'CLAIMED', action_state: reports.at(-1)?.outcome ?? 'PREPARING' };
      else if (endpoint === 'action-reports') {
        const report = resultInput.parse(data); requests.push(report);
        const existing = reports.find(value => value.event_id === report.event_id);
        if (existing && digest(existing) !== digest(report)) throw new Error('Changed report');
        if (!existing) reports.push(report);
        if (dropReply && !state.dropped) { state.dropped = true; req.socket.destroy(); return; }
        result = { accepted: true, duplicate: Boolean(existing) };
      } else if (endpoint?.endsWith('/quiescence')) {
        const proof = quiescenceInput.parse(data), record = readClosureEvidence(h.runtime, h.entry);
        if (!record || digest(closureProof(record)) !== digest(proof) || digest(h.proof) !== digest(proof) || reports.length !== 1) throw new Error('Invalid closure proof');
        proofs.push(proof); result = { quiesced: true };
      } else throw new Error('Unexpected endpoint');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'TEST_CONTROLLER_REJECTED' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(path.join(h.runtime, 'agent-config.json'), JSON.stringify({ agent_id: randomUUID(), organization_id: randomUUID(), brand_id: randomUUID(), token, controller_origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port }), { mode: 0o600 });
  const children: ChildProcess[] = [];
  const launch = () => {
    const env = { NODE_ENV: 'test' as const, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/.test(key))), KFF_ROOT: h.root, KFF_ENABLE_LIVE: 'false' };
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/agent/src/main.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env });
    child.stderr?.on('data', data => { state.errors = (state.errors + String(data)).slice(-2000); }); children.push(child); return child;
  };
  const stop = async (child: ChildProcess) => { if (child.exitCode !== null || child.signalCode !== null) return; const stopped = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await stopped; };
  return { ...h, state, requests, reports, proofs, launch, stop, entryOnDisk: () => h.reload()[h.entry.command_id], async close() { for (const child of children) await stop(child); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('running Agent cleans an expired page during a controller outage and resumes from compact proof after restart', async () => {
  const h = await harness(true);
  try {
    const first = h.launch(); await expect.poll(() => h.state.beats).toBeGreaterThan(0);
    await expect.poll(() => h.entryOnDisk().collection_redaction?.reason).toBe('RETENTION_EXPIRED');
    expect(h.requests).toHaveLength(0); expect(h.state.claims).toBe(0);
    expect(readFileSync(h.file, 'utf8')).not.toContain('Synthetic raw page marker');
    expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).not.toContain('Synthetic raw page marker');
    await h.stop(first); h.state.online = true; h.launch();
    await expect.poll(() => h.entryOnDisk().quiesced).toBe(true);
    expect(h.reports).toHaveLength(1); expect(h.reports[0]).toMatchObject({ outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED' });
    expect(h.reports[0].collection_page).toBeUndefined(); expect(h.proofs).toEqual([h.proof]);
    await expect.poll(() => h.state.claims).toBeGreaterThan(0);
  } finally { await h.close(); }
});

test('real Agent retries a lost page acknowledgement unchanged and cleans both files after controller closure acknowledgement', async () => {
  const h = await harness(false, true);
  try {
    h.launch(); await expect.poll(() => h.entryOnDisk().quiesced).toBe(true);
    expect(h.requests).toHaveLength(2); expect(h.requests[0]).toEqual(h.requests[1]); expect(h.reports).toHaveLength(1);
    expect(h.reports[0].collection_page?.rows).toHaveLength(1); expect(h.proofs).toEqual([h.proof]);
    expect(h.entryOnDisk().collection_redaction?.reason).toBe('DELIVERED');
    expect(readFileSync(h.file, 'utf8')).not.toContain('Synthetic raw page marker');
    expect(readFileSync(closureFile(h.runtime, h.entry.command_id), 'utf8')).not.toContain('Synthetic raw page marker');
  } finally { await h.close(); }
});
