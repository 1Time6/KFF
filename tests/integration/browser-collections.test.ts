import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, closePool } from '@kff/database';
import type { AgentCommand, ActionReport, CollectionRecord, Scope } from '@kff/contracts';
import { digest } from '@kff/core';
import { createAcquisitionFixture, createMonitor, controlMonitor, projectDiscoveryLeads, acquisitionWorkspace, controlDiscoveryLead } from '../../packages/core/src/acquisition';
import { configureEnvironment } from '../../packages/core/src/environments';
import { claimCollection, collectionDetail, controlCollection } from '../../packages/core/src/collections';
import { prepareBrowserCollectionPage, syncBrowserCollectionTasks } from '../../packages/core/src/browser-collections';
import { dispatchOne, claimCommand, acceptReport, agentHeartbeat, recoverExpired } from '../../packages/core/src/execution';
import { localDiscoveryPage } from '../../packages/adapters/src/discovery';
import { browserDiscoveryReadSchema, renderBrowserDiscoveryFixture } from '../../packages/adapters/src/browser-discovery-fixture';
import { runGuardian } from '../../apps/agent/src/guardian';
import { closureProof } from '../../apps/agent/src/guardian-protocol';
import { recordQuiescence } from '../../packages/core/src/reconciliation';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent = { id: localIds.agent, organization_id: scope.organization_id, brand_id: scope.brand_id, status: 'ONLINE' };
let rows: CollectionRecord[] | undefined, transform = (html: string) => html;
let writeRequests = 0;
const browserClosures = new Map<string, ReturnType<typeof closureProof>>();
const server = createServer((req, res) => {
  if (req.method !== 'GET') { writeRequests++; res.writeHead(405).end(); return; }
  try { const url = new URL(req.url!, 'http://127.0.0.1'); const input = browserDiscoveryReadSchema.parse(JSON.parse(url.searchParams.get('request')!)); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(transform(renderBrowserDiscoveryFixture(input, rows))); }
  catch { res.writeHead(409).end(); }
});
const originalOrigin = process.env.KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN;
beforeAll(async () => {
  await migrate(); await seed();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
beforeEach(async () => {
  const db = (await query('SELECT current_database() AS name'))[0].name;
  if (db !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(db)) throw new Error('Isolated database required');
  await query('TRUNCATE kff.acquisition_monitors,kff.acquisition_suppressions,kff.collection_queries,kff.collection_objects,kff.content_versions,kff.audit_events CASCADE');
  await query('UPDATE kff.accounts SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); await query('UPDATE kff.organizations SET outbound_paused=false');
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1", [agent.id]);
  rows = undefined; transform = html => html; writeRequests = 0; browserClosures.clear();
});
afterAll(async () => { if (originalOrigin === undefined) delete process.env.KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN; else process.env.KFF_BROWSER_COLLECTION_FIXTURE_ORIGIN = originalOrigin; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await closePool(); });

async function setup(pageSize = 2) {
  const account = await createAcquisitionFixture(scope, { request_id: randomUUID(), platform: 'facebook', agent_id: agent.id });
  const external = (await query('SELECT external_id FROM kff.accounts WHERE id=$1', [account.account_id]))[0].external_id;
  const configuration = { driver: 'native', provider_profile_id: null, login_account_id: '900010', operating_identity_id: external, locale: 'en-US', timezone_id: 'UTC', proxy_ref: null };
  await configureEnvironment(scope, account.environment_id, { expected_version: 1, configuration });
  const input = { request_id: randomUUID(), account_id: account.account_id, title: 'Browser comments', discovery: { platform: 'facebook', strategy: 'COMMENTS', provider: 'LOCAL_BROWSER', browser: { environment_id: account.environment_id, template: 'fixture-discovery-dom-v1' }, keywords: ['consultation'], exclusions: [], target: 'owned-fixture-thread', processing_basis: 'Repository-authored synthetic browser collection only' }, page_size: pageSize, interval_minutes: 5, max_records: 100, max_pages: 10, retention_days: 7 };
  const monitor = await createMonitor(scope, input);
  const scan = await controlMonitor(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'SCAN', reason: 'Isolated browser scan' }) as { id: string; run_id: string };
  return { account, external, configuration, monitor, scan, input };
}
async function nextCommand() {
  await query('UPDATE kff.collection_runs SET available_at=clock_timestamp()'); await agentHeartbeat(agent);
  expect(await prepareBrowserCollectionPage()).not.toBeNull(); expect(await dispatchOne()).toBe(true);
  const command = await claimCommand(agent); expect(command).not.toBeNull(); return command!;
}
function fakeReport(command: AgentCommand): ActionReport {
  const request = command.snapshot.collection!;
  const page = localDiscoveryPage({ ...request, snapshot: { ...request.snapshot, discovery: { ...request.snapshot.discovery!, provider: 'LOCAL_FIXTURE', browser: undefined } } });
  return { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', collection_page: page, receipt: { remote_id: 'collection:' + request.run_id + ':' + request.page_number, actual_account_id: command.snapshot.external_account_id, content_hash: digest(page), evidence_kind: 'synthetic_dom', observed_at: page.observed_at }, diagnostic: { step: 'contract-only' } };
}
async function browserReport(command: AgentCommand) {
  const control = new AbortController();
  const timer = setInterval(() => { void agentHeartbeat(agent, command.id).then(value => { if (!value.continue) control.abort(); }, () => control.abort()); }, 3000);
  try {
    const closure = await runGuardian(command, path.resolve('.kff/browser-collection-tests', randomUUID()), digest(randomUUID()), { signal: control.signal, beforeSubmit: async () => { throw new Error('Read-only collection requested submission'); } });
    expect(closure.context_closed).toBe(true); browserClosures.set(command.id, closureProof(closure));
    return { ...closure.result, event_id: randomUUID(), command_id: command.id };
  } finally { clearInterval(timer); }
}
async function confirmBrowserClosed(command: AgentCommand) {
  const proof = browserClosures.get(command.id); expect(proof).toBeDefined();
  await recordQuiescence(agent, command.id, proof!);
}
async function confirmSyntheticClosed(command: AgentCommand) {
  // These contract-only reads never launch a browser; keep their synthetic closure explicit.
  expect(command.snapshot.is_synthetic).toBe(true);
  await recordQuiescence(agent, command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: command.id, action_id: command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'c'.repeat(64) });
}

it('uses the existing Agent queue and commits two DOM pages, duplicates, incremental comments and persistent opt-out', async () => {
  const { monitor, scan } = await setup();
  expect(await claimCollection()).toBeNull();
  const preparations = await Promise.all([prepareBrowserCollectionPage(), prepareBrowserCollectionPage()]);
  expect(preparations.filter(Boolean)).toHaveLength(1);
  expect(await dispatchOne()).toBe(true); const first = (await claimCommand(agent))!;
  const report = await browserReport(first); expect(report.outcome).toBe('VERIFIED_SUCCEEDED'); expect(report.collection_page?.rows).toHaveLength(2);
  expect(await acceptReport(agent, report)).toMatchObject({ duplicate: false });
  expect(await acceptReport(agent, report)).toMatchObject({ duplicate: true });
  await expect(acceptReport(agent, { ...report, diagnostic: { step: 'changed-replay' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await confirmBrowserClosed(first);
  const second = await nextCommand(); expect(second.snapshot.collection?.cursor).toBe('offset:2');
  const secondReport = await browserReport(second); expect(secondReport.outcome).toBe('VERIFIED_SUCCEEDED'); await acceptReport(agent, secondReport);
  await confirmBrowserClosed(second);
  expect((await collectionDetail(scope, scan.id)).run).toMatchObject({ state: 'COMPLETED', returned_count: 4, unique_count: 4, committed_pages: 2 });
  await projectDiscoveryLeads(); const leads = (await acquisitionWorkspace(scope)).leads; expect(leads).toHaveLength(3);
  const opted = leads[0]; await controlDiscoveryLead(scope, opted.id, { request_id: randomUUID(), expected_version: opted.version, state: 'OPTED_OUT', reason: 'Synthetic author requests no further contact' });
  rows = [...report.collection_page!.rows, ...secondReport.collection_page!.rows];
  rows.push({ ...rows[0], source_object_id: first.snapshot.external_account_id + '_5', source_url: 'http://127.0.0.1:4311/collection-object/' + first.snapshot.external_account_id + '_5', fields: { ...rows[0].fields, message: { kind: 'VALUE', value: 'consultation: need help with new comment' }, author_id: { kind: 'VALUE', value: '900200' } } });
  await controlMonitor(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'SCAN', reason: 'Synthetic new comment arrives' });
  for (let i = 0; i < 3; i++) { const command = await nextCommand(); const received = await browserReport(command); expect(received.outcome).toBe('VERIFIED_SUCCEEDED'); await acceptReport(agent, received); await confirmBrowserClosed(command); }
  await projectDiscoveryLeads(); const after = (await acquisitionWorkspace(scope)).leads;
  expect(after).toHaveLength(4); expect(after.find(lead => lead.id === opted.id)).toMatchObject({ state: 'OPTED_OUT' });
  expect(after.find(lead => lead.source_object_id.endsWith('_5'))).toBeDefined(); expect(writeRequests).toBe(0);
}, 120000);

it('rejects a different account environment and fails stale environment snapshots before creating a task', async () => {
  const first = await setup(), second = await setup();
  await expect(createMonitor(scope, { ...first.input, request_id: randomUUID(), discovery: { ...first.input.discovery, browser: { ...first.input.discovery.browser, environment_id: second.account.environment_id } } })).rejects.toMatchObject({ code: 'SOURCE_NOT_CONFIGURED' });
  await configureEnvironment(scope, first.account.environment_id, { expected_version: 2, configuration: { ...first.configuration, locale: 'en-GB' } });
  expect(await prepareBrowserCollectionPage()).toBeNull();
  expect((await collectionDetail(scope, first.scan.id)).run).toMatchObject({ state: 'FAILED', error_code: 'VERSION_CONFLICT' });
  expect((await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n).toBe(0);
});

it('stops an active collection on heartbeat and discards its late page without importing data', async () => {
  const { scan } = await setup(); const command = await nextCommand(); const report = fakeReport(command);
  const detail = await collectionDetail(scope, scan.id);
  await controlCollection(scope, scan.id, 'STOP', { request_id: randomUUID(), expected_version: detail.run.version, reason: 'Stop before page receipt' });
  expect((await agentHeartbeat(agent, command.id)).continue).toBe(false); await syncBrowserCollectionTasks();
  expect(await acceptReport(agent, report)).toMatchObject({ accepted: true });
  expect((await collectionDetail(scope, scan.id)).run).toMatchObject({ state: 'CANCELED', returned_count: 0 });
  expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(0);
});

it('rejects changed page evidence atomically then accepts the original contract receipt', async () => {
  await setup(); const command = await nextCommand(), report = fakeReport(command);
  await expect(acceptReport(agent, { ...report, receipt: { ...report.receipt!, content_hash: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'COLLECTION_SOURCE_MISMATCH' });
  expect((await query('SELECT count(*)::int AS n FROM kff.inbound_events'))[0].n).toBe(0);
  expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(0);
  await acceptReport(agent, report); expect((await query('SELECT count(*)::int AS n FROM kff.collection_observations'))[0].n).toBe(2);
});

it('rejects a wrong visible account in the actual browser and closes without importing', async () => {
  const { scan } = await setup(); transform = html => html.replace(/data-testid="account-identity">[0-9]+/, 'data-testid="account-identity">999');
  const command = await nextCommand(), report = await browserReport(command);
  expect(report).toMatchObject({ outcome: 'BLOCKED', error_code: 'ACCOUNT_MISMATCH' }); await acceptReport(agent, report);
  expect((await collectionDetail(scope, scan.id)).run).toMatchObject({ state: 'FAILED', returned_count: 0, error_code: 'ACCOUNT_MISMATCH' });
}, 45000);

it('keeps the environment quarantined after an expired claimed command and does not enqueue another page', async () => {
  const { scan } = await setup(); const command = await nextCommand();
  await query("UPDATE kff.resource_leases SET expires_at=now()-interval '1 second' WHERE holder_attempt_id=$1", [command.attempt_id]);
  await recoverExpired(); await syncBrowserCollectionTasks();
  expect((await collectionDetail(scope, scan.id)).run).toMatchObject({ state: 'FAILED', error_code: 'LEASE_EXPIRED' });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [command.snapshot.environment_id]))[0].state).toBe('QUARANTINED');
  expect(await prepareBrowserCollectionPage()).toBeNull();
});

it('cancels a queued page when its monitor is paused and prevents Agent delivery', async () => {
  const { monitor, scan } = await setup(); const task = (await prepareBrowserCollectionPage())!;
  await controlMonitor(scope, monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'PAUSE', reason: 'Pause before browser delivery' });
  await syncBrowserCollectionTasks();
  expect((await query('SELECT status FROM kff.tasks WHERE id=$1', [task.id]))[0].status).toBe('CANCELED');
  expect(await dispatchOne()).toBe(false); expect(await claimCommand(agent)).toBeNull();
  expect((await collectionDetail(scope, scan.id)).run).toMatchObject({ state: 'CANCELED', returned_count: 0 });
});

it('discards a page that naturally expires after the Agent claims it', async () => {
  const first = await setup();
  await controlCollection(scope, first.scan.id, 'STOP', { request_id: randomUUID(), expected_version: (await collectionDetail(scope, first.scan.id)).run.version, reason: 'Use a short-lived isolated query' });
  const id = randomUUID();
  const expires = (await query("INSERT INTO kff.collection_queries(id,organization_id,brand_id,request_id,account_id,title,snapshot,snapshot_hash,request_hash,created_by,expires_at) SELECT $1,organization_id,brand_id,$2,account_id,title,snapshot,snapshot_hash,request_hash,created_by,now()+interval '15 seconds' FROM kff.collection_queries WHERE id=$3 RETURNING expires_at", [id, randomUUID(), first.scan.id]))[0].expires_at;
  await query('INSERT INTO kff.collection_runs(organization_id,brand_id,query_id) VALUES($1,$2,$3)', [scope.organization_id,scope.brand_id,id]);
  const command = await nextCommand();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(new Date(expires)) - Date.now() + 100)));
  await acceptReport(agent, fakeReport(command));
  expect((await collectionDetail(scope, id)).results).toHaveLength(0);
}, 45000);

it('resumes only a confirmed read failure at the same cursor', async () => {
  const second = await setup(); const one = await nextCommand(); await acceptReport(agent, fakeReport(one));
  await confirmSyntheticClosed(one);
  const failed = await nextCommand();
  await acceptReport(agent, { event_id: randomUUID(), command_id: failed.id, outcome: 'BLOCKED', error_code: 'REMOTE_ERROR', diagnostic: { step: 'contract-source-failure' } });
  await confirmSyntheticClosed(failed);
  const stopped = await collectionDetail(scope, second.scan.id);
  expect(stopped.run).toMatchObject({ state: 'PARTIAL', committed_pages: 1 });
  await controlCollection(scope, second.scan.id, 'RESUME', { request_id: randomUUID(), expected_version: stopped.run.version, reason: 'Retry confirmed read-only source failure' });
  const resumed = await nextCommand(); expect(resumed.snapshot.collection?.cursor).toBe('offset:2');
  expect(resumed.id).not.toBe(failed.id); await acceptReport(agent, fakeReport(resumed));
  expect((await collectionDetail(scope, second.scan.id)).run).toMatchObject({ state: 'COMPLETED', returned_count: 4, unique_count: 4 });
});

it('does not let a paused account prevent another account from scheduling a browser page', async () => {
  const first = await setup(), second = await setup();
  await query('UPDATE kff.accounts SET outbound_paused=true WHERE id=$1', [first.account.account_id]);
  const task = await prepareBrowserCollectionPage();
  expect(task?.account_id).toBe(second.account.account_id);
  expect((await collectionDetail(scope, first.scan.id)).run.state).toBe('QUEUED');
});
