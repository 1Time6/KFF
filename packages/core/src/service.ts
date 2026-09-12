import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { accountInput, environmentInput, taskInput, approvalInput, taskSnapshotSchema, type Account, type Capability, type Environment, type Scope, type Task, type Run, type AdjudicationRecord, type TemplateVersion } from '@kff/contracts';
import { scoped } from '@kff/database';
import { requireCondition, digest, canExecute, isWrite } from './index';
import { findPermit, permitMatches, type Permit } from './permits';
import { ensureBundledTemplates, chooseTemplateVersion, assertCurrentTemplate } from './templates';
import { validateTemplateInput } from '../../adapters/src/templates';

export function requireWrite(scope: Scope) { requireCondition(scope.role !== 'viewer', 'FORBIDDEN_SCOPE', '当前角色仅可查看', 403); }
export function requireAdmin(scope: Scope) { requireCondition(scope.role === 'admin', 'FORBIDDEN_SCOPE', '此操作需要品牌管理员权限', 403); }
export async function audit(client: PoolClient, scope: Scope, event: string, objectId: string, details: Record<string, unknown> = {}) {
  await client.query('INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6)', [scope.organization_id, scope.brand_id, scope.user_id, event, objectId, details]);
}
export async function workspace(scope: Scope) {
  return scoped(scope, async client => {
    const accounts = (await client.query<Account>('SELECT * FROM kff.accounts ORDER BY created_at')).rows;
    const environments = (await client.query<Environment>('SELECT * FROM kff.environments ORDER BY created_at')).rows;
    const capabilities = (await client.query<Capability>('SELECT * FROM kff.capabilities ORDER BY created_at,capability_key')).rows;
    const templates = (await client.query<TemplateVersion>('SELECT * FROM kff.template_versions ORDER BY version_number DESC')).rows;
    const tasks = (await client.query<Task>('SELECT * FROM kff.tasks ORDER BY created_at DESC,id LIMIT 100')).rows;
    const runs = (await client.query<Run>('SELECT r.*,t.title,a.id AS action_id,a.state AS action_state,a.error_code,a.receipt FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id JOIN kff.actions a ON a.run_id=r.id ORDER BY r.created_at DESC,r.id LIMIT 100')).rows;
    const agents = (await client.query('SELECT id,name,status,protocol_version,heartbeat_at, (heartbeat_at>now()-interval \'20 seconds\') AS is_online FROM kff.agents ORDER BY created_at')).rows;
    const brand = (await client.query('SELECT id,name,outbound_paused FROM kff.brands')).rows[0];
    const organization = (await client.query("SELECT o.id,o.name,o.outbound_paused,EXISTS(SELECT 1 FROM kff.organization_memberships m WHERE m.organization_id=o.id AND m.role IN ('owner','admin')) AS can_manage FROM kff.organizations o")).rows[0];
    const permits = (await client.query<Permit>("SELECT *,starts_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL AND halted_at IS NULL AS valid FROM kff.pilot_permits ORDER BY created_at DESC LIMIT 100")).rows;
    const budgets = (await client.query<{ currency: string; available_minor: string }>("SELECT b.currency,(b.limit_minor-COALESCE(sum(c.reserved_minor) FILTER(WHERE c.state IN ('RESERVED','PENDING_RECONCILIATION')),0)-COALESCE(sum(c.actual_cost_minor),0))::text AS available_minor FROM kff.cost_budgets b LEFT JOIN kff.cost_reservations c ON c.brand_id=b.brand_id AND c.currency=b.currency GROUP BY b.id")).rows;
    const eligibility = Object.fromEntries(tasks.map(task => {
      const capability = capabilities.find(value => value.id === task.capability_id)!;
      const permit = permits.find(value => value.task_id === task.id && permitMatches(value, task.snapshot) && value.reserved_actions < value.max_actions && BigInt(value.reserved_cost_minor) + BigInt(value.per_action_max_minor) <= BigInt(value.max_cost_minor));
      const paused = organization.outbound_paused || brand.outbound_paused || accounts.find(account => account.id === task.account_id)?.outbound_paused;
      let decision = paused ? { allowed: false, reason_code: 'STOP_REQUESTED' } : canExecute(capability, task.snapshot.mode, process.env.KFF_ENABLE_LIVE === 'true', Boolean(permit));
      if (decision.allowed && permit) { const budget = budgets.find(value => value.currency === permit.currency); if (!budget || BigInt(budget.available_minor) < BigInt(permit.per_action_max_minor)) decision = { allowed: false, reason_code: budget ? 'BUDGET_EXCEEDED' : 'BUDGET_UNCONFIGURED' }; }
      if (decision.allowed) { const template = templates.find(value => value.id === task.snapshot.template?.version_id); if (!template || template.state !== 'ALLOWED' || template.manifest_hash !== task.snapshot.template?.manifest_hash) decision = { allowed: false, reason_code: 'TEMPLATE_UNAVAILABLE' }; }
      return [task.id, decision];
    }));
    const totals = (await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='VERIFIED_SUCCEEDED')::int AS verified,count(*) FILTER(WHERE state IN ('UNKNOWN_OUTCOME','NEEDS_HUMAN'))::int AS unknown,count(*) FILTER(WHERE state IN ('QUEUED','PREPARING','SUBMITTING','SUBMITTED'))::int AS active,count(*) FILTER(WHERE state IN ('VERIFIED_FAILED','BLOCKED'))::int AS failed,count(*) FILTER(WHERE state='CANCELED')::int AS canceled FROM kff.actions")).rows[0];
    return { scope, organization, brand, accounts, environments, capabilities, templates, tasks, runs, agents, permits, eligibility, totals, live_enabled: process.env.KFF_ENABLE_LIVE === 'true', fetched_at: new Date().toISOString() };
  });
}
export type Workspace = Awaited<ReturnType<typeof workspace>>;

export async function createAccount(scope: Scope, input: z.infer<typeof accountInput>) {
  requireAdmin(scope); const value = accountInput.parse(input);
  return scoped(scope, async client => {
    const id = randomUUID();
    const account = (await client.query<Account>('INSERT INTO kff.accounts(id,organization_id,brand_id,display_name,external_id,platform,account_type,credential_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [id, scope.organization_id, scope.brand_id, value.display_name, value.external_id, value.platform, value.account_type, value.credential_ref ?? null])).rows[0];
    for (const action of ['read', 'publish']) await client.query("INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,'facebook-graph-v1','UNASSESSED','DISABLED',false,$5)", [scope.organization_id, scope.brand_id, id, 'facebook.page.' + action + '.api', action === 'read' ? '读取自有 Facebook 主页；待账号和权限验证' : '发布主页文本并回读远端对象；待真实验证']);
    await ensureBundledTemplates(client, scope);
    await audit(client, scope, 'account.created', id); return account;
  });
}
export async function createEnvironment(scope: Scope, input: z.infer<typeof environmentInput>) {
  requireAdmin(scope); const value = environmentInput.parse(input);
  return scoped(scope, async client => {
    const account = await client.query('SELECT id FROM kff.accounts WHERE id=$1', [value.account_id]);
    const agent = await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status<>'REVOKED'", [value.agent_id]);
    requireCondition(account.rowCount && agent.rowCount, 'FORBIDDEN_SCOPE', '账号或 Agent 不在当前品牌内', 403);
    const row = (await client.query<Environment>('INSERT INTO kff.environments(organization_id,brand_id,name,account_id,agent_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [scope.organization_id, scope.brand_id, value.name, value.account_id, value.agent_id])).rows[0];
    await audit(client, scope, 'environment.created', row.id); return row;
  });
}
export async function createTask(scope: Scope, input: z.infer<typeof taskInput>): Promise<Task> {
  requireWrite(scope); const value = taskInput.parse(input); const requestHash = digest(value);
  return scoped(scope, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope.organization_id + ':' + scope.brand_id + ':' + value.idempotency_key]);
    const existing = (await client.query<Task & { request_hash: string }>('SELECT * FROM kff.tasks WHERE idempotency_key=$1', [value.idempotency_key])).rows[0];
    if (existing) { requireCondition(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容', 409); return existing; }
    const account = (await client.query<Account>('SELECT * FROM kff.accounts WHERE id=$1', [value.account_id])).rows[0];
    const environment = (await client.query<Environment>('SELECT * FROM kff.environments WHERE id=$1 AND account_id=$2', [value.environment_id, value.account_id])).rows[0];
    const capability = (await client.query<Capability>('SELECT * FROM kff.capabilities WHERE id=$1 AND account_id=$2', [value.capability_id, value.account_id])).rows[0];
    requireCondition(account && environment && capability, 'FORBIDDEN_SCOPE', '账号、环境和能力必须属于当前品牌且相互匹配', 403);
    requireCondition(account.is_synthetic === capability.is_synthetic, 'FORBIDDEN_SCOPE', '测试环境与账号类型不匹配', 403);
    requireCondition(capability.is_synthetic ? value.mode === 'TEST_ONLY' : value.mode !== 'TEST_ONLY', 'INVALID_INPUT', '执行模式与能力不匹配');
    requireCondition(account.is_synthetic || value.fixture_scenario === 'normal', 'INVALID_INPUT', '故障场景仅用于合成环境');
    const template = await chooseTemplateVersion(client, capability.capability_key, capability.adapter_version, value.template_version_id);
    validateTemplateInput(template.manifest, value.body);
    const contentId = randomUUID(); const contentHash = digest(value.body);
    const snapshot = taskSnapshotSchema.parse({ account_id: account.id, external_account_id: account.external_id, account_version: account.version, credential_ref: account.credential_ref, environment_id: environment.id, profile_key: environment.profile_key, agent_id: environment.agent_id, capability_id: capability.id, capability_key: capability.capability_key, capability_revision: capability.revision, adapter_version: capability.adapter_version, implementation_digest: capability.implementation_digest ?? null, platform_api_version: account.is_synthetic ? null : process.env.KFF_FACEBOOK_GRAPH_VERSION ?? null, body: value.body, content_hash: contentHash, mode: value.mode, fixture_scenario: value.fixture_scenario, is_synthetic: account.is_synthetic, template });
    requireCondition(!isWrite(snapshot) || value.body.length > 0, 'INVALID_INPUT', '发布内容不能为空');
    await client.query('INSERT INTO kff.content_versions(id,organization_id,brand_id,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6)', [contentId, scope.organization_id, scope.brand_id, value.body, contentHash, scope.user_id]);
    const task = (await client.query<Task>('INSERT INTO kff.tasks(organization_id,brand_id,title,account_id,environment_id,capability_id,content_version_id,snapshot,snapshot_hash,idempotency_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [scope.organization_id, scope.brand_id, value.title, account.id, environment.id, capability.id, contentId, snapshot, digest(snapshot), value.idempotency_key, requestHash, scope.user_id])).rows[0];
    await audit(client, scope, 'task.created', task.id, { snapshot_hash: task.snapshot_hash }); return task;
  });
}
export async function approveTask(scope: Scope, taskId: string, input: z.infer<typeof approvalInput>) {
  requireWrite(scope); const value = approvalInput.parse(input);
  return scoped(scope, async client => {
    const task = (await client.query<Task>('SELECT * FROM kff.tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
    requireCondition(task, 'NOT_FOUND', '任务不存在', 404);
    requireCondition(task.snapshot_hash === value.snapshot_hash, 'APPROVAL_STALE', '内容版本已变化，请重新核对', 409);
    if (task.status === value.decision) return task;
    requireCondition(task.status === 'DRAFT', 'VERSION_CONFLICT', '此任务已进入后续阶段', 409);
    await client.query('INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,$5,$6)', [scope.organization_id, scope.brand_id, taskId, value.snapshot_hash, value.decision, scope.user_id]);
    const updated = (await client.query<Task>('UPDATE kff.tasks SET status=$1 WHERE id=$2 RETURNING *', [value.decision, taskId])).rows[0];
    await audit(client, scope, 'task.' + value.decision.toLowerCase(), taskId, { snapshot_hash: value.snapshot_hash }); return updated;
  });
}
export async function enqueueTask(scope: Scope, taskId: string): Promise<Run> {
  requireWrite(scope);
  return scoped(scope, client => enqueueTaskInTransaction(client,scope,taskId));
}
export async function enqueueTaskInTransaction(client:PoolClient,scope:Scope,taskId:string):Promise<Run> {
    const task = (await client.query<Task>('SELECT * FROM kff.tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
    requireCondition(task, 'NOT_FOUND', '任务不存在', 404);
    const existing = (await client.query<Run>('SELECT * FROM kff.runs WHERE task_id=$1', [taskId])).rows[0];
    if (existing) return existing;
    requireCondition(task.status === 'APPROVED', 'APPROVAL_STALE', '请先审核任务的账号、动作和内容', 409);
    const approval = await client.query("SELECT id FROM kff.approval_decisions WHERE task_id=$1 AND snapshot_hash=$2 AND decision='APPROVED'", [taskId, task.snapshot_hash]);
    requireCondition(approval.rowCount, 'APPROVAL_STALE', '缺少当前版本的批准记录', 409);
    const capability = (await client.query<Capability>('SELECT * FROM kff.capabilities WHERE id=$1', [task.capability_id])).rows[0];
    requireCondition(capability.revision === task.snapshot.capability_revision && capability.adapter_version === task.snapshot.adapter_version, 'VERSION_CONFLICT', '能力版本已变化', 409);
    await assertCurrentTemplate(client, task.id, task.snapshot);
    if (task.snapshot.mode === 'CONTROLLED_PILOT') await findPermit(client, task.id, task.snapshot);
    const decision = canExecute(capability, task.snapshot.mode, process.env.KFF_ENABLE_LIVE === 'true', task.snapshot.mode === 'CONTROLLED_PILOT');
    requireCondition(decision.allowed, decision.reason_code, '当前能力尚未满足执行条件；真实测试将在配置账号和许可后进行', 409);
    const pause = (await client.query('SELECT ac.outbound_paused OR b.outbound_paused OR o.outbound_paused AS paused FROM kff.accounts ac JOIN kff.brands b ON b.id=ac.brand_id JOIN kff.organizations o ON o.id=ac.organization_id WHERE ac.id=$1', [task.account_id])).rows[0];
    requireCondition(!pause.paused, 'STOP_REQUESTED', '当前组织、品牌或账号已暂停新动作', 409);
    const run = (await client.query<Run>('INSERT INTO kff.runs(organization_id,brand_id,task_id) VALUES($1,$2,$3) RETURNING *', [scope.organization_id, scope.brand_id, taskId])).rows[0];
    const action = (await client.query('INSERT INTO kff.actions(organization_id,brand_id,run_id,task_id) VALUES($1,$2,$3,$4) RETURNING id', [scope.organization_id, scope.brand_id, run.id, taskId])).rows[0];
    await client.query('INSERT INTO kff.jobs(organization_id,brand_id,action_id) VALUES($1,$2,$3)', [scope.organization_id, scope.brand_id, action.id]);
    await client.query("UPDATE kff.tasks SET status='QUEUED' WHERE id=$1", [taskId]);
    await audit(client, scope, 'run.queued', run.id, { action_id: action.id }); return run;
}
export async function stopRun(scope: Scope, runId: string, reason: string) {
  requireWrite(scope);
  return scoped(scope, async client => {
    const run = (await client.query<Run>('SELECT * FROM kff.runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    requireCondition(run, 'NOT_FOUND', '运行不存在', 404);
    await client.query('UPDATE kff.runs SET stop_requested=true,stop_reason=$1,updated_at=now() WHERE id=$2', [reason, runId]);
    const action = (await client.query('SELECT id,state FROM kff.actions WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
    if (action.state === 'QUEUED') {
      await client.query("UPDATE kff.actions SET state='CANCELED',error_code='STOP_REQUESTED' WHERE id=$1", [action.id]);
      await client.query("UPDATE kff.jobs SET state='DONE' WHERE action_id=$1", [action.id]);
      await client.query("UPDATE kff.runs SET status='CANCELED' WHERE id=$1", [runId]);
      await client.query("UPDATE kff.tasks SET status='CANCELED' WHERE id=$1", [run.task_id]);
    }
    await audit(client, scope, 'run.stop_requested', runId, { in_flight: ['SUBMITTING', 'SUBMITTED'].includes(action.state) });
    return { stop_requested: true, in_flight: ['SUBMITTING', 'SUBMITTED'].includes(action.state) ? 1 : 0 };
  });
}
export async function runDetail(scope: Scope, runId: string) {
  return scoped(scope, async client => {
    const run = (await client.query<Run>('SELECT r.*,t.title,a.id AS action_id,a.state AS action_state,a.adjudication_version,a.error_code,a.receipt FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id JOIN kff.actions a ON a.run_id=r.id WHERE r.id=$1', [runId])).rows[0];
    requireCondition(run, 'NOT_FOUND', '运行不存在', 404);
    const task = (await client.query<Task>('SELECT * FROM kff.tasks WHERE id=$1', [run.task_id])).rows[0];
    const attempts = (await client.query('SELECT id,attempt_number,state,submitted_at,completed_at,created_at FROM kff.action_attempts WHERE action_id=$1 ORDER BY attempt_number', [run.action_id])).rows;
    const diagnostics = (await client.query("SELECT id,jsonb_build_object('level',manifest->>'level') AS manifest,expires_at,created_at FROM kff.diagnostic_bundles WHERE action_id=$1 AND expires_at>now() ORDER BY created_at", [run.action_id])).rows;
    const events = (await client.query('SELECT event_type,details,created_at FROM kff.audit_events WHERE object_id=ANY($1::uuid[]) ORDER BY created_at', [[runId, run.task_id, run.action_id]])).rows;
    const adjudications = (await client.query<AdjudicationRecord>('SELECT id,action_id,reviewer_id,snapshot_hash,expected_version,result_version,previous_state,decision,result_state,evidence,reason,created_at FROM kff.action_adjudications WHERE action_id=$1 ORDER BY result_version', [run.action_id])).rows;
    return { run, task, attempts, diagnostics, events, adjudications };
  });
}
export async function setBrandPause(scope: Scope, paused: boolean) {
  requireAdmin(scope);
  return scoped(scope, async client => {
    await client.query('UPDATE kff.brands SET outbound_paused=$1', [paused]);
    const counts = (await client.query("SELECT count(*) FILTER(WHERE state IN ('SUBMITTING','SUBMITTED'))::int AS in_flight FROM kff.actions")).rows[0];
    await audit(client, scope, paused ? 'brand.paused' : 'brand.resumed', scope.brand_id, counts); return { outbound_paused: paused, ...counts };
  });
}
