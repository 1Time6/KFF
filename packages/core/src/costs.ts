import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { scoped } from '@kff/database';
import { budgetInput, costReconciliationInput, minorAmount, type Scope, type CostBalance, type CostRecord, type CostEvent, type CostWorkspace } from '@kff/contracts';
import { digest, requireCondition } from './index';
import { audit, requireAdmin } from './service';

type BrandScope = Pick<Scope, 'organization_id' | 'brand_id'>;
interface CostBudget { id: string; currency: string; minor_unit_exponent: number; precision_source: string; limit_minor: string; version: number }
interface CostReservation extends BrandScope { action_id: string; permit_id: string | null; currency: string; reserved_minor: string; actual_cost_minor: string | null; cost_basis: string; state: 'RESERVED' | 'PENDING_RECONCILIATION' | 'SETTLED' | 'RELEASED'; version: number }
async function totals(client: PoolClient, scope: BrandScope, currency: string) {
  return (await client.query<{ held_minor: string; confirmed_minor: string; pending_count: number }>("SELECT COALESCE(sum(reserved_minor) FILTER(WHERE state IN ('RESERVED','PENDING_RECONCILIATION')),0)::text AS held_minor,COALESCE(sum(actual_cost_minor),0)::text AS confirmed_minor,count(*) FILTER(WHERE actual_cost_minor IS NULL)::int AS pending_count FROM kff.cost_reservations WHERE organization_id=$1 AND brand_id=$2 AND currency=$3", [scope.organization_id, scope.brand_id, currency])).rows[0];
}
async function lockBudget(client: PoolClient, scope: BrandScope, currency: string) {
  return (await client.query<CostBudget>('SELECT * FROM kff.cost_budgets WHERE organization_id=$1 AND brand_id=$2 AND currency=$3 FOR UPDATE', [scope.organization_id, scope.brand_id, currency])).rows[0];
}
async function lockAction(client: PoolClient, actionId: string) {
  const row = (await client.query<{ id: string; run_id: string; task_id: string; organization_id: string; brand_id: string; state: string }>('SELECT id,run_id,task_id,organization_id,brand_id,state FROM kff.actions WHERE id=$1', [actionId])).rows[0];
  requireCondition(row, 'NOT_FOUND', '费用所属动作不存在', 404);
  await client.query('SELECT id FROM kff.runs WHERE id=$1 FOR UPDATE', [row.run_id]);
  return (await client.query<typeof row>('SELECT id,run_id,task_id,organization_id,brand_id,state FROM kff.actions WHERE id=$1 FOR UPDATE', [actionId])).rows[0];
}
async function priorEvent(client: PoolClient, id: string, requestHash: string) {
  const row = (await client.query('SELECT request_hash,details FROM kff.cost_entries WHERE id=$1', [id])).rows[0];
  if (row) requireCondition(row.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', '同一费用事件已记录不同内容', 409); return row;
}
export async function configureBudget(scope: Scope, input: z.infer<typeof budgetInput>) {
  requireAdmin(scope); const value = budgetInput.parse(input); const hash = digest(value);
  return scoped(scope, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cost-budget/' + scope.brand_id + '/' + value.currency]);
    const previous = await priorEvent(client, value.request_id, hash); if (previous) return previous.details.result as CostBudget;
    const existing = await lockBudget(client, scope, value.currency);
    requireCondition((existing?.version ?? 0) === value.expected_version, 'VERSION_CONFLICT', '预算版本已变化，请刷新', 409);
    requireCondition(!existing || existing.minor_unit_exponent === value.minor_unit_exponent, 'CURRENCY_PRECISION_CONFLICT', '已有账目按原精度登记，请保持一致', 409);
    const balance = await totals(client, scope, value.currency);
    requireCondition(BigInt(value.limit_minor) >= BigInt(balance.held_minor) + BigInt(balance.confirmed_minor), 'BUDGET_BELOW_COMMITMENTS', '预算不能低于已有预占和确认费用', 409);
    const row = existing ? (await client.query<CostBudget>('UPDATE kff.cost_budgets SET limit_minor=$1,precision_source=$2,version=version+1 WHERE id=$3 RETURNING *', [value.limit_minor, value.precision_source, existing.id])).rows[0] : (await client.query<CostBudget>('INSERT INTO kff.cost_budgets(organization_id,brand_id,currency,minor_unit_exponent,precision_source,limit_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [scope.organization_id, scope.brand_id, value.currency, value.minor_unit_exponent, value.precision_source, value.limit_minor])).rows[0];
    await client.query("INSERT INTO kff.cost_entries(id,organization_id,brand_id,currency,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,'LIMIT_SET',$5,$6,$7)", [value.request_id, scope.organization_id, scope.brand_id, value.currency, scope.user_id, hash, { reason: value.reason, result: row }]);
    await audit(client, scope, 'budget.configured', row.id, { currency: row.currency, limit_minor: row.limit_minor, version: row.version }); return row;
  });
}
export async function checkCostCapacity(client: PoolClient, scope: BrandScope, currency: string, amount: string) {
  minorAmount.parse(amount); const budget = await lockBudget(client, scope, currency);
  requireCondition(budget, 'BUDGET_UNCONFIGURED', '请先登记此币种的预算与记账精度', 409);
  const balance = await totals(client, scope, currency);
  requireCondition(BigInt(balance.held_minor) + BigInt(balance.confirmed_minor) + BigInt(amount) <= BigInt(budget.limit_minor), 'BUDGET_EXCEEDED', '费用预算不足；未知费用仍保留预占', 409); return budget;
}
export async function reserveCostForAction(client: PoolClient, actionId: string, input: { permit_id: string | null; currency: string; reserved_minor: string; cost_basis: string }) {
  minorAmount.parse(input.reserved_minor); z.string().regex(/^[A-Z]{3}$/).parse(input.currency);
  const action = await lockAction(client, actionId);
  if (input.permit_id) {
    const permit = (await client.query('SELECT id FROM kff.pilot_permits WHERE id=$1 AND organization_id=$2 AND brand_id=$3 AND task_id=$4 AND currency=$5 AND per_action_max_minor=$6 FOR UPDATE', [input.permit_id, action.organization_id, action.brand_id, action.task_id, input.currency, input.reserved_minor])).rows[0];
    requireCondition(permit, 'FORBIDDEN_SCOPE', '费用许可不属于此动作范围', 403);
  }
  const existing = (await client.query<CostReservation>('SELECT * FROM kff.cost_reservations WHERE action_id=$1', [actionId])).rows[0];
  if (existing) {
    requireCondition(existing.currency === input.currency && existing.reserved_minor === input.reserved_minor && existing.permit_id === input.permit_id && existing.cost_basis === input.cost_basis, 'IDEMPOTENCY_CONFLICT', '动作已有不同费用预占', 409);
    requireCondition(['RESERVED','PENDING_RECONCILIATION'].includes(existing.state), 'COST_ALREADY_FINAL', '已完成核账的动作不能重新预占执行', 409);
    await checkCostCapacity(client, action, input.currency, '0'); return existing;
  }
  requireCondition(['QUEUED','PREPARING'].includes(action.state), 'VERSION_CONFLICT', '费用只能在动作进入外部提交前预占', 409);
  await checkCostCapacity(client, action, input.currency, input.reserved_minor);
  const row = (await client.query<CostReservation>('INSERT INTO kff.cost_reservations(action_id,organization_id,brand_id,permit_id,currency,reserved_minor,cost_basis) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [actionId, action.organization_id, action.brand_id, input.permit_id, input.currency, input.reserved_minor, input.cost_basis])).rows[0];
  await client.query("INSERT INTO kff.cost_entries(id,organization_id,brand_id,action_id,currency,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,$5,'RESERVED',$4,$6,$7)", [randomUUID(), action.organization_id, action.brand_id, actionId, input.currency, digest(input), { reserved_minor: input.reserved_minor, actual_cost_minor: null, actor_kind: 'execution' }]); return row;
}
export async function markCostPending(client: PoolClient, actionId: string, reason: string) {
  const current = (await client.query<CostReservation>('SELECT * FROM kff.cost_reservations WHERE action_id=$1', [actionId])).rows[0];
  if (!current || current.state !== 'RESERVED') return;
  // The caller already owns run/action and any pilot locks. This only changes classification, not budget totals.
  const changed = (await client.query("UPDATE kff.cost_reservations SET state='PENDING_RECONCILIATION',version=version+1 WHERE action_id=$1 AND state='RESERVED' RETURNING action_id", [actionId])).rowCount;
  if (changed) await client.query("INSERT INTO kff.cost_entries(id,organization_id,brand_id,action_id,currency,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,$5,'PENDING_RECONCILIATION',$4,$6,$7)", [randomUUID(), current.organization_id, current.brand_id, actionId, current.currency, digest({ reason }), { reason, actual_cost_minor: null, actor_kind: 'execution' }]);
}
export async function reconcileCost(scope: Scope, actionId: string, input: z.infer<typeof costReconciliationInput>) {
  requireAdmin(scope); const value = costReconciliationInput.parse(input); const hash = digest({ action_id: actionId, ...value });
  return scoped(scope, async client => {
    const action = await lockAction(client, actionId);
    const previous = await priorEvent(client, value.request_id, hash); if (previous) return previous.details.result as CostReservation;
    if (value.decision !== 'PENDING') {
      requireCondition(!['QUEUED','PREPARING','SUBMITTING','SUBMITTED'].includes(action.state), 'COST_ACTION_IN_FLIGHT', '动作仍在途，保留费用预占', 409);
      const unclosed = await client.query('SELECT id FROM kff.agent_commands WHERE action_id=$1 AND quiesced_at IS NULL', [actionId]);
      requireCondition(!unclosed.rowCount, 'GUARDIAN_UNCONFIRMED', '旧执行上下文尚未确认关闭，保留费用预占', 409);
    }
    const found = (await client.query<CostReservation>('SELECT * FROM kff.cost_reservations WHERE action_id=$1', [actionId])).rows[0];
    requireCondition(found, 'NOT_FOUND', '动作没有费用预占记录', 404);
    if (found.permit_id) await client.query('SELECT id FROM kff.pilot_permits WHERE id=$1 FOR UPDATE', [found.permit_id]);
    const budget = await lockBudget(client, scope, found.currency);
    requireCondition(budget, 'BUDGET_UNCONFIGURED', '请先登记此币种的预算与记账精度', 409);
    const row = (await client.query<CostReservation>('SELECT * FROM kff.cost_reservations WHERE action_id=$1 FOR UPDATE', [actionId])).rows[0];
    requireCondition(row.version === value.expected_version, 'VERSION_CONFLICT', '费用记录已变化，请刷新后核账', 409);
    const pending = ['RESERVED','PENDING_RECONCILIATION'].includes(row.state);
    requireCondition(value.decision === 'ADJUST' ? !pending : pending, 'INVALID_COST_TRANSITION', '已结算费用需要使用差异调整', 409);
    const nextState = value.decision === 'PENDING' ? 'PENDING_RECONCILIATION' : value.decision === 'RELEASE' ? 'RELEASED' : 'SETTLED';
    const updated = (await client.query<CostReservation>('UPDATE kff.cost_reservations SET state=$1,actual_cost_minor=$2,evidence_ref=$3,version=version+1 WHERE action_id=$4 RETURNING *', [nextState, value.actual_cost_minor, value.evidence_ref, actionId])).rows[0];
    const overEstimate = value.actual_cost_minor !== null && BigInt(value.actual_cost_minor) > BigInt(row.reserved_minor);
    if (overEstimate && row.permit_id) await client.query('UPDATE kff.pilot_permits SET halted_at=COALESCE(halted_at,clock_timestamp()) WHERE id=$1', [row.permit_id]);
    const event = value.decision === 'ADJUST' ? 'ADJUSTED' : nextState;
    await client.query('INSERT INTO kff.cost_entries(id,organization_id,brand_id,action_id,currency,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [value.request_id, scope.organization_id, scope.brand_id, actionId, row.currency, event, scope.user_id, hash, { evidence_ref: value.evidence_ref, note: value.note, previous_actual_minor: row.actual_cost_minor, actual_cost_minor: value.actual_cost_minor, over_estimate: overEstimate, source: 'operator_reconciliation', result: updated }]);
    await audit(client, scope, 'cost.reconciled', actionId, { event_id: value.request_id, decision: value.decision, over_estimate: overEstimate }); return updated;
  });
}
export async function costWorkspace(scope: Scope): Promise<CostWorkspace> {
  return scoped(scope, async client => {
    const balances = (await client.query<CostBalance>("WITH balances AS (SELECT currency,sum(reserved_minor) FILTER(WHERE state IN ('RESERVED','PENDING_RECONCILIATION')) AS held_minor,sum(actual_cost_minor) AS confirmed_minor,count(*) FILTER(WHERE actual_cost_minor IS NULL)::int AS pending_count FROM kff.cost_reservations GROUP BY currency) SELECT COALESCE(b.currency,x.currency) AS currency,b.id,b.minor_unit_exponent,b.precision_source,b.limit_minor,b.version,COALESCE(x.held_minor,0)::text AS held_minor,COALESCE(x.confirmed_minor,0)::text AS confirmed_minor,COALESCE(x.pending_count,0) AS pending_count,CASE WHEN b.id IS NULL THEN NULL ELSE (b.limit_minor-COALESCE(x.held_minor,0)-COALESCE(x.confirmed_minor,0))::text END AS available_minor FROM kff.cost_budgets b FULL JOIN balances x ON x.currency=b.currency ORDER BY currency")).rows;
    const reservations = (await client.query<CostRecord>('SELECT c.*,t.title FROM kff.cost_reservations c JOIN kff.actions a ON a.id=c.action_id JOIN kff.tasks t ON t.id=a.task_id ORDER BY c.created_at DESC,c.action_id LIMIT 200')).rows;
    const entries = (await client.query<CostEvent>('SELECT * FROM kff.cost_entries ORDER BY created_at DESC,id LIMIT 200')).rows;
    return { balances, reservations, entries };
  });
}
