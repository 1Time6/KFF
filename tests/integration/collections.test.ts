import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { createCollection, claimCollection, commitCollectionPage, processCollectionPage, failCollectionClaim, collectionDetail, collectionWorkspace, collectionObservationHistory, controlCollection, purgeExpiredCollectionData, type CollectionClaim } from '../../packages/core/src/collections';
import { syntheticCollectionPage } from '../../packages/adapters/src/collection-fixture';
import type { CollectionQueryInput, Scope } from '../../packages/contracts/src/index';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const children: ChildProcess[] = [];
const defaults = async (changes: Partial<CollectionQueryInput> = {}): Promise<CollectionQueryInput> => ({ request_id: randomUUID(), title: 'Isolated collection', source_key: 'kff.fixture.page.posts', account_id: localIds.account, targets: [(await query('SELECT external_id FROM kff.accounts WHERE id=$1', [localIds.account]))[0].external_id], fields: ['message','author_id','reaction_count','comment_count','created_time'], purpose: 'software_verification', mode: 'TEST_ONLY', incremental_rule: 'append_observations', max_records: 20, max_pages: 10, page_size: 2, display_timezone: 'Asia/Shanghai', retention_days: 7, scenario: 'normal', ...changes });
async function ready() { await query("UPDATE kff.collection_runs SET available_at=now() WHERE state='QUEUED'"); }
async function drain(max = 10) { for (let index = 0; index < max; index++) { await ready(); if (!await processCollectionPage({ readPage: async request => syntheticCollectionPage(request) })) break; } }
async function claimed(changes: Partial<CollectionQueryInput> = {}) { const collection = await createCollection(scope, await defaults(changes)); const claim = (await claimCollection())!; expect(claim.query_id).toBe(collection.id); return { ...collection, claim }; }
async function killOwned(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await done; }
async function crashAt(claim: CollectionClaim, boundary: 'before' | 'after') {
  const page = syntheticCollectionPage(claim);
  const child = spawn(process.execPath, ['--import','tsx','tests/helpers/collection-process.ts',Buffer.from(JSON.stringify({ claim, page, boundary })).toString('base64')], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] }); children.push(child);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Collection transaction barrier not reached')), 10000); child.on('message', message => { if (message && typeof message === 'object' && 'barrier' in message && message.barrier === boundary) { clearTimeout(timer); resolve(); } }); child.once('exit', code => { clearTimeout(timer); reject(new Error('Collection child exited before its barrier: ' + code)); }); });
  await killOwned(child); return page;
}
beforeAll(async () => { const name = (await query('SELECT current_database() AS name'))[0].name; if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Isolated database required'); await migrate(); await seed(); });
async function reset() { await query('TRUNCATE kff.collection_queries,kff.collection_objects CASCADE'); await query("UPDATE kff.accounts SET state='ACTIVE',outbound_paused=false WHERE id=$1", [localIds.account]); await query('UPDATE kff.organizations SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); }
beforeEach(reset);
afterAll(async () => { for (const child of children) await killOwned(child); await reset(); await closePool(); });

it('creates one durable query and run under concurrent duplicate requests and rejects changed input', async () => {
  const input = await defaults(); const created = await Promise.all(Array.from({ length: 5 }, () => createCollection(scope, input)));
  expect(new Set(created.map(value => value.id)).size).toBe(1); expect(new Set(created.map(value => value.run_id)).size).toBe(1);
  expect((await query('SELECT count(*)::int AS count FROM kff.collection_runs'))[0].count).toBe(1);
  await expect(createCollection(scope, { ...input, max_records: 21 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(query("UPDATE kff.collection_queries SET title='Changed' WHERE id=$1", [created[0].id])).rejects.toThrow('IMMUTABLE_COLLECTION_RECORD');
});
it('commits five observations as four identities and preserves both versions of a repeated object', async () => {
  const collection = await createCollection(scope, await defaults()); await drain(); const detail = await collectionDetail(scope, collection.id);
  expect(detail.run).toMatchObject({ state: 'COMPLETED', committed_pages: 3, returned_count: 5, unique_count: 4, reported_total: null, stop_reason: 'SOURCE_EXHAUSTED' });
  expect(detail.results.map(row => row.source_object_id)).toEqual(['000123456789012345678901234567890','9007199254740993123456789','9007199254740993123456790','00000']);
  expect(detail.results[0].fields.message).toEqual({ kind: 'VALUE', value: '第一条记录的新观察' });
  expect(detail.results[1].fields.author_id).toEqual({ kind: 'HIDDEN' }); expect(detail.results[3].fields.message).toEqual({ kind: 'VALUE', value: '' });
  const history = await collectionObservationHistory(scope, collection.id, detail.results[0].id);
  expect(history).toHaveLength(2); expect(history[1].fields.message).toEqual({ kind: 'VALUE', value: '同名合成记录' }); expect(history[1].fields.reaction_count).toEqual({ kind: 'VALUE', value: 0 });
  await expect(query("UPDATE kff.collection_observations SET fields='{}' WHERE id=$1", [history[1].id])).rejects.toThrow('IMMUTABLE_COLLECTION_OBSERVATION');
});
it('reuses an exact committed page while rejecting a different body and concurrent checkpoint writers', async () => {
  const value = await claimed(); const page = syntheticCollectionPage(value.claim);
  const results = await Promise.all(Array.from({ length: 4 }, () => commitCollectionPage(value.claim, page)));
  expect(results.filter(result => !result.reused)).toHaveLength(1); expect((await collectionDetail(scope, value.id)).run.returned_count).toBe(2);
  await expect(commitCollectionPage(value.claim, { ...page, reported_total: 999 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await query('SELECT count(*)::int AS count FROM kff.collection_observations'))[0].count).toBe(2);
});
it('rolls back observations and checkpoint when its actual process dies before COMMIT and resumes the same page', async () => {
  const value = await claimed(); await crashAt(value.claim, 'before');
  const detail = await collectionDetail(scope, value.id); expect(detail.run.committed_pages).toBe(0); expect(detail.results).toHaveLength(0);
  for (const table of ['collection_pages','collection_observations','collection_results','collection_objects']) expect((await query('SELECT count(*)::int AS count FROM kff.' + table))[0].count).toBe(0);
  await query("UPDATE kff.collection_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [value.run_id]);
  const resumed = (await claimCollection())!; expect(resumed.cursor).toBeNull(); expect(resumed.page_number).toBe(1); expect(resumed.token).not.toBe(value.claim.token);
  await commitCollectionPage(resumed, syntheticCollectionPage(resumed)); expect((await collectionDetail(scope, value.id)).run.returned_count).toBe(2);
});
it('starts at the next confirmed page when its actual process dies after COMMIT without acknowledging it', async () => {
  const value = await claimed(); const page = await crashAt(value.claim, 'after');
  expect((await commitCollectionPage(value.claim, page)).reused).toBe(true); await ready(); const next = (await claimCollection())!;
  expect(next.page_number).toBe(2); expect(next.cursor).toBe('offset:2'); await commitCollectionPage(next, syntheticCollectionPage(next)); await drain();
  expect((await collectionDetail(scope, value.id)).run).toMatchObject({ returned_count: 5, unique_count: 4, committed_pages: 3 });
});
it('rejects expired and replaced tokens for both successful pages and failure writes', async () => {
  const value = await claimed(); const page = syntheticCollectionPage(value.claim);
  await query("UPDATE kff.collection_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [value.run_id]);
  await expect(commitCollectionPage(value.claim, page)).rejects.toMatchObject({ code: 'STALE_COLLECTION_LEASE' });
  await failCollectionClaim(value.claim, 'REMOTE_ERROR'); expect((await collectionDetail(scope, value.id)).run.state).toBe('RUNNING');
  const replacement = (await claimCollection())!;
  await expect(commitCollectionPage(value.claim, page)).rejects.toMatchObject({ code: 'STALE_COLLECTION_LEASE' });
  await commitCollectionPage(replacement, syntheticCollectionPage(replacement)); expect((await collectionDetail(scope, value.id)).run.returned_count).toBe(2);
});
it.each([['cursor_loop','CURSOR_LOOP',2,4], ['cursor_expired','CURSOR_EXPIRED',1,2], ['fail_second_page','REMOTE_ERROR',1,2]] as const)('preserves partial data when %s prevents further source progress', async (scenario, reason, pages, returned) => {
  const collection = await createCollection(scope, await defaults({ scenario })); await drain(); const detail = await collectionDetail(scope, collection.id);
  expect(detail.run).toMatchObject({ state: 'PARTIAL', stop_reason: reason, committed_pages: pages, returned_count: returned }); expect(detail.results.length).toBeGreaterThan(0);
});
it('separates a valid empty source from an empty first page with a continuation cursor', async () => {
  const empty = await createCollection(scope, await defaults({ scenario: 'empty' })); await drain();
  expect((await collectionDetail(scope, empty.id)).run).toMatchObject({ state: 'COMPLETED', returned_count: 0, unique_count: 0, committed_pages: 1 });
  const continued = await createCollection(scope, await defaults({ scenario: 'empty_first_page' })); await drain();
  expect((await collectionDetail(scope, continued.id)).run).toMatchObject({ state: 'COMPLETED', returned_count: 5, unique_count: 4, committed_pages: 4 });
});
it('enforces exact returned-row and page limits while retaining unknown source totals', async () => {
  const records = await createCollection(scope, await defaults({ max_records: 3 })); await drain();
  expect((await collectionDetail(scope, records.id)).run).toMatchObject({ state: 'PARTIAL', returned_count: 3, unique_count: 3, stop_reason: 'MAX_RECORDS', reported_total: null });
  const pages = await createCollection(scope, await defaults({ max_pages: 1 })); await drain();
  expect((await collectionDetail(scope, pages.id)).run).toMatchObject({ state: 'PARTIAL', returned_count: 2, committed_pages: 1, stop_reason: 'MAX_PAGES' });
});
it('retains the newest observation in this query when an older observation arrives on a later page', async () => {
  const value = await claimed(); const first = syntheticCollectionPage(value.claim); await commitCollectionPage(value.claim, first); await ready();
  const next = (await claimCollection())!; const second = syntheticCollectionPage(next); second.observed_at = new Date(Date.parse(first.observed_at) - 60000).toISOString(); await commitCollectionPage(next, second);
  const detail = await collectionDetail(scope, value.id); const original = detail.results.find(row => row.source_object_id === first.rows[0].source_object_id)!;
  expect(original.fields.message).toEqual({ kind: 'VALUE', value: '同名合成记录' }); expect(await collectionObservationHistory(scope, value.id, original.id)).toHaveLength(2);
});
it('stops a claimed read without accepting its later page and does not broaden stop into deleting results', async () => {
  const value = await claimed(); await commitCollectionPage(value.claim, syntheticCollectionPage(value.claim)); await ready(); const pending = (await claimCollection())!; const detail = await collectionDetail(scope, value.id);
  const input = { request_id: randomUUID(), expected_version: detail.run.version, reason: 'Synthetic operator stop' };
  await controlCollection(scope, value.id, 'STOP', input); await controlCollection(scope, value.id, 'STOP', input);
  await expect(commitCollectionPage(pending, syntheticCollectionPage(pending))).rejects.toMatchObject({ code: 'STALE_COLLECTION_LEASE' });
  expect((await collectionDetail(scope, value.id)).run).toMatchObject({ state: 'CANCELED', committed_pages: 1, returned_count: 2 });
  expect((await collectionDetail(scope, value.id)).results).toHaveLength(2);
  await expect(controlCollection(scope, value.id, 'RESUME', { ...input, request_id: randomUUID(), expected_version: (await collectionDetail(scope, value.id)).run.version })).rejects.toMatchObject({ code: 'COLLECTION_RESUME_BLOCKED' });
});
it('resumes only a recoverable read failure at the original cursor with explicit version and request deduplication', async () => {
  const value = await claimed(); await failCollectionClaim(value.claim, 'REMOTE_ERROR'); const detail = await collectionDetail(scope, value.id);
  expect(detail.run.state).toBe('FAILED'); expect(detail.results).toHaveLength(0);
  const input = { request_id: randomUUID(), expected_version: detail.run.version, reason: 'Source connection restored for synthetic test' };
  await controlCollection(scope, value.id, 'RESUME', input); await controlCollection(scope, value.id, 'RESUME', input); await drain();
  expect((await collectionDetail(scope, value.id)).run).toMatchObject({ state: 'COMPLETED', returned_count: 5, unique_count: 4 });
});
it('keeps query result pages stable and identities separate across query and account scopes', async () => {
  const first = await createCollection(scope, await defaults()); await drain(); const page = await collectionDetail(scope, first.id, '0', 2);
  expect(page.results).toHaveLength(2); expect(page.next_cursor).not.toBeNull();
  const second = await collectionDetail(scope, first.id, page.next_cursor!, 2); expect(second.results).toHaveLength(2); expect(second.next_cursor).toBeNull();
  expect(new Set([...page.results,...second.results].map(row => row.id)).size).toBe(4);
  const nextQuery = await createCollection(scope, await defaults()); await drain(); expect((await collectionDetail(scope, nextQuery.id)).run.unique_count).toBe(4);
  expect((await query('SELECT count(*)::int AS count FROM kff.collection_objects'))[0].count).toBe(4);
  const other = { ...scope, brand_id: randomUUID() }; expect(await collectionWorkspace(other)).toEqual([]);
  await expect(collectionDetail(other, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(collectionObservationHistory(other, first.id, page.results[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(createCollection({ ...scope, role: 'viewer' }, await defaults())).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await expect(createCollection(scope, await defaults({ targets: ['999999'] }))).rejects.toMatchObject({ code: 'COLLECTION_SOURCE_MISMATCH' });
  expect((await scoped(other, client => client.query('SELECT * FROM kff.collection_observations'))).rowCount).toBe(0);
});
it('respects account and organization pause before reading and records malformed source failure without rows', async () => {
  const collection = await createCollection(scope, await defaults());
  await query('UPDATE kff.accounts SET outbound_paused=true WHERE id=$1', [localIds.account]); expect(await claimCollection()).toBeNull();
  await query('UPDATE kff.accounts SET outbound_paused=false WHERE id=$1', [localIds.account]); await query('UPDATE kff.organizations SET outbound_paused=true'); expect(await claimCollection()).toBeNull();
  await query('UPDATE kff.organizations SET outbound_paused=false');
  await processCollectionPage({ readPage: async () => ({}) }); const detail = await collectionDetail(scope, collection.id);
  expect(detail.run).toMatchObject({ state: 'FAILED', error_code: 'COLLECTION_INVALID_PAGE', returned_count: 0 }); expect(detail.results).toHaveLength(0);
});

it('prevents a result from pointing to an observation from another query even within the same brand', async () => {
  const first = await createCollection(scope, await defaults()); await drain(); const second = await createCollection(scope, await defaults()); await drain();
  const original = (await collectionDetail(scope, first.id)).results[0]; const foreign = (await collectionDetail(scope, second.id)).results[0];
  await expect(query('UPDATE kff.collection_results SET observation_id=$1 WHERE id=$2', [foreign.observation_id, original.id])).rejects.toMatchObject({ code: '23503' });
  expect((await collectionDetail(scope, first.id)).results[0].observation_id).toBe(original.observation_id);
});
it('does not merge matching source IDs across different execution accounts', async () => {
  const first = await createCollection(scope, await defaults()); await drain(); const otherId = randomUUID();
  await query("INSERT INTO kff.accounts(id,organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,'Synthetic second collection account','facebook','page','99999999999999999999','ACTIVE',true)", [otherId, scope.organization_id, scope.brand_id]);
  try {
    const second = await createCollection(scope, await defaults({ account_id: otherId, targets: ['99999999999999999999'] })); await drain();
    expect((await collectionDetail(scope, second.id)).run.unique_count).toBe(4); expect((await collectionDetail(scope, first.id)).run.unique_count).toBe(4);
    expect((await query('SELECT count(*)::int AS count FROM kff.collection_objects'))[0].count).toBe(8);
  } finally { await reset(); await query('DELETE FROM kff.accounts WHERE id=$1', [otherId]); }
});
it('hides expired observations immediately and purges only expired data while retaining live observations', async () => {
  const live = await createCollection(scope, await defaults()); await drain(); const liveDetail = await collectionDetail(scope, live.id); const observation = liveDetail.results[0];
  await expect(query('DELETE FROM kff.collection_observations WHERE id=$1', [observation.observation_id])).rejects.toThrow('IMMUTABLE_COLLECTION_OBSERVATION');
  const expiredQueryId = randomUUID(); const expiredRunId = randomUUID(); const pageId = randomUUID(); const expiredObservationId = randomUUID();
  await query("INSERT INTO kff.collection_queries(id,organization_id,brand_id,request_id,account_id,title,snapshot,snapshot_hash,request_hash,created_by,created_at,expires_at) SELECT $1,organization_id,brand_id,$2,account_id,title,snapshot,snapshot_hash,request_hash,created_by,now()-interval '2 days',now()-interval '1 day' FROM kff.collection_queries WHERE id=$3", [expiredQueryId, randomUUID(), live.id]);
  await query("INSERT INTO kff.collection_runs(id,organization_id,brand_id,query_id,state,committed_pages,returned_count,unique_count) VALUES($1,$2,$3,$4,'QUEUED',1,1,1)", [expiredRunId, scope.organization_id, scope.brand_id, expiredQueryId]);
  await query('INSERT INTO kff.collection_pages(id,organization_id,brand_id,run_id,page_number,cursor_in_hash,evidence_hash,observed_at,returned_count) VALUES($1,$2,$3,$4,1,$5,$5,now(),1)', [pageId, scope.organization_id, scope.brand_id, expiredRunId, 'a'.repeat(64)]);
  const objectId = (await query('SELECT object_id FROM kff.collection_observations WHERE id=$1', [observation.observation_id]))[0].object_id;
  const version = (await query('UPDATE kff.collection_objects SET last_version=last_version+1 WHERE id=$1 RETURNING last_version', [objectId]))[0].last_version;
  await query("INSERT INTO kff.collection_observations(id,organization_id,brand_id,object_id,run_id,page_id,row_number,object_version,source_object_id,source_url,observed_at,fields,evidence_hash,allowed_purposes,expires_at) SELECT $1,organization_id,brand_id,object_id,$2,$3,0,$4,source_object_id,source_url,observed_at,fields,evidence_hash,allowed_purposes,now()-interval '1 day' FROM kff.collection_observations WHERE id=$5", [expiredObservationId, expiredRunId, pageId, version, observation.observation_id]);
  await query('INSERT INTO kff.collection_results(organization_id,brand_id,run_id,object_id,observation_id) VALUES($1,$2,$3,$4,$5)', [scope.organization_id, scope.brand_id, expiredRunId, objectId, expiredObservationId]);
  const hidden = await collectionDetail(scope, expiredQueryId); expect(hidden.expired).toBe(true); expect(hidden.results).toHaveLength(0);
  expect((await purgeExpiredCollectionData()).removed).toBe(1);
  expect((await query('SELECT id FROM kff.collection_observations WHERE id=$1', [expiredObservationId]))).toHaveLength(0);
  expect((await collectionDetail(scope, expiredQueryId)).run).toMatchObject({ state: 'PARTIAL', stop_reason: 'RETENTION_EXPIRED' });
  expect((await collectionDetail(scope, live.id)).results).toHaveLength(4);
  expect((await collectionObservationHistory(scope, live.id, observation.id))).toHaveLength(2);
});
