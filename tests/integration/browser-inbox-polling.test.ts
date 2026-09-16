import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { query, scoped, closePool } from '@kff/database';
import type { AgentCommand, ActionReport } from '@kff/contracts';
import { browserInboxTask, browserInboxPage } from '../../packages/contracts/src/browser-inbox';
import { digest } from '@kff/core';
import { configureBrowserInbox, controlBrowserInbox, browserInboxWorkspace, prepareBrowserInboxPage, syncBrowserInboxTasks } from '../../packages/core/src/browser-inbox';
import { dispatchOne, claimCommand, acceptReport, agentHeartbeat, recoverExpired } from '../../packages/core/src/execution';
import { configureEnvironment } from '../../packages/core/src/environments';
import { recordQuiescence } from '../../packages/core/src/reconciliation';
import { inboxWorkspace, inboxConversation } from '../../packages/core/src/inbox';
import { inboxFixtureMessages, renderBrowserInboxFixture } from '../../packages/adapters/src/browser-inbox-fixture';
import { runGuardian } from '../../apps/agent/src/guardian';
import { closureProof } from '../../apps/agent/src/guardian-protocol';
import { browserInboxSetup } from '../helpers/browser-inbox';
import { leadScope as scope, leadAgent as agent, clearLeads } from '../helpers/lead-fixture';

let rows = inboxFixtureMessages(), transform = (html: string) => html, writes = 0;
const server = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return; }
  try { const url = new URL(req.url!, 'http://127.0.0.1'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(transform(renderBrowserInboxFixture(browserInboxTask.parse(JSON.parse(url.searchParams.get('request')!)), rows))); }
  catch { res.writeHead(409).end(); }
});
const original = process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN;
beforeAll(async () => { await migrate(); await seed(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN = 'http://127.0.0.1:' + (server.address() as { port: number }).port; });
beforeEach(async () => { await clearLeads(); await query("DELETE FROM kff.inbound_events WHERE source_kind='facebook_browser'"); rows = inboxFixtureMessages(); transform = html => html; writes = 0; });
afterAll(async () => { if (original === undefined) delete process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN; else process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN = original; await new Promise<void>(resolve => server.close(() => resolve())); await closePool(); });
async function setup(pageSize = 2) {
  const h = await browserInboxSetup(scope);
  const input = { request_id: randomUUID(), environment_id: h.environment_id, expected_version: 0, page_size: pageSize, interval_seconds: 10, raw_retention_hours: 1 };
  const saved = await configureBrowserInbox(scope, input);
  expect(await configureBrowserInbox(scope, input)).toMatchObject({ id: saved.id });
  const monitor = await controlBrowserInbox(scope, saved.id, { request_id: randomUUID(), expected_version: saved.version, action: 'SCAN' });
  return { ...h, monitor, input };
}
async function nextCommand() {
  await syncBrowserInboxTasks(); await agentHeartbeat(agent); expect(await prepareBrowserInboxPage()).not.toBeNull(); expect(await dispatchOne()).toBe(true);
  const command = await claimCommand(agent); expect(command).not.toBeNull(); return command!;
}
function fakeReport(command: AgentCommand): ActionReport {
  const r = command.snapshot.inbox!, offset = r.cursor ? Number(r.cursor.slice(7)) : 0, more = offset + r.limit < rows.length;
  const page = browserInboxPage.parse({ monitor_id: r.monitor_id, cursor: r.cursor, next_cursor: more ? 'offset:' + (offset + r.limit) : null, has_more: more, batch: { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: r.binding.environment.configuration.login_account_id, operating_identity_id: command.snapshot.external_account_id, observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: rows.slice(offset, offset + r.limit) } });
  return { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', inbox_page: page, receipt: { remote_id: 'inbox:' + r.monitor_id + ':' + r.token, actual_account_id: command.snapshot.external_account_id, evidence_kind: 'synthetic_dom', content_hash: digest(page), observed_at: page.batch.observed_at }, diagnostic: { step: 'contract-only' } };
}
async function actualRead(command: AgentCommand) {
  const control = new AbortController(), timer = setInterval(() => { void agentHeartbeat(agent, command.id).then(value => { if (!value.continue) control.abort(); }, () => control.abort()); }, 2500);
  try { return await runGuardian(command, path.resolve('.kff/browser-inbox-tests', randomUUID()), digest(randomUUID()), { signal: control.signal, beforeSubmit: async () => { throw new Error('Inbox reader attempted write'); } }); }
  finally { clearInterval(timer); }
}
async function contractClose(command: AgentCommand, report = fakeReport(command)) {
  await acceptReport(agent, report);
  await recordQuiescence(agent, command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) });
}

it('reads two actual DOM pages through the guardian, waits for closure, deduplicates later scans and imports incremental replies', async () => {
  const h = await setup(); const prepared = await Promise.all([prepareBrowserInboxPage(), prepareBrowserInboxPage()]); expect(prepared.filter(Boolean)).toHaveLength(1);
  await dispatchOne(); const first = (await claimCommand(agent))!, closure = await actualRead(first);
  expect(closure.result.outcome).toBe('VERIFIED_SUCCEEDED'); expect(closure.context_closed).toBe(true);
  const report = { ...closure.result, event_id: randomUUID(), command_id: first.id };
  await acceptReport(agent, report); expect(await acceptReport(agent, report)).toMatchObject({ duplicate: true });
  await syncBrowserInboxTasks(); expect(await prepareBrowserInboxPage()).toBeNull();
  await recordQuiescence(agent, first.id, closureProof(closure));
  const second = await nextCommand(); expect(second.snapshot.inbox?.cursor).toBe('offset:2');
  const end = await actualRead(second); expect(end.result.outcome).toBe('VERIFIED_SUCCEEDED');
  await acceptReport(agent, { ...end.result, event_id: randomUUID(), command_id: second.id }); await recordQuiescence(agent, second.id, closureProof(end)); await syncBrowserInboxTasks();
  let state = await browserInboxWorkspace(scope); expect(state.monitors[0]).toMatchObject({ state: 'PAUSED', scan_requested: false, current_task_id: null, cursor: null, last_error_code: null });
  expect(state.checkpoints).toHaveLength(2); expect((await inboxWorkspace(scope)).counts).toEqual({ customers: 2, conversations: 2, inbound_messages: 3 });
  rows.push({ ...rows[0], message_id: 'mid.new', body: 'A new question after the first poll', occurred_at: new Date().toISOString() });
  await controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: h.monitor.version, action: 'SCAN' });
  for (let i = 0; i < 3; i++) { const command = await nextCommand(); const c = await actualRead(command); expect(c.result.outcome).toBe('VERIFIED_SUCCEEDED'); await acceptReport(agent, { ...c.result, event_id: randomUUID(), command_id: command.id }); await recordQuiescence(agent, command.id, closureProof(c)); }
  await syncBrowserInboxTasks(); state = await browserInboxWorkspace(scope);
  expect(state.checkpoints.reduce((n, row) => n + row.stored, 0)).toBe(5); expect(state.checkpoints.reduce((n, row) => n + row.duplicates, 0)).toBe(4);
  expect((await inboxWorkspace(scope)).counts.inbound_messages).toBe(4); expect(writes).toBe(0);
  const native = (await inboxWorkspace(scope)).conversations.find(row => row.display_name === 'Inbox sample B')!;
  expect((await inboxConversation(scope, native.id)).messages.map(row => row.direction)).toEqual(['INBOUND', 'EXTERNAL_OUTBOUND']);
}, 120000);

it('rolls back the report and checkpoint together when a later message changes peer identity', async () => {
  await setup(); const command = await nextCommand(), report = fakeReport(command);
  report.inbox_page!.batch.messages[1].peer_id = '123'; report.receipt!.content_hash = digest(report.inbox_page);
  await expect(acceptReport(agent, report)).rejects.toMatchObject({ code: 'MESSAGE_IDENTITY_MISMATCH' });
  expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(0); expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
  expect((await query('SELECT state FROM kff.agent_commands WHERE id=$1', [command.id]))[0].state).toBe('CLAIMED');
  await contractClose(command); expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(1);
});
it('pauses on heartbeat and discards a late successful page without advancing the cursor', async () => {
  const h = await setup(), command = await nextCommand();
  await controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: h.monitor.version, action: 'PAUSE' });
  expect((await agentHeartbeat(agent, command.id)).continue).toBe(false); await syncBrowserInboxTasks(); await contractClose(command); await syncBrowserInboxTasks();
  expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ state: 'PAUSED', current_task_id: null, cursor: null });
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0); expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(0);
});
it('rejects stale environment bindings before enqueue, enforces role/brand boundaries, and reconfigures only while idle', async () => {
  const h = await setup();
  await expect(configureBrowserInbox({ ...scope, role: 'viewer' }, h.input)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await expect(configureBrowserInbox({ ...scope, brand_id: randomUUID() }, h.input)).rejects.toMatchObject({ code: 'SOURCE_NOT_CONFIGURED' });
  await expect(configureBrowserInbox(scope, { ...h.input, request_id: randomUUID(), expected_version: h.monitor.version })).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  await configureEnvironment(scope, h.environment_id, { expected_version: 2, configuration: { ...h.binding.environment.configuration, locale: 'en-GB' } });
  expect(await prepareBrowserInboxPage()).toBeNull(); expect((await browserInboxWorkspace(scope)).monitors[0].last_error_code).toBe('ENVIRONMENT_CHANGED');
  const revised = await configureBrowserInbox(scope, { ...h.input, request_id: randomUUID(), expected_version: h.monitor.version }); expect(revised.binding.environment.configuration.locale).toBe('en-GB');
});
it('retains the current task and quarantines the environment after a claimed command expires', async () => {
  const h = await setup(), command = await nextCommand();
  await query("UPDATE kff.resource_leases SET expires_at=now()-interval '1 second' WHERE holder_attempt_id=$1", [command.attempt_id]);
  await recoverExpired(); await syncBrowserInboxTasks();
  expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ state: 'PAUSED', current_task_id: command.snapshot.inbox ? (await query('SELECT task_id FROM kff.actions WHERE id=$1', [command.action_id]))[0].task_id : '', last_error_code: 'LEASE_EXPIRED' });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [h.environment_id]))[0].state).toBe('QUARANTINED'); expect(await prepareBrowserInboxPage()).toBeNull();
  await expect(controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: h.monitor.version, action: 'SCAN' })).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  await recordQuiescence(agent, command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) }); await syncBrowserInboxTasks();
  await controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: h.monitor.version, action: 'SCAN' });
  expect(await prepareBrowserInboxPage()).toBeNull(); expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ current_task_id: null, state: 'PAUSED', last_error_code: 'ENVIRONMENT_CHANGED' });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [h.environment_id]))[0].state).toBe('QUARANTINED');
});
it('blocks a wrong visible identity in a real browser and commits no messages', async () => {
  await setup(); transform = html => html.replace(/data-testid="account-identity">[0-9]+/, 'data-testid="account-identity">999');
  const command = await nextCommand(), c = await actualRead(command); expect(c.result).toMatchObject({ outcome: 'BLOCKED', error_code: 'ACCOUNT_MISMATCH' });
  await acceptReport(agent, { ...c.result, event_id: randomUUID(), command_id: command.id }); await recordQuiescence(agent, command.id, closureProof(c)); await syncBrowserInboxTasks();
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0); expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ state: 'PAUSED', current_task_id: null, last_error_code: 'ACCOUNT_MISMATCH' });
}, 45000);
it('stops repeated cursors and prevents a stalled page from importing data', async () => {
  await setup(); await contractClose(await nextCommand());
  const second = await nextCommand(), report = fakeReport(second); report.inbox_page!.has_more = true; report.inbox_page!.next_cursor = 'offset:2'; report.receipt!.content_hash = digest(report.inbox_page);
  await contractClose(second, report); await syncBrowserInboxTasks();
  expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ state: 'PAUSED', last_error_code: 'INBOX_CURSOR_LOOP', cursor: 'offset:2' });
  expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(1);
});
it('scans two accounts independently and skips a paused account without starving the next monitor', async () => {
  const a = await setup(50), b = await setup(50);
  await query('UPDATE kff.accounts SET outbound_paused=true WHERE id=$1', [a.account_id]);
  const first = await nextCommand(); expect(first.snapshot.account_id).toBe(b.account_id); await contractClose(first); await syncBrowserInboxTasks();
  await query('UPDATE kff.accounts SET outbound_paused=false WHERE id=$1', [a.account_id]); await contractClose(await nextCommand()); await syncBrowserInboxTasks();
  expect((await inboxWorkspace(scope)).counts.customers).toBe(4); expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(2);
});
it('continuously polls only when due and cancels a queued page on pause', async () => {
  const h = await setup(50); await contractClose(await nextCommand()); await syncBrowserInboxTasks();
  const started = await controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: h.monitor.version, action: 'START' });
  await contractClose(await nextCommand()); await syncBrowserInboxTasks(); expect(await prepareBrowserInboxPage()).toBeNull();
  await query('UPDATE kff.browser_inbox_monitors SET next_poll_at=clock_timestamp() WHERE id=$1', [h.monitor.id]);
  const task = await prepareBrowserInboxPage(); expect(task).not.toBeNull();
  await controlBrowserInbox(scope, h.monitor.id, { request_id: randomUUID(), expected_version: started.version, action: 'PAUSE' }); await syncBrowserInboxTasks();
  expect((await query('SELECT status FROM kff.tasks WHERE id=$1', [task!.id]))[0].status).toBe('CANCELED'); expect(await claimCommand(agent)).toBeNull();
  expect((await browserInboxWorkspace(scope)).monitors[0].current_task_id).toBeNull();
});
it('rejects changed evidence and a foreign Agent before committing a checkpoint', async () => {
  await setup(); const command = await nextCommand(), report = fakeReport(command);
  await expect(acceptReport(agent, { ...report, receipt: { ...report.receipt!, content_hash: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'INBOX_SOURCE_MISMATCH' });
  await expect(acceptReport({ ...agent, id: randomUUID() }, report)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  expect((await browserInboxWorkspace(scope)).checkpoints).toHaveLength(0); expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
  await contractClose(command, report);
  const foreign = { ...scope, brand_id: randomUUID() };
  expect(await browserInboxWorkspace(foreign)).toEqual({ monitors: [], checkpoints: [], reads: [] });
  await expect(scoped(foreign, client => client.query('INSERT INTO kff.browser_inbox_monitors SELECT * FROM kff.browser_inbox_monitors WHERE id=$1', [command.snapshot.inbox!.monitor_id]))).resolves.toMatchObject({ rowCount: 0 });
});
it('refuses an expired page in the guardian before opening the browser', async () => {
  await setup(); const command = await nextCommand(), snapshot = structuredClone(command.snapshot); snapshot.inbox!.expires_at = new Date(0).toISOString();
  const c = await actualRead({ ...command, snapshot, snapshot_hash: digest(snapshot) });
  expect(c.result).toMatchObject({ outcome: 'BLOCKED', error_code: 'RETENTION_EXPIRED' }); expect(c.context_closed).toBe(true); expect(c.result.inbox_page).toBeUndefined();
  await acceptReport(agent, { ...c.result, command_id: command.id, event_id: randomUUID() }); await recordQuiescence(agent, command.id, closureProof(c)); await syncBrowserInboxTasks();
  expect((await browserInboxWorkspace(scope)).monitors[0]).toMatchObject({ last_error_code: 'RETENTION_EXPIRED', current_task_id: null, cursor: null });
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
});
