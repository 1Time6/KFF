import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { startFixtureServer } from '../../scripts/fixture-server';
import { query, closePool } from '@kff/database';
import { AppError, digest } from '@kff/core';
import { adapterImplementationDigest } from '../../packages/core/src/artifacts';
import { resultInput, heartbeatInput, quiescenceInput, uuid, type AgentCommand } from '@kff/contracts';
import { receptionPolicy } from '../../packages/contracts/src/lead';
import { authenticateAgent, agentHeartbeat, claimCommand, dispatchOne, beginSubmission, commandStatus, recordBrowserOpened, acceptReport } from '../../packages/core/src/execution';
import { claimEnvironmentCommand } from '../../packages/core/src/environments';
import { createAgent } from '../../packages/core/src/controls';
import { createFacebookFixture, configureFacebook } from '../../packages/core/src/facebook-inbound';
import { configureBrowserInbox, controlBrowserInbox, prepareBrowserInboxPage, syncBrowserInboxTasks } from '../../packages/core/src/browser-inbox';
import { configureReceptionPolicy } from '../../packages/core/src/reception-worker';
import { sendConversationReply, conversationReception } from '../../packages/core/src/lead-reception';
import { inboxConversation } from '../../packages/core/src/inbox';
import { recordQuiescence, reconcileSynthetic, releaseQuarantine } from '../../packages/core/src/reconciliation';
import { readClosureEvidence, closureProof } from '../../apps/agent/src/guardian-protocol';
import type { JournalEntry } from '../../apps/agent/src/action-journal';
import { browserInboxSetup } from '../helpers/browser-inbox';
import { leadScope as scope, clearLeads, seedDestination } from '../helpers/lead-fixture';

beforeAll(async () => { await migrate(); await seed(); });
beforeEach(async () => { await clearLeads(); await query("DELETE FROM kff.inbound_events WHERE source_kind='facebook_browser'"); });
afterAll(closePool);
async function stopOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exit;
}

it('runs two isolated browser Agents, continues the second account while the first is unknown, and recovers the exact lost acknowledgement after restart', async () => {
  const root = await mkdtemp(path.resolve('.kff/browser-matrix-process-'));
  // Optional delivery acceptance runs from the actual ZIP outside the checkout's dependency ancestors.
  const archive = process.env.KFF_AGENT_RELEASE_ARCHIVE;
  const previousArchive = process.env.KFF_AGENT_PREVIOUS_RELEASE_ARCHIVE;
  if (previousArchive && !archive) throw new Error('Upgrade acceptance requires the current archive too');
  let release: { first: string; second: string; id: string; archive_sha256: string; source_implementation_matches: boolean; previous?: { directory: string; id: string; version: string; archive_sha256: string; changed_sources: string[] } } | undefined;
  if (archive) {
    const extracted = await mkdtemp(path.join(tmpdir(), 'kff-agent-delivery-'));
    const id = path.basename(archive, '.zip');
    if (!/^kff-agent-[a-zA-Z0-9.-]+$/.test(id)) throw new Error('Invalid release archive name');
    for (const version of ['first', 'second']) {
      const directory = path.join(extracted, version); await mkdir(directory);
      execFileSync('tar.exe', ['-x', '-f', path.resolve(archive), '-C', directory], { windowsHide: true });
    }
    release = { first: path.join(extracted, 'first', id), second: path.join(extracted, 'second', id), id, archive_sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), source_implementation_matches: false };
    expect((await readFile(archive + '.sha256', 'utf8')).split(' ')[0]).toBe(release.archive_sha256);
    // Compare the very same implementation digest used by the live execution guard.
    expect(adapterImplementationDigest(release.first, 'facebook')).toBe(adapterImplementationDigest(process.cwd(), 'facebook'));
    release.source_implementation_matches = true;
    const manifest = JSON.parse(await readFile(path.join(release.first, 'release.json'), 'utf8'));
    expect(Object.keys(manifest.files).some(file => /(^|\/)\.kff(\/|$)|(^|\/)\.env($|\.)/.test(file))).toBe(false);
    const run = (args: string[]) => execFileSync(path.join(release!.first, 'node.exe'), [path.join(release!.first, 'agent-launch.mjs'), ...args], { cwd: tmpdir(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(run(['verify'])).verified_files).toBe(Object.keys(manifest.files).length);
    expect(() => run(['start', '--data-root', release!.first])).toThrow(/DATA_ROOT_MUST_BE_OUTSIDE_RELEASE/);
    const sourceFile = path.join(release.first, 'apps/agent/src/main.ts'), sourceBytes = await readFile(sourceFile);
    await writeFile(sourceFile, Buffer.concat([sourceBytes, Buffer.from('\n// damaged transfer\n')]));
    try { expect(() => run(['verify'])).toThrow(/RELEASE_HASH_MISMATCH/); }
    finally { await writeFile(sourceFile, sourceBytes); }
    if (previousArchive) {
      const previousId = path.basename(previousArchive, '.zip');
      if (!/^kff-agent-[a-zA-Z0-9.-]+$/.test(previousId)) throw new Error('Invalid previous release name');
      const directory = path.join(extracted, 'previous'); await mkdir(directory);
      execFileSync('tar.exe', ['-x', '-f', path.resolve(previousArchive), '-C', directory], { windowsHide: true });
      const previousRoot = path.join(directory, previousId), previousManifest = JSON.parse(await readFile(path.join(previousRoot, 'release.json'), 'utf8'));
      const previousHash = createHash('sha256').update(await readFile(previousArchive)).digest('hex');
      expect((await readFile(previousArchive + '.sha256', 'utf8')).split(' ')[0]).toBe(previousHash);
      expect(JSON.parse(execFileSync(path.join(previousRoot, 'node.exe'), [path.join(previousRoot, 'agent-launch.mjs'), 'verify'], { cwd: tmpdir(), windowsHide: true, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })).verified_files).toBe(Object.keys(previousManifest.files).length);
      expect(previousManifest.version).not.toBe(manifest.version);
      expect(previousManifest.protocol_version).toBe(manifest.protocol_version);
      const changed = Object.keys(manifest.source_hashes).filter(file => file.endsWith('.ts') && manifest.source_hashes[file] !== previousManifest.source_hashes[file]);
      expect(changed.length).toBeGreaterThan(0);
      release.previous = { directory: previousRoot, id: previousId, version: previousManifest.version, archive_sha256: previousHash, changed_sources: changed };
    }
  }
  const fixture = await startFixtureServer(0, path.join(root, 'fixture'));
  const children: ChildProcess[] = [], errors: string[] = [], reported = new Map<string, string[]>(), claimed = new Map<string, AgentCommand>();
  const droppedAgents = new Set<string>(); let dropCount = 0, scheduling = false;
  const server = createServer(async (req, res) => {
    try {
      const request = new Request('http://127.0.0.1' + req.url, { headers: { authorization: req.headers.authorization ?? '' } });
      const agent = await authenticateAgent(request);
      if (req.method !== 'POST') throw new AppError('INVALID_INPUT', 'POST required');
      let raw = ''; for await (const chunk of req) { raw += String(chunk); if (raw.length > 2 * 1024 * 1024) throw new Error('Oversize test request'); }
      const body = JSON.parse(raw || '{}'), endpoint = req.url?.replace('/api/agent/', ''), commandPath = /^commands\/([^/]+)\/(status|submit|context-opened|quiescence)$/.exec(endpoint ?? '');
      let result: unknown;
      if (endpoint === 'heartbeats') result = await agentHeartbeat(agent, heartbeatInput.parse(body).command_id);
      else if (endpoint === 'environment-claims') result = { command: await claimEnvironmentCommand(agent) };
      else if (endpoint === 'claims') { const command = await claimCommand(agent); if (command) claimed.set(command.id, command); result = { command }; }
      else if (endpoint === 'action-reports') {
        const report = resultInput.parse(body); result = await acceptReport(agent, report);
        reported.set(report.command_id, [...reported.get(report.command_id) ?? [], digest(report)]);
        if (droppedAgents.has(agent.id)) { dropCount++; req.socket.destroy(); return; }
      } else if (commandPath) {
        const id = uuid.parse(commandPath[1]);
        if (commandPath[2] === 'status') result = await commandStatus(agent, id);
        if (commandPath[2] === 'submit') result = await beginSubmission(agent, id);
        if (commandPath[2] === 'context-opened') result = await recordBrowserOpened(agent, id);
        if (commandPath[2] === 'quiescence') result = await recordQuiescence(agent, id, quiescenceInput.parse(body));
      } else throw new Error('Unexpected Agent endpoint');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { errors.push(error instanceof AppError ? error.code : error instanceof Error ? error.message : 'TEST_ERROR'); res.writeHead(error instanceof AppError ? error.status : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: error instanceof AppError ? error.code : 'TEST_ERROR' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const controller = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const tick = async () => { if (scheduling) return; scheduling = true; try { await syncBrowserInboxTasks(); for (let i = 0; i < 2; i++) { await prepareBrowserInboxPage(); await dispatchOne(); } } catch (error) { errors.push(error instanceof Error ? error.message : 'Scheduler failed'); } finally { scheduling = false; } };
  const timer = setInterval(() => void tick(), 250);
  const launch = (agentRoot: string, relocated = false, previous = false): ChildProcess => {
    const env = { NODE_ENV: 'test' as const, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH)$/.test(key))), KFF_ROOT: agentRoot, KFF_ENABLE_LIVE: 'false', KFF_BROWSER_INBOX_FIXTURE_ORIGIN: fixture.origin, KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN: fixture.origin, ...(release ? { KFF_AGENT_TOKEN: 'invalid-inherited-token', KFF_APP_ORIGIN: 'http://127.0.0.1:1', KFF_AGENT_CONFIG_FILE: 'missing-inherited-pairing.json' } : {}) };
    const codeRoot = release ? previous && release.previous ? release.previous.directory : relocated ? release.second : release.first : process.cwd();
    const child = spawn(release ? path.join(codeRoot, 'node.exe') : process.execPath, release ? [path.join(codeRoot, 'agent-launch.mjs'), 'start', '--data-root', agentRoot] : ['--import', 'tsx', 'apps/agent/src/main.ts'], { cwd: release ? tmpdir() : process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); children.push(child); return child;
  };
  const journal = async (agentRoot: string) => JSON.parse(await readFile(path.join(agentRoot, '.kff/agent/journal.json'), 'utf8')) as Record<string, JournalEntry>;
  const post = async (page: string, body: string) => { const r = await fetch(fixture.origin + '/browser-inbox/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: page, thread_id: '000777', peer_id: '999888777666555', body, display_name: 'Same peer on separate accounts' }) }); expect(r.ok).toBe(true); };
  const monitorDone = async (id: string) => Boolean((await query('SELECT 1 FROM kff.browser_inbox_monitors WHERE id=$1 AND last_polled_at IS NOT NULL AND NOT scan_requested AND current_task_id IS NULL', [id])).length);
  const readOnce = async (id: string) => { const m = (await query('SELECT version FROM kff.browser_inbox_monitors WHERE id=$1', [id]))[0]; await controlBrowserInbox(scope, id, { request_id: randomUUID(), expected_version: m.version, action: 'SCAN' }); };
  const actionClosed = async (id: string) => Boolean((await query("SELECT 1 FROM kff.agent_commands WHERE action_id=$1 AND state='DONE' AND quiesced_at IS NOT NULL", [id])).length);
  try {
    const accounts: Array<Awaited<ReturnType<typeof browserInboxSetup>> & { agent: Awaited<ReturnType<typeof createAgent>>['agent']; agentRoot: string; page: string; monitor: { id: string }; child: ChildProcess }> = [];
    for (const index of [1, 2]) {
      const paired = await createAgent(scope, { name: 'Browser matrix process ' + index }), agentRoot = path.join(root, 'agent-' + index); await mkdir(path.join(agentRoot, '.kff'), { recursive: true });
      await writeFile(path.join(agentRoot, '.kff/agent-config.json'), JSON.stringify({ ...paired.configuration, controller_origin: controller }), { mode: 0o600 });
      const page = BigInt('0x' + randomUUID().replaceAll('-', '')).toString(), account = await createFacebookFixture(scope, { request_id: randomUUID(), name: 'Matrix browser account ' + index, page_id: page, agent_id: paired.agent.id });
      const h = await browserInboxSetup(scope, account);
      await configureFacebook(scope, { request_id: randomUUID(), ...account, expected_version: 0, transport: 'BROWSER', state: 'ACTIVE', auto_reply: false, reply_window_hours: 24, policy_ref: 'kff.browser-fixture.service-window.v1' });
      await configureReceptionPolicy(scope, { request_id: randomUUID(), account_id: account.account_id, expected_version: 1, policy: receptionPolicy.parse({ min_reply_interval_seconds: 0 }) });
      await seedDestination(account.account_id, '1555000400' + index); await post(page, 'Fresh account ' + index + ' consultation');
      const monitor = await configureBrowserInbox(scope, { request_id: randomUUID(), environment_id: h.environment_id, expected_version: 0, page_size: 50, interval_seconds: 10, raw_retention_hours: 1 });
      accounts.push({ ...h, agent: paired.agent, agentRoot, page, monitor, child: launch(agentRoot, false, index === 1 && Boolean(release?.previous)) });
    }
    const [a, b] = accounts;
    await Promise.all(accounts.map(row => readOnce(row.monitor.id)));
    await expect.poll(async () => (await Promise.all(accounts.map(row => monitorDone(row.monitor.id)))).every(Boolean), { timeout: 45000, interval: 250 }).toBe(true);
    const conversation = async (accountId: string) => (await query("SELECT v.id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1 AND i.remote_id='000777'", [accountId]))[0].id as string;
    const aConversation = await conversation(a.account_id), bConversation = await conversation(b.account_id); expect(aConversation).not.toBe(bConversation);
    droppedAgents.add(a.agent.id);
    const input = { request_id: randomUUID(), expected_version: 1, body: '', refer_whatsapp: true, fixture_scenario: 'lost_after_submit' as const };
    const [aReply, bReply] = await Promise.all([sendConversationReply(scope, aConversation, input), sendConversationReply(scope, bConversation, { ...input, request_id: randomUUID(), fixture_scenario: 'normal' })]);
    await expect.poll(() => dropCount, { timeout: 45000, interval: 250 }).toBeGreaterThan(0);
    await expect.poll(() => actionClosed(bReply.action_id), { timeout: 45000, interval: 250 }).toBe(true);
    expect((await conversationReception(scope, aConversation)).referrals[0].state).toBe('UNKNOWN'); expect((await conversationReception(scope, bConversation)).referrals[0].state).toBe('REFERRED');
    expect((await query('SELECT state FROM kff.environments WHERE id=$1', [a.environment_id]))[0].state).toBe('QUARANTINED');
    const aCommand = [...claimed.values()].find(c => c.action_id === aReply.action_id)!; expect(aCommand.agent_id).toBe(a.agent.id);
    const before = (await journal(a.agentRoot))[aCommand.id]; expect(before.acknowledged).not.toBe(true); expect(readClosureEvidence(path.join(a.agentRoot, '.kff'), before)).toBeTruthy();
    const originalProofHash = digest(closureProof(readClosureEvidence(path.join(a.agentRoot, '.kff'), before)!));
    const pairingBefore = digest(await readFile(path.join(a.agentRoot, '.kff/agent-config.json'), 'utf8'));
    expect(a.child.exitCode).toBeNull(); await stopOwned(a.child);
    // The second actual Agent continues collecting and sending in its own browser while A is offline/quarantined.
    await post(b.page, 'Second account remains available after the other Agent stops'); await readOnce(b.monitor.id);
    await expect.poll(() => monitorDone(b.monitor.id), { timeout: 45000, interval: 250 }).toBe(true);
    const bDetail = await inboxConversation(scope, bConversation), bFollowup = await sendConversationReply(scope, bConversation, { request_id: randomUUID(), expected_version: bDetail.conversation.control_version, body: 'Follow-up from the second isolated browser', refer_whatsapp: false, fixture_scenario: 'normal' });
    await expect.poll(() => actionClosed(bFollowup.action_id), { timeout: 45000, interval: 250 }).toBe(true);
    expect((await query('SELECT state FROM kff.environments WHERE id=$1', [a.environment_id]))[0].state).toBe('QUARANTINED');
    droppedAgents.delete(a.agent.id); const restarted = launch(a.agentRoot, true); expect(restarted.pid).not.toBe(a.child.pid);
    await expect.poll(() => actionClosed(aReply.action_id), { timeout: 45000, interval: 250 }).toBe(true);
    expect(reported.get(aCommand.id)!.length).toBeGreaterThan(1); expect(new Set(reported.get(aCommand.id))).toHaveLength(1);
    expect(digest(closureProof(readClosureEvidence(path.join(a.agentRoot, '.kff'), (await journal(a.agentRoot))[aCommand.id])!))).toBe(originalProofHash);
    expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [aReply.action_id]))[0].n).toBe(1);
    const receiptRows = async (id: string) => await (await fetch(fixture.origin + '/browser-message-receipts?action_id=' + id)).json() as Array<Record<string, unknown>>;
    const aReceipts = await receiptRows(aReply.action_id), bReceipts = await receiptRows(bReply.action_id); expect(aReceipts).toHaveLength(1); expect(bReceipts).toHaveLength(1);
    expect(aReceipts[0]).toMatchObject({ account_id: a.page, thread_id: '000777', recipient_id: '999888777666555' }); expect(aReceipts[0].body).toContain('15550004001');
    expect(bReceipts[0]).toMatchObject({ account_id: b.page, thread_id: '000777', recipient_id: '999888777666555' }); expect(bReceipts[0].body).toContain('15550004002');
    expect((await reconcileSynthetic(scope, aReply.run_id, async () => bReceipts)).reconciled).toBe(false);
    expect((await reconcileSynthetic(scope, aReply.run_id, async () => aReceipts)).reconciled).toBe(true); await releaseQuarantine(scope, aReply.run_id);
    expect((await conversationReception(scope, aConversation)).referrals[0].state).toBe('REFERRED');
    let upgradedAgentContinued = false;
    if (release?.previous) {
      await post(a.page, 'New inbound after the old Agent was upgraded'); await readOnce(a.monitor.id);
      await expect.poll(() => monitorDone(a.monitor.id), { timeout: 45000, interval: 250 }).toBe(true);
      const detail = await inboxConversation(scope, aConversation);
      const reply = await sendConversationReply(scope, aConversation, { request_id: randomUUID(), expected_version: detail.conversation.control_version, body: 'Reply from the upgraded Agent', refer_whatsapp: false, fixture_scenario: 'normal' });
      await expect.poll(() => actionClosed(reply.action_id), { timeout: 45000, interval: 250 }).toBe(true);
      const sent = await receiptRows(reply.action_id); expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ account_id: a.page, thread_id: '000777', recipient_id: '999888777666555', body: 'Reply from the upgraded Agent' });
      upgradedAgentContinued = true;
    }
    const proofRows = [];
    for (const row of accounts) {
      const entries = await journal(row.agentRoot), binding = JSON.parse(await readFile(path.join(row.agentRoot, '.kff/browser-environments', row.binding.environment.profile_key, 'binding.json'), 'utf8'));
      expect(binding).toMatchObject({ account_id: row.account_id, agent_id: row.agent.id });
      for (const entry of Object.values(entries)) {
        expect(entry.quiesced).toBe(true); const closure = readClosureEvidence(path.join(row.agentRoot, '.kff'), entry)!;
        const db = (await query("SELECT details->'proof' proof FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'", [entry.command_id]))[0];
        expect(digest(closureProof(closure))).toBe(digest(db.proof)); proofRows.push({ agent_id: row.agent.id, command_id: entry.command_id, action_id: entry.action_id, proof_matches_database: true });
      }
    }
    expect(proofRows).toHaveLength(release?.previous ? 8 : 6); expect(errors).toEqual([]);
    expect(digest(await readFile(path.join(a.agentRoot, '.kff/agent-config.json'), 'utf8'))).toBe(pairingBefore);
    await writeFile('.kff/checks/' + (release?.previous ? 'agent-upgrade-process-evidence' : release ? 'agent-delivery-process-evidence' : 'browser-matrix-process-evidence') + '.json', JSON.stringify({ checked_at: new Date().toISOString(), synthetic: true, real_platform_verified: false, independent_agent_processes: 2, first_agent_restarted: true, cross_version_upgrade: Boolean(release?.previous), upgraded_agent_continued: upgradedAgentContinued, lost_ack_report_replayed_unchanged: true, original_closure_proof_unchanged: true, first_action_submission_attempts: 1, first_action_remote_messages: aReceipts.length, second_account_continued_while_first_quarantined: true, exact_account_destinations_verified: true, pairing_file_unchanged: true, release, runtime_root: root, proofs: proofRows }, null, 2));
  } finally {
    clearInterval(timer); await expect.poll(() => scheduling, { timeout: 10000, interval: 100 }).toBe(false);
    for (const child of children) await stopOwned(child);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
  }
// Three ZIP extractions and complete integrity checks precede the unchanged 45-second action bounds.
}, process.env.KFF_AGENT_PREVIOUS_RELEASE_ARCHIVE ? 300000 : 180000);
