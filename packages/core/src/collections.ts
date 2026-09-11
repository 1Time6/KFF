import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { scoped, transaction } from '@kff/database';
import { collectionInput, collectionSnapshotSchema, collectionResumeInput, type CollectionQueryInput, type CollectionSnapshot, type CollectionQuery, type CollectionRun, type CollectionResult, type Scope } from '@kff/contracts';
import { AppError, digest, requireCondition } from './index';
import { audit, requireWrite } from './service';
import { fixtureCollectionAdapter, normalizeCollectionPage, type CollectionRead, type CollectionAdapter } from '../../adapters/src/collection-fixture';

const runColumns = 'r.id,r.query_id,r.state,r.version,r.committed_pages,r.returned_count,r.unique_count,r.reported_total::integer,r.stop_reason,r.error_code,r.started_at,r.finished_at,r.created_at';
const internalSelect = 'SELECT r.*,q.snapshot,q.snapshot_hash,q.expires_at,q.created_by FROM kff.collection_runs r JOIN kff.collection_queries q ON q.id=r.query_id AND q.organization_id=r.organization_id AND q.brand_id=r.brand_id';
interface InternalRun extends CollectionRun { organization_id: string; brand_id: string; snapshot: CollectionSnapshot; snapshot_hash: string; expires_at: string; created_by: string; next_cursor: string | null; lease_token: string; lease_until: string | null }
export interface CollectionClaim extends CollectionRead { run_id: string; organization_id: string; brand_id: string; snapshot_hash: string; token: string; page_number: number }

export async function createCollection(scope: Scope, input: CollectionQueryInput) {
  requireWrite(scope); const value = collectionInput.parse(input); const requestHash = digest(value);
  return scoped(scope, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['collection/' + scope.brand_id + '/' + value.request_id]);
    const previous = (await client.query('SELECT q.*,r.id AS run_id FROM kff.collection_queries q JOIN kff.collection_runs r ON r.query_id=q.id WHERE q.request_id=$1', [value.request_id])).rows[0];
    if (previous) { requireCondition(previous.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', '相同采集请求已有不同内容', 409); return { id: previous.id as string, run_id: previous.run_id as string }; }
    const account = (await client.query('SELECT * FROM kff.accounts WHERE id=$1 FOR SHARE', [value.account_id])).rows[0];
    requireCondition(account, 'FORBIDDEN_SCOPE', '执行账号不属于当前品牌', 403);
    requireCondition(account.is_synthetic && account.external_id === value.targets[0], 'COLLECTION_SOURCE_MISMATCH', '当前采集入口只允许本项目合成账号和相同目标', 409);
    const { request_id: requestId, ...configuration } = value;
    const snapshot = collectionSnapshotSchema.parse({ ...configuration, schema_version: 'kff.collection.v1', source_version: 'fixture-page-posts-v1', source_type: 'OWNED_FIXTURE', account_version: account.version, external_account_id: account.external_id, allowed_purposes: ['software_verification'] });
    const query = (await client.query<CollectionQuery>('INSERT INTO kff.collection_queries(organization_id,brand_id,request_id,account_id,title,snapshot,snapshot_hash,request_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(days=>$10)) RETURNING *', [scope.organization_id, scope.brand_id, requestId, account.id, value.title, snapshot, digest(snapshot), requestHash, scope.user_id, value.retention_days])).rows[0];
    const run = (await client.query('INSERT INTO kff.collection_runs(organization_id,brand_id,query_id) VALUES($1,$2,$3) RETURNING id', [scope.organization_id, scope.brand_id, query.id])).rows[0];
    await audit(client, scope, 'collection.created', query.id, { run_id: run.id, snapshot_hash: query.snapshot_hash, source_type: 'OWNED_FIXTURE' }); return { id: query.id, run_id: run.id as string };
  });
}
export async function claimCollection(): Promise<CollectionClaim | null> {
  return transaction(async client => {
    const row = (await client.query<InternalRun>(internalSelect + " JOIN kff.accounts ac ON ac.id=q.account_id AND ac.organization_id=q.organization_id AND ac.brand_id=q.brand_id JOIN kff.brands b ON b.id=q.brand_id AND b.organization_id=q.organization_id JOIN kff.organizations o ON o.id=q.organization_id WHERE ((r.state='QUEUED' AND r.available_at<=clock_timestamp()) OR (r.state='RUNNING' AND r.lease_until<=clock_timestamp())) AND NOT ac.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused ORDER BY r.available_at,r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED")).rows[0];
    if (!row) return null;
    const snapshot = collectionSnapshotSchema.parse(row.snapshot);
    const account = (await client.query('SELECT ac.*,o.outbound_paused AS organization_paused,b.outbound_paused AS brand_paused FROM kff.accounts ac JOIN kff.brands b ON b.id=ac.brand_id AND b.organization_id=ac.organization_id JOIN kff.organizations o ON o.id=ac.organization_id WHERE ac.id=$1 AND ac.organization_id=$2 AND ac.brand_id=$3 FOR SHARE OF o,b,ac', [snapshot.account_id, row.organization_id, row.brand_id])).rows[0];
    if (account?.outbound_paused || account?.organization_paused || account?.brand_paused) return null;
    const expired = (await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.expires_at])).rows[0].expired;
    const failure = expired ? 'RETENTION_EXPIRED' : !account || !account.is_synthetic || account.state !== 'ACTIVE' || account.version !== snapshot.account_version || account.external_id !== snapshot.external_account_id || digest(snapshot) !== row.snapshot_hash ? 'COLLECTION_SOURCE_MISMATCH' : null;
    if (failure) { await finishFailed(client, row, failure); return null; }
    const lease = (await client.query("UPDATE kff.collection_runs SET state='RUNNING',lease_token=lease_token+1,lease_until=clock_timestamp()+interval '30 seconds',version=version+1,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 RETURNING lease_token", [row.id])).rows[0];
    return { run_id: row.id, query_id: row.query_id, organization_id: row.organization_id, brand_id: row.brand_id, snapshot, snapshot_hash: row.snapshot_hash, token: lease.lease_token as string, page_number: row.committed_pages + 1, cursor: row.next_cursor, limit: Math.min(snapshot.page_size, snapshot.max_records - row.returned_count) };
  });
}
async function finishFailed(client: PoolClient, row: InternalRun, code: string) {
  await client.query("UPDATE kff.collection_runs SET state=CASE WHEN committed_pages>0 THEN 'PARTIAL' ELSE 'FAILED' END,stop_reason=$1,error_code=$1,lease_until=NULL,version=version+1,finished_at=now(),updated_at=now() WHERE id=$2", [code, row.id]);
  await audit(client, { organization_id: row.organization_id, brand_id: row.brand_id, user_id: row.created_by, role: 'operator' }, 'collection.stopped', row.query_id, { run_id: row.id, code, committed_pages: row.committed_pages });
}
function matchClaim(row: InternalRun | undefined, claim: CollectionClaim) {
  requireCondition(row && row.query_id === claim.query_id && row.organization_id === claim.organization_id && row.brand_id === claim.brand_id && row.snapshot_hash === claim.snapshot_hash && digest(claim.snapshot) === row.snapshot_hash, 'COLLECTION_CLAIM_MISMATCH', '分页领取与原查询不一致', 409); return row;
}
export async function commitCollectionPage(claim: CollectionClaim, input: unknown, beforeCommit?: () => Promise<void>) {
  const page = normalizeCollectionPage(input, claim); const pageHash = digest(page); const cursorHash = digest(claim.cursor);
  return transaction(async client => {
    const row = matchClaim((await client.query<InternalRun>(internalSelect + ' WHERE r.id=$1 FOR UPDATE OF r', [claim.run_id])).rows[0], claim);
    const previous = (await client.query('SELECT evidence_hash,cursor_in_hash FROM kff.collection_pages WHERE run_id=$1 AND page_number=$2', [row.id, claim.page_number])).rows[0];
    if (previous) { requireCondition(previous.evidence_hash === pageHash && previous.cursor_in_hash === cursorHash, 'IDEMPOTENCY_CONFLICT', '同一页已有不同证据', 409); return { committed: true, reused: true }; }
    const clock = (await client.query('SELECT $1::timestamptz>clock_timestamp() AS lease_valid,$2::timestamptz>clock_timestamp() AS retention_valid', [row.lease_until, row.expires_at])).rows[0];
    requireCondition(row.state === 'RUNNING' && row.lease_token === claim.token && clock.lease_valid && clock.retention_valid, 'STALE_COLLECTION_LEASE', '采集租约已过期、停止或被新工作者替代', 409);
    requireCondition(row.committed_pages + 1 === claim.page_number && row.next_cursor === claim.cursor && claim.limit === Math.min(row.snapshot.page_size, row.snapshot.max_records - row.returned_count) && page.rows.length <= row.snapshot.max_records - row.returned_count, 'COLLECTION_CHECKPOINT_CONFLICT', '分页位置或剩余上限已变化', 409);
    const nextHash = page.next_cursor === null ? null : digest(page.next_cursor);
    const loop = nextHash !== null && (nextHash === cursorHash || Boolean((await client.query('SELECT 1 FROM kff.collection_pages WHERE run_id=$1 AND cursor_in_hash=$2', [row.id, nextHash])).rowCount));
    const pageId = randomUUID();
    await client.query('INSERT INTO kff.collection_pages(id,organization_id,brand_id,run_id,page_number,cursor_in_hash,next_cursor_hash,evidence_hash,observed_at,returned_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [pageId, row.organization_id, row.brand_id, row.id, claim.page_number, cursorHash, nextHash, pageHash, page.observed_at, page.rows.length]);
    const objects = new Map<string, { id: string; last_version: number }>();
    // Every page locks shared identities in the same order, even across queries.
    for (const objectId of [...new Set(page.rows.map(record => record.source_object_id))].sort()) {
      await client.query('INSERT INTO kff.collection_objects(organization_id,brand_id,account_id,source_key,source_object_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,brand_id,account_id,source_key,source_object_id) DO NOTHING', [row.organization_id, row.brand_id, row.snapshot.account_id, row.snapshot.source_key, objectId]);
      const object = (await client.query('SELECT id,last_version FROM kff.collection_objects WHERE organization_id=$1 AND brand_id=$2 AND account_id=$3 AND source_key=$4 AND source_object_id=$5 FOR UPDATE', [row.organization_id, row.brand_id, row.snapshot.account_id, row.snapshot.source_key, objectId])).rows[0]; objects.set(objectId, object);
    }
    for (const [index, record] of page.rows.entries()) {
      const object = objects.get(record.source_object_id)!; object.last_version++;
      await client.query('UPDATE kff.collection_objects SET last_version=$1 WHERE id=$2', [object.last_version, object.id]);
      const observationId = randomUUID();
      await client.query('INSERT INTO kff.collection_observations(id,organization_id,brand_id,object_id,run_id,page_id,row_number,object_version,source_object_id,source_url,observed_at,fields,evidence_hash,allowed_purposes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [observationId, row.organization_id, row.brand_id, object.id, row.id, pageId, index, object.last_version, record.source_object_id, record.source_url, page.observed_at, record.fields, digest({ source_version: page.source_version, observed_at: page.observed_at, ...record }), JSON.stringify(row.snapshot.allowed_purposes), row.expires_at]);
      await client.query('INSERT INTO kff.collection_results(organization_id,brand_id,run_id,object_id,observation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,object_id) DO UPDATE SET observation_id=EXCLUDED.observation_id WHERE (SELECT observed_at FROM kff.collection_observations WHERE id=kff.collection_results.observation_id)<=$6::timestamptz', [row.organization_id, row.brand_id, row.id, object.id, observationId, page.observed_at]);
    }
    const returned = row.returned_count + page.rows.length; const pages = row.committed_pages + 1;
    const reason = loop ? 'CURSOR_LOOP' : page.next_cursor === null ? 'SOURCE_EXHAUSTED' : returned >= row.snapshot.max_records ? 'MAX_RECORDS' : pages >= row.snapshot.max_pages ? 'MAX_PAGES' : null;
    const state = reason === 'SOURCE_EXHAUSTED' ? 'COMPLETED' : reason ? 'PARTIAL' : 'QUEUED';
    await client.query("UPDATE kff.collection_runs SET state=$1,committed_pages=$2,returned_count=$3,unique_count=(SELECT count(*) FROM kff.collection_results WHERE run_id=$10),reported_total=$4,next_cursor=$5,stop_reason=$6,error_code=$7,lease_until=NULL,version=version+1,available_at=now()+interval '500 milliseconds',finished_at=CASE WHEN $8 THEN now() ELSE NULL END,updated_at=now() WHERE id=$10 AND lease_token=$9", [state, pages, returned, page.reported_total, page.next_cursor, reason, loop ? 'CURSOR_LOOP' : null, reason !== null, claim.token, row.id]);
    await audit(client, { organization_id: row.organization_id, brand_id: row.brand_id, user_id: row.created_by, role: 'operator' }, 'collection.page_committed', row.query_id, { run_id: row.id, page_number: pages, returned: page.rows.length, evidence_hash: pageHash, stop_reason: reason });
    await beforeCommit?.(); return { committed: true, reused: false };
  });
}
export async function failCollectionClaim(claim: CollectionClaim, code: string) {
  return transaction(async client => {
    const row = matchClaim((await client.query<InternalRun>(internalSelect + ' WHERE r.id=$1 FOR UPDATE OF r', [claim.run_id])).rows[0], claim);
    if (row.state !== 'RUNNING' || row.lease_token !== claim.token) return;
    if (!(await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [row.lease_until])).rows[0].valid) return;
    const mapped = ['CURSOR_EXPIRED', 'COLLECTION_SOURCE_MISMATCH', 'COLLECTION_FIELDS_MISMATCH', 'COLLECTION_LIMIT_EXCEEDED', 'COLLECTION_INVALID_PAGE'].includes(code) ? code : 'REMOTE_ERROR';
    await finishFailed(client, row, mapped);
  });
}
export async function processCollectionPage(adapter: CollectionAdapter = fixtureCollectionAdapter) {
  const claim = await claimCollection(); if (!claim) return false;
  try { const page = await adapter.readPage(claim); await commitCollectionPage(claim, page); }
  catch (error) { if (!(error instanceof AppError && ['STALE_COLLECTION_LEASE', 'COLLECTION_CHECKPOINT_CONFLICT'].includes(error.code))) await failCollectionClaim(claim, error instanceof z.ZodError ? 'COLLECTION_INVALID_PAGE' : error instanceof AppError ? error.code : 'REMOTE_ERROR'); }
  return true;
}
export async function collectionWorkspace(scope: Scope) {
  return scoped(scope, async client => (await client.query('SELECT q.id,q.title,q.snapshot,q.snapshot_hash,q.created_at,q.expires_at,r.id AS run_id,r.state,r.stop_reason,r.error_code,r.committed_pages,r.returned_count,r.unique_count,r.reported_total::integer,r.version FROM kff.collection_queries q JOIN kff.collection_runs r ON r.query_id=q.id ORDER BY q.created_at DESC,q.id LIMIT 100')).rows);
}
export async function collectionDetail(scope: Scope, queryId: string, after = '0', limit = 25) {
  requireCondition(/^(0|[1-9][0-9]{0,18})$/.test(after) && BigInt(after) <= 9223372036854775807n && Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_INPUT', '结果分页参数无效');
  return scoped(scope, async client => {
    const query = (await client.query<CollectionQuery>('SELECT id,title,snapshot,snapshot_hash,created_at,expires_at FROM kff.collection_queries WHERE id=$1', [queryId])).rows[0];
    requireCondition(query, 'NOT_FOUND', '查询不存在', 404);
    const run = (await client.query<CollectionRun>('SELECT ' + runColumns + ' FROM kff.collection_runs r WHERE query_id=$1', [queryId])).rows[0];
    const expired = (await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [query.expires_at])).rows[0].expired as boolean;
    const rows = (await client.query<CollectionResult>('SELECT r.id,r.observation_id,r.result_order::text,o.source_object_id,o.observed_at,o.source_url,o.fields,o.evidence_hash,o.allowed_purposes,o.expires_at,o.object_version FROM kff.collection_results r JOIN kff.collection_observations o ON o.id=r.observation_id WHERE r.run_id=$1 AND r.result_order>$2::bigint AND o.expires_at>clock_timestamp() ORDER BY r.result_order LIMIT $3', [run.id, after, limit + 1])).rows;
    const pages = (await client.query('SELECT page_number,evidence_hash,observed_at,returned_count FROM kff.collection_pages WHERE run_id=$1 ORDER BY page_number', [run.id])).rows;
    return { query, run, results: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].result_order : null, expired, pages };
  });
}
export async function collectionObservationHistory(scope: Scope, queryId: string, resultId: string) {
  return scoped(scope, async client => {
    const result = (await client.query('SELECT x.object_id,x.run_id FROM kff.collection_results x JOIN kff.collection_runs r ON r.id=x.run_id WHERE r.query_id=$1 AND x.id=$2', [queryId, resultId])).rows[0];
    requireCondition(result, 'NOT_FOUND', '结果不存在或已到期', 404);
    return (await client.query('SELECT id,source_object_id,source_url,object_version,observed_at,fields,evidence_hash,allowed_purposes,expires_at FROM kff.collection_observations WHERE run_id=$1 AND object_id=$2 AND expires_at>clock_timestamp() ORDER BY object_version DESC LIMIT 100', [result.run_id, result.object_id])).rows;
  });
}
export async function controlCollection(scope: Scope, queryId: string, action: 'STOP' | 'RESUME', input: z.infer<typeof collectionResumeInput>) {
  requireWrite(scope); const value = collectionResumeInput.parse(input); const hash = digest({ query_id: queryId, action, ...value });
  return scoped(scope, async client => {
    const row = (await client.query<InternalRun>(internalSelect + ' WHERE r.query_id=$1 FOR UPDATE OF r', [queryId])).rows[0];
    requireCondition(row, 'NOT_FOUND', '查询不存在', 404);
    const previous = (await client.query('SELECT request_hash,details FROM kff.collection_events WHERE id=$1', [value.request_id])).rows[0];
    if (previous) { requireCondition(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '此采集控制请求已有不同内容', 409); return previous.details; }
    requireCondition(row.version === value.expected_version, 'VERSION_CONFLICT', '查询状态已变化，请刷新', 409);
    if (action === 'STOP') requireCondition(['QUEUED','RUNNING'].includes(row.state), 'VERSION_CONFLICT', '查询已经停止', 409);
    else {
      requireCondition(['FAILED','PARTIAL'].includes(row.state) && row.error_code === 'REMOTE_ERROR', 'COLLECTION_RESUME_BLOCKED', '此停止原因不能继续原游标，请核对来源后创建新查询', 409);
      requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [row.expires_at])).rows[0].valid, 'RETENTION_EXPIRED', '查询保留期已结束', 409);
    }
    const result = (await client.query("UPDATE kff.collection_runs SET state=$1,stop_reason=$2,error_code=NULL,lease_token=lease_token+1,lease_until=NULL,version=version+1,available_at=now(),finished_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now() WHERE id=$4 RETURNING state,version", [action === 'STOP' ? 'CANCELED' : 'QUEUED', action === 'STOP' ? 'STOP_REQUESTED' : null, action === 'STOP', row.id])).rows[0];
    await client.query('INSERT INTO kff.collection_events(id,organization_id,brand_id,run_id,actor_id,event_type,request_hash,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [value.request_id, scope.organization_id, scope.brand_id, row.id, scope.user_id, action, hash, { ...result, reason: value.reason }]);
    await audit(client, scope, 'collection.' + action.toLowerCase(), queryId, { run_id: row.id, reason: value.reason }); return { ...result, reason: value.reason };
  });
}
export async function purgeExpiredCollectionData() {
  return transaction(async client => {
    await client.query("UPDATE kff.collection_runs r SET state=CASE WHEN committed_pages>0 THEN 'PARTIAL' ELSE 'FAILED' END,stop_reason='RETENTION_EXPIRED',error_code='RETENTION_EXPIRED',lease_token=lease_token+1,lease_until=NULL,version=version+1,finished_at=now() FROM kff.collection_queries q WHERE q.id=r.query_id AND q.expires_at<=clock_timestamp() AND r.state IN ('QUEUED','RUNNING')");
    const removed = await client.query('DELETE FROM kff.collection_observations WHERE id IN (SELECT id FROM kff.collection_observations WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING organization_id,brand_id');
    for (const key of new Set(removed.rows.map(row => row.organization_id + '/' + row.brand_id))) {
      const [organization, brand] = key.split('/');
      await client.query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$1,'collection.retention_purged',$2,$3)", [organization, brand, { actor_kind: 'system', expired_observations: removed.rows.filter(row => row.organization_id === organization && row.brand_id === brand).length }]);
    }
    await client.query('DELETE FROM kff.collection_objects o WHERE NOT EXISTS(SELECT 1 FROM kff.collection_observations x WHERE x.object_id=o.id) AND o.last_version>0');
    return { removed: removed.rowCount ?? 0 };
  });
}
