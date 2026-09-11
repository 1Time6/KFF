import type { PoolClient } from 'pg';
import { z } from 'zod';
import { permitInput, type Scope, type Task, type TaskSnapshot } from '@kff/contracts';
import { scoped } from '@kff/database';
import { digest, isWrite, requireCondition } from './index';
import { audit, requireAdmin } from './service';
import { checkCostCapacity, reserveCostForAction } from './costs';

export interface Permit { id: string; organization_id: string; brand_id: string; task_id: string; snapshot_hash: string; account_id: string; target_id: string; capability_id: string; capability_revision: number; adapter_version: string; content_hash: string; max_actions: number; reserved_actions: number; max_cost_minor: string; reserved_cost_minor: string; per_action_max_minor: string; currency: string; cost_basis: string; valid: boolean }
export function permitMatches(permit: Permit, snapshot: TaskSnapshot) {
  return permit.valid && permit.snapshot_hash === digest(snapshot) && permit.account_id === snapshot.account_id && permit.target_id === snapshot.external_account_id && permit.capability_id === snapshot.capability_id && permit.capability_revision === snapshot.capability_revision && permit.adapter_version === snapshot.adapter_version && permit.content_hash === snapshot.content_hash;
}
export async function findPermit(client: PoolClient, taskId: string, snapshot: TaskSnapshot, reserveForAction?: string): Promise<Permit> {
  if (reserveForAction) {
    const action = (await client.query('SELECT id,run_id FROM kff.actions WHERE id=$1 AND task_id=$2', [reserveForAction, taskId])).rows[0];
    requireCondition(action, 'FORBIDDEN_SCOPE', '预占动作与许可任务不匹配', 403);
    await client.query('SELECT id FROM kff.runs WHERE id=$1 FOR UPDATE', [action.run_id]);
    await client.query('SELECT id FROM kff.actions WHERE id=$1 FOR UPDATE', [action.id]);
  }
  const rows = (await client.query<Permit>("SELECT *,starts_at<=clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL AND halted_at IS NULL AS valid FROM kff.pilot_permits WHERE task_id=$1 ORDER BY created_at DESC FOR UPDATE", [taskId])).rows;
  const permit = rows.find(value => permitMatches(value, snapshot));
  requireCondition(permit, 'PILOT_PERMIT_REQUIRED', '当前任务缺少有效且范围匹配的试验许可', 409);
  const existing = reserveForAction ? (await client.query('SELECT permit_id FROM kff.pilot_reservations WHERE action_id=$1', [reserveForAction])).rows[0] : undefined;
  if (existing) { requireCondition(existing.permit_id === permit.id, 'PILOT_PERMIT_REQUIRED', '动作已有其他许可预占', 409); await reserveCostForAction(client, reserveForAction!, { permit_id: permit.id, currency: permit.currency, reserved_minor: permit.per_action_max_minor, cost_basis: permit.cost_basis }); return permit; }
  requireCondition(permit.reserved_actions < permit.max_actions && BigInt(permit.reserved_cost_minor) + BigInt(permit.per_action_max_minor) <= BigInt(permit.max_cost_minor), 'BUDGET_EXCEEDED', '试验次数或费用上限已用尽', 409);
  if (reserveForAction) {
    await reserveCostForAction(client, reserveForAction, { permit_id: permit.id, currency: permit.currency, reserved_minor: permit.per_action_max_minor, cost_basis: permit.cost_basis });
    await client.query('UPDATE kff.pilot_permits SET reserved_actions=reserved_actions+1,reserved_cost_minor=reserved_cost_minor+per_action_max_minor WHERE id=$1', [permit.id]);
    await client.query('INSERT INTO kff.pilot_reservations(action_id,organization_id,brand_id,permit_id,cost_minor,currency) SELECT $1,organization_id,brand_id,id,per_action_max_minor,currency FROM kff.pilot_permits WHERE id=$2', [reserveForAction, permit.id]);
  } else await checkCostCapacity(client, permit, permit.currency, permit.per_action_max_minor);
  return permit;
}
export async function createPermit(scope: Scope, input: z.infer<typeof permitInput>) {
  requireAdmin(scope); const value = permitInput.parse(input);
  return scoped(scope, async client => {
    const task = (await client.query<Task>('SELECT * FROM kff.tasks WHERE id=$1 FOR UPDATE', [value.task_id])).rows[0];
    requireCondition(task && task.status === 'APPROVED' && task.snapshot.mode === 'CONTROLLED_PILOT' && !task.snapshot.is_synthetic, 'PILOT_PERMIT_REQUIRED', '请先审核明确范围的真实试验任务', 409);
    const capability = (await client.query('SELECT * FROM kff.capabilities WHERE id=$1', [task.capability_id])).rows[0];
    requireCondition(['IMPLEMENTED_TEST_ONLY', 'VERIFIED_REAL'].includes(capability.evidence_state) && capability.mode === 'CONTROLLED_PILOT' && capability.revision === task.snapshot.capability_revision, 'CAPABILITY_UNASSESSED', '此版本尚未登记本地实现及前置条件证据', 409);
    requireCondition(capability.implementation_digest && capability.implementation_digest === task.snapshot.implementation_digest, 'VERSION_CONFLICT', '实现证据已变化，请重新创建并审核任务', 409);
    requireCondition(task.snapshot.credential_ref, 'AUTH_EXPIRED', '账号尚未绑定凭据引用', 409);
    requireCondition(task.snapshot.platform_api_version, 'CAPABILITY_UNASSESSED', '需先配置明确的 Graph API 版本并重新创建审核任务', 409);
    requireCondition(Date.parse(value.expires_at) > Date.now(), 'PILOT_PERMIT_REQUIRED', '试验窗口已过期', 409);
    requireCondition(value.expected_evidence === (isWrite(task.snapshot) ? 'published_post_identity_author_content' : 'page_identity'), 'INVALID_INPUT', '预期证据与动作不匹配');
    if (isWrite(task.snapshot)) {
      const identity = await client.query("SELECT a.id FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.account_id=$1 AND a.state='VERIFIED_SUCCEEDED' AND t.snapshot->>'capability_key'='facebook.page.read.api' AND a.receipt->>'evidence_kind'='graph_object' AND a.receipt->>'actual_account_id'=$2 AND t.snapshot->>'credential_ref'=$3 AND t.snapshot->>'account_version'=$4", [task.account_id, task.snapshot.external_account_id, task.snapshot.credential_ref, String(task.snapshot.account_version)]);
      requireCondition(identity.rowCount, 'ACCOUNT_UNVERIFIED', '必须先核实此凭据版本的真实主页身份', 409);
    }
    requireCondition(BigInt(value.per_action_max_minor) <= BigInt(value.max_cost_minor), 'BUDGET_EXCEEDED', '单次费用上限超过总上限');
    await checkCostCapacity(client, scope, value.currency, value.per_action_max_minor);
    const permit = (await client.query('INSERT INTO kff.pilot_permits(organization_id,brand_id,task_id,account_id,capability_id,snapshot_hash,content_hash,target_id,capability_revision,adapter_version,access_path,approved_by,starts_at,expires_at,max_actions,currency,max_cost_minor,per_action_max_minor,cost_basis,authorization_evidence,platform_conditions,expected_evidence,stop_rule) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'api\',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *', [scope.organization_id, scope.brand_id, task.id, task.account_id, task.capability_id, task.snapshot_hash, task.snapshot.content_hash, task.snapshot.external_account_id, task.snapshot.capability_revision, task.snapshot.adapter_version, scope.user_id, value.starts_at, value.expires_at, value.max_actions, value.currency, value.max_cost_minor, value.per_action_max_minor, value.cost_basis, value.authorization_evidence, value.platform_conditions, value.expected_evidence, value.stop_rule])).rows[0];
    await audit(client, scope, 'pilot.approved', permit.id, { task_id: task.id, snapshot_hash: task.snapshot_hash, max_actions: value.max_actions }); return permit;
  });
}
export async function revokePermit(scope: Scope, id: string) {
  requireAdmin(scope); return scoped(scope, async client => {
    const result = await client.query('UPDATE kff.pilot_permits SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id', [id]);
    requireCondition(result.rowCount, 'NOT_FOUND', '试验许可不存在', 404);
    await audit(client, scope, 'pilot.revoked', id); return { revoked: true };
  });
}
export async function haltPilot(client: PoolClient, actionId: string) {
  await client.query('UPDATE kff.pilot_permits SET halted_at=COALESCE(halted_at,now()) WHERE id IN (SELECT permit_id FROM kff.pilot_reservations WHERE action_id=$1)', [actionId]);
}
