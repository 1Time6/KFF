import type { PoolClient } from 'pg';
import { scoped, transaction, query } from '@kff/database';
import type { Scope, TaskSnapshot, ActionReport } from '@kff/contracts';
import { browserInboxBinding, browserInboxMonitorInput, browserInboxControl, browserInboxTask, type BrowserInboxBinding, type BrowserInboxDiscoverySummary } from '../../contracts/src/browser-inbox';
import { AppError, digest, requireCondition } from './index';
import { audit, requireAdmin, createTaskInTransaction, enqueueTaskInTransaction, stopRun } from './service';
import { ensureBundledTemplates } from './templates';
import { receiveBrowserInboxBatchInTransaction } from './facebook-inbound';
import { createPermitInTransaction } from './permits';

export interface BrowserInboxMonitor {
  id: string; organization_id: string; brand_id: string; account_id: string; environment_id: string;
  binding: BrowserInboxBinding; state: 'ACTIVE' | 'PAUSED'; version: number; scan_requested: boolean;
  interval_seconds: number; page_size: number; raw_retention_hours: number; cursor: string | null;
  page_token: string; cycle_id: string; cycle_pages: number; current_task_id: string | null;
  next_poll_at: string; last_polled_at: string | null; last_error_code: string | null; created_by: string;
}
const owner = (m: BrowserInboxMonitor): Scope => ({ organization_id: m.organization_id, brand_id: m.brand_id, user_id: m.created_by, role: 'admin' });
async function replay(client: PoolClient, scope: Scope, id: string, hash: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['browser-inbox/' + scope.brand_id + '/' + id]);
  const row = (await client.query("SELECT details FROM kff.audit_events WHERE event_type LIKE 'browser_inbox.%' AND details->>'request_id'=$1", [id])).rows[0];
  if (row) requireCondition(row.details.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '请求标识已用于其他内容', 409);
  return row?.details.result as BrowserInboxMonitor | undefined;
}
export const browserInboxWorkspace = (scope: Scope) => scoped(scope, async client => ({
  monitors: (await client.query<BrowserInboxMonitor>('SELECT * FROM kff.browser_inbox_monitors ORDER BY created_at,id')).rows,
  checkpoints: (await client.query('SELECT * FROM kff.browser_inbox_checkpoints ORDER BY created_at DESC,task_id LIMIT 100')).rows,
  reads: (await client.query<{monitor_id:string;discovery:BrowserInboxDiscoverySummary}>('SELECT object_id AS monitor_id,details->\'discovery\' AS discovery FROM kff.audit_events WHERE event_type=\'browser_inbox.page_committed\' AND details ? \'discovery\' ORDER BY created_at DESC,id DESC LIMIT 100')).rows,
}));

export async function configureBrowserInbox(scope: Scope, input: unknown) {
  requireAdmin(scope); const v = browserInboxMonitorInput.parse(input), hash = digest({ operation: 'configure', ...v });
  return scoped(scope, async client => {
    const prior = await replay(client, scope, v.request_id, hash); if (prior) return prior;
    const e = (await client.query('SELECT e.*,a.version AS account_version,a.external_id,a.platform,a.account_type,a.is_synthetic FROM kff.environments e JOIN kff.accounts a ON a.id=e.account_id WHERE e.id=$1', [v.environment_id])).rows[0];
    const real = e && !e.is_synthetic;
    requireCondition(e && e.platform === 'facebook' && (real ? e.account_type === 'profile' && e.browser_configuration?.driver === 'adspower' && Boolean(v.target ? v.target.peer_id !== e.external_id : v.discovery) : e.browser_configuration?.driver === 'native' && !v.target && !v.discovery), 'SOURCE_NOT_CONFIGURED', '真实收件需要指定个人账号、AdsPower 环境和明确的会话范围', 409);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['browser-inbox-account/' + e.account_id]);
    const existing = (await client.query<BrowserInboxMonitor>('SELECT * FROM kff.browser_inbox_monitors WHERE account_id=$1 FOR UPDATE', [e.account_id])).rows[0];
    requireCondition((existing?.version ?? 0) === v.expected_version, 'VERSION_CONFLICT', '收件监控已变化，请刷新', 409);
    requireCondition(!existing?.current_task_id && !existing?.scan_requested && existing?.state !== 'ACTIVE', 'RESOURCE_BUSY', '请先暂停监控并等待当前环境关闭', 409);
    const binding = browserInboxBinding.parse({ account_version: e.account_version, ...(real ? v.target ? {target:v.target} : {discovery:v.discovery} : {}), environment: { environment_id: e.id, account_id: e.account_id, agent_id: e.agent_id, organization_id: scope.organization_id, brand_id: scope.brand_id, profile_key: e.profile_key, configuration_version: e.configuration_version, configuration: e.browser_configuration, ...(e.account_type === 'profile' ? {account_type:'profile'} : {}), platform: e.platform, is_synthetic: e.is_synthetic } });
    requireCondition(binding.environment.configuration.operating_identity_id === e.external_id, 'ACCOUNT_MISMATCH', '操作身份与账号不一致', 409);
    await client.query('INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING', [scope.organization_id, scope.brand_id, e.account_id, real ? 'facebook.inbox.read.browser' : 'kff.fixture.inbox.read.browser', real ? 'facebook-inbox-browser-v1' : 'browser-inbox-v1', real ? 'UNASSESSED' : 'IMPLEMENTED_TEST_ONLY', real ? 'DISABLED' : 'TEST_ONLY', !real, real ? '读取指定加密会话中可见的文字消息；不建立发送权限' : '读取本地合成会话 DOM，写入 Inbox 和收件检查点']);
    await ensureBundledTemplates(client, scope);
    const result = (existing ? await client.query<BrowserInboxMonitor>("UPDATE kff.browser_inbox_monitors SET environment_id=$2,binding=$3,interval_seconds=$4,page_size=$5,raw_retention_hours=$6,version=version+1,cursor=NULL,cycle_pages=0,cycle_id=gen_random_uuid(),last_error_code=NULL,created_by=$7 WHERE id=$1 RETURNING *", [existing.id, e.id, binding, v.interval_seconds, v.page_size, v.raw_retention_hours, scope.user_id]) : await client.query<BrowserInboxMonitor>('INSERT INTO kff.browser_inbox_monitors(organization_id,brand_id,account_id,environment_id,binding,interval_seconds,page_size,raw_retention_hours,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [scope.organization_id, scope.brand_id, e.account_id, e.id, binding, v.interval_seconds, v.page_size, v.raw_retention_hours, scope.user_id])).rows[0];
    await audit(client, scope, 'browser_inbox.configured', result.id, { request_id: v.request_id, request_hash: hash, result }); return result;
  });
}
export async function controlBrowserInbox(scope: Scope, id: string, input: unknown) {
  requireAdmin(scope); const v = browserInboxControl.parse(input), hash = digest({ id, ...v });
  return scoped(scope, async client => {
    const prior = await replay(client, scope, v.request_id, hash); if (prior) return prior;
    const m = (await client.query<BrowserInboxMonitor>('SELECT * FROM kff.browser_inbox_monitors WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireCondition(m && m.version === v.expected_version, 'VERSION_CONFLICT', '收件监控已变化，请刷新', 409);
    if (v.action !== 'PAUSE') requireCondition(!m.current_task_id && !m.scan_requested && m.state === 'PAUSED', 'RESOURCE_BUSY', '当前收件尚未结束或关闭', 409);
    const result = (await client.query<BrowserInboxMonitor>("UPDATE kff.browser_inbox_monitors SET state=$2,scan_requested=$3,version=version+1,next_poll_at=clock_timestamp(),last_error_code=NULL WHERE id=$1 RETURNING *", [id, v.action === 'START' ? 'ACTIVE' : 'PAUSED', v.action === 'SCAN'])).rows[0];
    await audit(client, scope, 'browser_inbox.controlled', id, { request_id: v.request_id, request_hash: hash, result }); return result;
  });
}

async function bindingCurrent(client: PoolClient, binding: BrowserInboxBinding, lockParents = true) {
  const e = binding.environment;
  const row = (await client.query('SELECT e.*,a.version AS account_version,a.external_id,a.state AS account_state,a.is_synthetic,a.outbound_paused OR b.outbound_paused OR o.outbound_paused AS paused FROM kff.environments e JOIN kff.accounts a ON a.id=e.account_id JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE e.id=$1 AND e.account_id=$2 AND e.organization_id=$3 AND e.brand_id=$4 FOR SHARE OF a,e' + (lockParents ? ',b,o' : ''), [e.environment_id, e.account_id, e.organization_id, e.brand_id])).rows[0];
  return Boolean(row && !row.paused && (row.account_state === 'ACTIVE' || row.account_state === 'DRAFT' && !e.is_synthetic && e.account_type === 'profile' && (binding.target||binding.discovery)) && !['DISABLED', 'QUARANTINED'].includes(row.state) && row.account_version === binding.account_version && row.external_id === e.configuration.operating_identity_id && row.is_synthetic === e.is_synthetic && row.configuration_version === e.configuration_version && row.profile_key === e.profile_key && row.agent_id === e.agent_id && digest(row.browser_configuration) === digest(e.configuration));
}
export async function browserInboxTaskActive(client: PoolClient, taskId: string, snapshot: TaskSnapshot) {
  const page = snapshot.inbox; if (!page) return true;
  const m = (await client.query<BrowserInboxMonitor>('SELECT * FROM kff.browser_inbox_monitors WHERE id=$1', [page.monitor_id])).rows[0];
  return Boolean(m && (m.state === 'ACTIVE' || m.scan_requested) && m.current_task_id === taskId && m.version === page.monitor_version && m.page_token === page.token && m.cycle_id === page.cycle_id && m.cursor === page.cursor && digest(m.binding) === digest(page.binding) && digest(snapshot.browser_environment) === digest(page.binding.environment) && (await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [page.expires_at])).rows[0].valid && await bindingCurrent(client, page.binding));
}
async function failMonitor(client: PoolClient, id: string, code: string) {
  await client.query("UPDATE kff.browser_inbox_monitors SET state='PAUSED',scan_requested=false,last_error_code=$2 WHERE id=$1", [id, code]);
}
export async function prepareBrowserInboxPage() {
  return transaction(async client => {
    const m = (await client.query<BrowserInboxMonitor>("SELECT m.* FROM kff.browser_inbox_monitors m JOIN kff.accounts a ON a.id=m.account_id JOIN kff.brands b ON b.id=m.brand_id JOIN kff.organizations o ON o.id=m.organization_id WHERE (m.state='ACTIVE' OR m.scan_requested) AND m.current_task_id IS NULL AND m.next_poll_at<=clock_timestamp() AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused ORDER BY m.next_poll_at,m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED")).rows[0];
    if (!m) return null;
    const scope = owner(m);
    await client.query("SELECT set_config('kff.organization_id',$1,true),set_config('kff.brand_id',$2,true),set_config('kff.user_id',$3,true)", [scope.organization_id, scope.brand_id, scope.user_id]); await client.query('SET LOCAL ROLE kff_app');
    await client.query('SAVEPOINT inbox_page');
    try {
      requireCondition(await bindingCurrent(client, m.binding, false), 'ENVIRONMENT_CHANGED', '收件账号或环境已变化', 409);
      requireCondition(m.cycle_pages < 20, 'INBOX_PAGE_LIMIT', '本轮收件达到分页上限', 409);
      const real = !m.binding.environment.is_synthetic;
      const capability = (await client.query('SELECT id FROM kff.capabilities WHERE account_id=$1 AND capability_key=$2', [m.account_id, real ? 'facebook.inbox.read.browser' : 'kff.fixture.inbox.read.browser'])).rows[0];
      requireCondition(capability, 'SOURCE_NOT_CONFIGURED', '收件能力尚未配置', 409);
      const page = browserInboxTask.parse({ monitor_id: m.id, monitor_version: m.version, token: String(BigInt(m.page_token) + 1n), cycle_id: m.cycle_id, cursor: m.cursor, limit: m.page_size, binding: m.binding, template: real ? 'facebook-inbox-dom-v1' : 'fixture-inbox-dom-v1', expires_at: new Date(Date.now() + m.raw_retention_hours * 3600000).toISOString() });
      const task = await createTaskInTransaction(client, scope, { title: '浏览器收件 · 页 ' + (m.cycle_pages + 1), account_id: m.account_id, environment_id: m.environment_id, capability_id: capability.id, body: '', mode: real ? 'CONTROLLED_PILOT' : 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: 'inbox_' + m.id + '_' + page.token }, undefined, page);
      await client.query("INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,'APPROVED',$5)", [scope.organization_id, scope.brand_id, task.id, task.snapshot_hash, scope.user_id]);
      await client.query("UPDATE kff.tasks SET status='APPROVED' WHERE id=$1", [task.id]);
      if (real) await createPermitInTransaction(client, scope, {
        task_id: task.id, max_actions: 1, starts_at: new Date().toISOString(), expires_at: page.expires_at,
        currency: 'USD', max_cost_minor: '0', per_action_max_minor: '0', cost_basis: '读取已登录浏览器的已指定会话，不调用付费采集服务；订阅费不重复计费。',
        authorization_evidence: '管理员配置的收件监控 ' + m.id + (m.binding.target?'，固定会话 '+m.binding.target.thread_id:'，从全部聊天列表核实最近最多 '+m.binding.discovery!.max_threads+' 个已接受会话') + '，合计最多读取 ' + page.limit + ' 条可见文字或图片存在标记；不读取图片内容。',
        platform_conditions: '核对浏览器操作身份和逐条发送者个人主页；不点击发送、通话或接受请求；日期或会话类型不明确时仅保留原始观察。',
        expected_evidence: 'inbox_page', stop_rule: 'stop_on_first_unknown_or_failure', confirmation: 'I_CONFIRM_THIS_EXACT_SCOPE',
      });
      await enqueueTaskInTransaction(client, scope, task.id);
      await client.query('UPDATE kff.browser_inbox_monitors SET current_task_id=$2,page_token=$3 WHERE id=$1', [m.id, task.id, page.token]);
      await audit(client, scope, 'browser_inbox.page_queued', m.id, { task_id: task.id, token: page.token, authorization: 'admin_readonly_monitor' }); return task;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT inbox_page'); if (!(error instanceof AppError)) throw error;
      await failMonitor(client, m.id, error.code); return null;
    }
  });
}

/** The original report/lease transaction owns both messages and cursor advancement. */
export async function acceptBrowserInboxReport(client: PoolClient, taskId: string, snapshot: TaskSnapshot, report: ActionReport) {
  const request = snapshot.inbox;
  if (!request) { requireCondition(!report.inbox_page, 'INVALID_INPUT', '普通动作不能携带收件页'); return; }
  const m = (await client.query<BrowserInboxMonitor>('SELECT * FROM kff.browser_inbox_monitors WHERE id=$1 FOR UPDATE', [request.monitor_id])).rows[0];
  requireCondition(m, 'INBOX_SOURCE_MISMATCH', '收件监控不存在', 409);
  const scope = owner(m), page = report.inbox_page;
  if (report.outcome === 'VERIFIED_SUCCEEDED') requireCondition(page && page.monitor_id === m.id && page.cursor === request.cursor && page.batch.messages.length <= request.limit && report.receipt?.content_hash === digest(page) && report.receipt.remote_id === 'inbox:' + m.id + ':' + request.token && report.receipt.observed_at === page.batch.observed_at, 'INBOX_SOURCE_MISMATCH', '收件页与原任务或证据摘要不符', 409);
  else requireCondition(!page, 'INVALID_INPUT', '失败动作不能导入收件页');
  if (!(await browserInboxTaskActive(client, taskId, snapshot))) {
    if (m.current_task_id === taskId && m.version === request.monitor_version) await failMonitor(client, m.id, 'STOP_REQUESTED');
    await audit(client, scope, 'browser_inbox.page_discarded', m.id, { task_id: taskId, reason: 'stopped_expired_or_changed' }); return;
  }
  if (!page || report.outcome !== 'VERIFIED_SUCCEEDED') { await failMonitor(client, m.id, report.error_code ?? 'INBOX_READ_FAILED'); return; }
  requireCondition(Boolean(page.discovery)===Boolean(request.binding.discovery),'INBOX_SOURCE_MISMATCH','会话发现摘要与原读取模式不符',409);
  if(request.binding.discovery){
    const summary=page.discovery!;
    requireCondition(summary.threads.length+summary.skipped.length<=request.binding.discovery.max_threads&&!page.has_more&&page.cursor===null&&(page.batch.messages.length>0||summary.empty_list)&&(!summary.skipped.length&&!summary.unparsed_rows&&summary.visible_threads===summary.threads.length||summary.window_limited),'INBOX_SOURCE_MISMATCH','发现结果超出原会话窗口或未明确部分覆盖',409);
    requireCondition(page.batch.messages.every(message=>summary.threads.some(t=>t.thread_id===message.thread_id&&t.peer_id===message.peer_id)&&message.source_url==='https://www.facebook.com/messages/e2ee/t/'+message.thread_id+'/'&&message.thread_kind==='UNVERIFIED'&&message.occurred_at===null&&(!message.has_attachment||message.body==='[图片附件，内容未读取]')),'INBOX_SOURCE_MISMATCH','发现结果包含未核实的会话、发送者或消息类型',409);
    // The window summary and the stored messages are one observation: each read conversation must
    // report exactly the messages being stored, so a skipped conversation can never look read.
    for(const thread of summary.threads){const count=page.batch.messages.filter(message=>message.thread_id===thread.thread_id&&message.peer_id===thread.peer_id).length;
      requireCondition(thread.message_count===undefined||thread.message_count===count,'INBOX_SOURCE_MISMATCH','会话读取条数必须与本次消息一致',409);
      requireCondition(thread.read!==false||count===0,'INBOX_SOURCE_MISMATCH','未读取的会话不能携带本窗口消息',409);}
    // Read, skipped and failed conversations are reported separately and must add up. `skipped`
    // holds every conversation the window did not read; the ones it tried and failed are also
    // counted as failures, so the two cover that list exactly once each. `attempted` is the reads
    // plus the attempted failures. Deriving `attempted` from a base that already contained the
    // failures is what made a window of two conversations report three and refuse a page whose
    // other conversation had been read successfully.
    const coverage=summary.coverage;
    requireCondition(!coverage||coverage.threads_attempted===coverage.threads_read+coverage.threads_failed&&coverage.threads_read===summary.threads.filter(t=>t.read!==false).length&&coverage.threads_failed+coverage.threads_skipped===summary.skipped.length&&coverage.threads_failed===summary.skipped.filter(s=>s.reason!=='MESSAGE_LIMIT').length,'INBOX_SOURCE_MISMATCH','会话覆盖计数必须与实际读取和跳过数量一致',409);
  }
  if (request.binding.target) {
    const target=request.binding.target;
    // A visible conversation may contain both directions. The batch schema validates direction;
    // ingress reconciles our own receipt echoes and treats other outgoing messages as human replies.
    requireCondition(!page.has_more && page.cursor===null && page.batch.messages.every(message=>message.thread_id===target.thread_id && message.peer_id===target.peer_id && message.thread_kind==='UNVERIFIED' && message.occurred_at===null), 'INBOX_SOURCE_MISMATCH', '收件结果超出了当前指定会话的只读范围', 409);
  }
  const seen = page.has_more && (page.next_cursor === page.cursor || (await client.query('SELECT 1 FROM kff.browser_inbox_checkpoints WHERE monitor_id=$1 AND cycle_id=$2 AND cursor=$3', [m.id, m.cycle_id, page.next_cursor])).rowCount);
  if (seen || page.has_more && m.cycle_pages >= 19) {
    await failMonitor(client, m.id, seen ? 'INBOX_CURSOR_LOOP' : 'INBOX_PAGE_LIMIT');
    await audit(client, scope, 'browser_inbox.page_discarded', m.id, { task_id: taskId, reason: seen ? 'cursor_loop' : 'page_limit' }); return;
  }
  const result = await receiveBrowserInboxBatchInTransaction(client, scope, request.binding, page.batch);
  await client.query('INSERT INTO kff.browser_inbox_checkpoints(task_id,monitor_id,organization_id,brand_id,cycle_id,page_token,cursor,next_cursor,page_sha256,stored,duplicates,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [taskId, m.id, m.organization_id, m.brand_id, m.cycle_id, request.token, page.cursor, page.next_cursor, digest(page), result.stored, result.duplicates, page.batch.observed_at]);
  await client.query('UPDATE kff.browser_inbox_monitors SET cursor=$2,cycle_pages=CASE WHEN $3 THEN cycle_pages+1 ELSE 0 END,cycle_id=CASE WHEN $3 THEN cycle_id ELSE gen_random_uuid() END,scan_requested=scan_requested AND $3,next_poll_at=clock_timestamp()+make_interval(secs=>CASE WHEN $3 THEN 0 ELSE interval_seconds END),last_polled_at=clock_timestamp(),last_error_code=NULL WHERE id=$1', [m.id, page.next_cursor, page.has_more]);
  await audit(client, scope, 'browser_inbox.page_committed', m.id, { task_id: taskId, stored: result.stored, duplicates: result.duplicates, has_more: page.has_more, ...(page.discovery?{discovery:page.discovery}:{}) });
}

export async function syncBrowserInboxTasks() {
  // Never hold a monitor lock while entering the existing run-stop lock order.
  const stopped = await query<{ id: string; organization_id: string; brand_id: string; created_by: string }>("SELECT r.id,t.organization_id,t.brand_id,t.created_by FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id JOIN kff.browser_inbox_monitors m ON m.current_task_id=t.id WHERE r.status IN ('QUEUED','RUNNING') AND (NOT r.stop_requested OR r.status='QUEUED') AND ((m.state='PAUSED' AND NOT m.scan_requested) OR m.version::text<>t.snapshot->'inbox'->>'monitor_version' OR (t.snapshot->'inbox'->>'expires_at')::timestamptz<=clock_timestamp()) LIMIT 100");
  for (const row of stopped) await stopRun({ ...row, user_id: row.created_by, role: 'admin' }, row.id, 'INBOX_STOPPED');
  await transaction(async client => {
    await client.query("UPDATE kff.browser_inbox_monitors m SET state='PAUSED',scan_requested=false,last_error_code=COALESCE(m.last_error_code,a.error_code,'INBOX_TASK_ENDED') FROM kff.tasks t JOIN kff.actions a ON a.task_id=t.id WHERE m.current_task_id=t.id AND t.status IN ('FAILED','CANCELED','NEEDS_HUMAN')");
    // Even a successful receipt cannot queue the next page until the guardian closure is acknowledged.
    await client.query("UPDATE kff.browser_inbox_monitors m SET current_task_id=NULL FROM kff.tasks t WHERE m.current_task_id=t.id AND t.status IN ('SUCCEEDED','FAILED','CANCELED','NEEDS_HUMAN') AND NOT EXISTS(SELECT 1 FROM kff.actions a JOIN kff.agent_commands c ON c.action_id=a.id WHERE a.task_id=t.id AND c.quiesced_at IS NULL)");
  });
}
