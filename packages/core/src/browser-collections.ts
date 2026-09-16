import {derivedMonitorActive} from './acquisition-continuation';
import type { PoolClient } from 'pg';
import { query, transaction } from '@kff/database';
import type { ActionReport, Scope, TaskSnapshot } from '@kff/contracts';
import { collectionSnapshotSchema } from '@kff/contracts';
import { browserCollectionTaskSchema } from '../../contracts/src/browser-collection';
import { AppError, digest, requireCondition } from './index';
import { audit, createTaskInTransaction, enqueueTaskInTransaction, stopRun } from './service';
import { commitCollectionPageInTransaction, finishFailed, internalSelect, type InternalRun } from './collections';
import { createPermitInTransaction } from './permits';

/** One page is one ordinary task. No browser or independent execution lease lives in Worker. */
export async function prepareBrowserCollectionPage() {
  return transaction(async client => {
    const row = (await client.query<InternalRun>(internalSelect + " JOIN kff.accounts ac ON ac.id=q.account_id JOIN kff.brands b ON b.id=q.brand_id JOIN kff.organizations o ON o.id=q.organization_id WHERE NOT ac.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused AND q.snapshot->'discovery'->>'provider'='LOCAL_BROWSER' AND r.state='QUEUED' AND r.browser_task_id IS NULL AND r.available_at<=clock_timestamp() ORDER BY r.available_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED")).rows[0];
    if (!row) return null;
    const scope: Scope = { organization_id: row.organization_id, brand_id: row.brand_id, user_id: row.created_by, role: 'admin' };
    await client.query("SELECT set_config('kff.organization_id',$1,true),set_config('kff.brand_id',$2,true),set_config('kff.user_id',$3,true)", [scope.organization_id, scope.brand_id, scope.user_id]);
    await client.query('SET LOCAL ROLE kff_app');
    await client.query('SAVEPOINT browser_page');
    try {
      const snapshot = collectionSnapshotSchema.parse(row.snapshot);
      const environment = snapshot.browser_environment;
      requireCondition(environment && digest(snapshot) === row.snapshot_hash, 'COLLECTION_SOURCE_MISMATCH', '浏览器采集快照不一致', 409);
      const account = (await client.query('SELECT a.*,b.outbound_paused AS brand_paused,o.outbound_paused AS organization_paused FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE a.id=$1 FOR SHARE OF a', [snapshot.account_id])).rows[0];
      if (account?.outbound_paused || account?.brand_paused || account?.organization_paused) return null;
      const realBrowser = ['facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1'].includes(snapshot.discovery?.browser?.template ?? '');
      requireCondition((account?.state === 'ACTIVE' || realBrowser && account?.state === 'DRAFT') && account.is_synthetic === !realBrowser && (!realBrowser || account.platform === 'facebook' && account.account_type === 'profile') && account.version === snapshot.account_version && account.external_id === snapshot.external_account_id, 'COLLECTION_SOURCE_MISMATCH', '采集账号已经变化', 409);
      requireCondition((await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [row.expires_at])).rows[0].valid, 'RETENTION_EXPIRED', '查询保留期已结束', 409);
      const capability = (await client.query('SELECT id FROM kff.capabilities WHERE account_id=$1 AND capability_key=$2', [snapshot.account_id, realBrowser ? 'facebook.discovery.read.browser' : 'kff.fixture.discovery.read.browser'])).rows[0];
      requireCondition(capability, 'SOURCE_NOT_CONFIGURED', '当前账号尚未配置浏览器采集能力', 409);
      const collection = browserCollectionTaskSchema.parse({ run_id: row.id, query_id: row.query_id, token: String(BigInt(row.lease_token) + 1n), page_number: row.committed_pages + 1, cursor: row.next_cursor, limit: Math.min(snapshot.page_size, snapshot.max_records - row.returned_count), snapshot, snapshot_hash: row.snapshot_hash, expires_at: new Date(row.expires_at).toISOString() });
      const task = await createTaskInTransaction(client, scope, { title: snapshot.title.slice(0, 95) + ' · 页 ' + collection.page_number, account_id: snapshot.account_id, environment_id: environment.environment_id, capability_id: capability.id, body: '', mode: realBrowser ? 'CONTROLLED_PILOT' : 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: 'collection_' + row.id + '_' + collection.token }, collection);
      // Admin authorization to run this read-only query covers its bounded pages.
      await client.query("INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,'APPROVED',$5)", [scope.organization_id, scope.brand_id, task.id, task.snapshot_hash, scope.user_id]);
      await client.query("UPDATE kff.tasks SET status='APPROVED' WHERE id=$1", [task.id]);
      if (realBrowser) await createPermitInTransaction(client, scope, {
        task_id: task.id, max_actions: 1, starts_at: new Date().toISOString(), expires_at: new Date(Math.min(Date.parse(collection.expires_at!), Date.now() + 3600000)).toISOString(),
        currency: 'USD', max_cost_minor: '0', per_action_max_minor: '0', cost_basis: '读取已登录浏览器的可见页面；不调用按量付费采集服务或购买接口，现有订阅费用不在本动作重复计费。',
        authorization_evidence: '管理员创建的只读采集查询 ' + row.query_id + '，固定摘要 ' + row.snapshot_hash + '，本页上限 ' + collection.limit + ' 条。',
        platform_conditions: snapshot.discovery!.processing_basis, expected_evidence: 'collection_page', stop_rule: 'stop_on_first_unknown_or_failure', confirmation: 'I_CONFIRM_THIS_EXACT_SCOPE',
      });
      await enqueueTaskInTransaction(client, scope, task.id);
      await client.query("UPDATE kff.collection_runs SET state='RUNNING',browser_task_id=$2,lease_token=$3,lease_until=NULL,version=version+1,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1", [row.id, task.id, collection.token]);
      await audit(client, scope, 'collection.browser_page_queued', row.query_id, { task_id: task.id, page_number: collection.page_number, authorization: 'admin_collection_query', snapshot_hash: task.snapshot_hash });
      return task;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT browser_page');
      if (!(error instanceof AppError)) throw error;
      await finishFailed(client, row, error.code); return null;
    }
  });
}

export async function browserCollectionTaskActive(client: PoolClient, taskId: string, snapshot: TaskSnapshot) {
  const page = snapshot.collection; if (!page) return true;
  const source=(await client.query('SELECT monitor_id FROM kff.acquisition_scans WHERE query_id=$1',[page.query_id])).rows[0];
  if(source&&!await derivedMonitorActive(client,source.monitor_id))return false;
  const row = (await client.query("SELECT r.state,r.lease_token,r.browser_task_id,q.snapshot_hash,q.expires_at>clock_timestamp() AS retained,a.state AS account_state,a.version AS account_version,a.outbound_paused OR b.outbound_paused OR o.outbound_paused AS paused,e.configuration_version,e.browser_configuration FROM kff.collection_runs r JOIN kff.collection_queries q ON q.id=r.query_id JOIN kff.accounts a ON a.id=q.account_id JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id JOIN kff.environments e ON e.id=$2 AND e.account_id=a.id WHERE r.id=$1 AND q.id=$3 FOR SHARE OF a,b,o,e", [page.run_id, snapshot.environment_id, page.query_id])).rows[0];
  return Boolean(row && row.state === 'RUNNING' && row.browser_task_id === taskId && row.lease_token === page.token && row.snapshot_hash === page.snapshot_hash && row.retained && !row.paused && (row.account_state === 'ACTIVE' || snapshot.capability_key === 'facebook.discovery.read.browser' && row.account_state === 'DRAFT' && snapshot.mode === 'CONTROLLED_PILOT') && row.account_version === snapshot.account_version && row.configuration_version === snapshot.environment_version && digest(row.browser_configuration) === digest(snapshot.browser_environment?.configuration));
}

/** Called in the existing report transaction after command/Agent resource leases are verified. */
export async function acceptBrowserCollectionReport(client: PoolClient, taskId: string, snapshot: TaskSnapshot, report: ActionReport) {
  const page = snapshot.collection;
  if (!page) { requireCondition(!report.collection_page, 'INVALID_INPUT', '普通动作不能携带采集页'); return; }
  const row = (await client.query<InternalRun>(internalSelect + ' WHERE r.id=$1 FOR UPDATE OF r', [page.run_id])).rows[0];
  requireCondition(row && row.query_id === page.query_id && row.snapshot_hash === page.snapshot_hash && digest(page.snapshot) === page.snapshot_hash, 'COLLECTION_SOURCE_MISMATCH', '回执与采集查询不一致', 409);
  if (report.outcome === 'VERIFIED_SUCCEEDED') requireCondition(report.collection_page && report.receipt?.content_hash === digest(report.collection_page) && report.receipt.remote_id === 'collection:' + page.run_id + ':' + page.page_number, 'COLLECTION_SOURCE_MISMATCH', '回执必须包含原分页内容摘要', 409);
  else requireCondition(!report.collection_page, 'INVALID_INPUT', '失败动作不能导入采集页');
  const active = await browserCollectionTaskActive(client, taskId, snapshot);
  const scope: Scope = { organization_id: row.organization_id, brand_id: row.brand_id, user_id: row.created_by, role: 'admin' };
  if (!active) {
    if (row.state === 'RUNNING' && row.browser_task_id === taskId && row.lease_token === page.token) await finishFailed(client, row, 'STOP_REQUESTED');
    await audit(client, scope, 'collection.browser_page_discarded', row.query_id, { task_id: taskId, page_number: page.page_number, reason: 'query_stopped_expired_or_changed' }); return;
  }
  if (report.outcome !== 'VERIFIED_SUCCEEDED') {
    await finishFailed(client, row, report.error_code ?? 'BROWSER_COLLECTION_FAILED');
    await client.query('UPDATE kff.collection_runs SET browser_task_id=NULL WHERE id=$1', [row.id]); return;
  }
  await commitCollectionPageInTransaction(client, { ...page, organization_id: row.organization_id, brand_id: row.brand_id }, report.collection_page, taskId);
}

export async function syncBrowserCollectionTasks() {
  // Select without holding collection locks, then use the ordinary run-stop transaction.
  const stopped = await query<{ id: string; organization_id: string; brand_id: string; created_by: string }>("SELECT r.id,t.organization_id,t.brand_id,t.created_by FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id JOIN kff.collection_runs c ON c.browser_task_id=t.id JOIN kff.collection_queries q ON q.id=c.query_id WHERE r.status IN ('QUEUED','RUNNING') AND (NOT r.stop_requested OR r.status='QUEUED') AND (c.state<>'RUNNING' OR c.lease_token::text<>t.snapshot->'collection'->>'token' OR q.expires_at<=clock_timestamp()) LIMIT 100");
  for (const row of stopped) await stopRun({ organization_id: row.organization_id, brand_id: row.brand_id, user_id: row.created_by, role: 'admin' }, row.id, 'COLLECTION_STOPPED');
  return transaction(async client => {
    await client.query("UPDATE kff.collection_runs c SET state=CASE WHEN committed_pages>0 THEN 'PARTIAL' ELSE 'FAILED' END,stop_reason=COALESCE(a.error_code,'BROWSER_TASK_ENDED'),error_code=COALESCE(a.error_code,'BROWSER_TASK_ENDED'),browser_task_id=NULL,version=c.version+1,finished_at=now(),updated_at=now() FROM kff.tasks t JOIN kff.actions a ON a.task_id=t.id WHERE c.browser_task_id=t.id AND c.state='RUNNING' AND t.status IN ('SUCCEEDED','FAILED','CANCELED','NEEDS_HUMAN')");
  });
}
