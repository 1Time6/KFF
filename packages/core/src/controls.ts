import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { scoped, transaction } from '@kff/database';
import { agentInput, agentControlInput, type Scope } from '@kff/contracts';
import { digest, requireCondition } from './index';
import { audit, requireAdmin } from './service';

export async function setOrganizationPause(scope: Scope, paused: boolean, reason: string) {
  requireAdmin(scope);
  return transaction(async client => {
    const member = await client.query("SELECT role FROM kff.organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [scope.organization_id, scope.user_id]);
    requireCondition(member.rowCount, 'FORBIDDEN_SCOPE', '组织停止需要组织管理员权限', 403);
    await client.query('UPDATE kff.organizations SET outbound_paused=$1 WHERE id=$2', [paused, scope.organization_id]);
    const counts = (await client.query("SELECT count(*) FILTER(WHERE state IN ('SUBMITTING','SUBMITTED'))::int AS in_flight,count(*) FILTER(WHERE state='QUEUED')::int AS queued,count(*) FILTER(WHERE state='PREPARING')::int AS preparing FROM kff.actions WHERE organization_id=$1", [scope.organization_id])).rows[0];
    await audit(client, scope, paused ? 'organization.paused' : 'organization.resumed', scope.organization_id, { reason, ...counts });
    return { outbound_paused: paused, ...counts };
  });
}
export async function setAccountPause(scope: Scope, accountId: string, paused: boolean, reason: string) {
  requireAdmin(scope);
  return scoped(scope, async client => {
    const result = await client.query('UPDATE kff.accounts SET outbound_paused=$1 WHERE id=$2 RETURNING id', [paused, accountId]);
    requireCondition(result.rowCount, 'NOT_FOUND', '账号不存在', 404);
    const counts = (await client.query("SELECT count(*) FILTER(WHERE a.state IN ('SUBMITTING','SUBMITTED'))::int AS in_flight,count(*) FILTER(WHERE a.state='QUEUED')::int AS queued FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE t.account_id=$1", [accountId])).rows[0];
    await audit(client, scope, paused ? 'account.paused' : 'account.resumed', accountId, { reason, ...counts }); return { outbound_paused: paused, ...counts };
  });
}
export async function createAgent(scope: Scope, input: z.infer<typeof agentInput>) {
  requireAdmin(scope); const value = agentInput.parse(input); const token = randomBytes(32).toString('hex');
  return scoped(scope, async client => {
    const row = (await client.query("INSERT INTO kff.agents(organization_id,brand_id,name,token_hash,status) VALUES($1,$2,$3,$4,'PAIRED') RETURNING id,name,status", [scope.organization_id, scope.brand_id, value.name, digest(token)])).rows[0];
    await audit(client, scope, 'agent.pairing_created', row.id);
    return { agent: row, configuration: { agent_id: row.id, organization_id: scope.organization_id, brand_id: scope.brand_id, token, controller_origin: process.env.KFF_APP_ORIGIN ?? 'http://127.0.0.1:3000' } };
  });
}
export async function controlAgent(scope: Scope, agentId: string, input: z.infer<typeof agentControlInput>) {
  requireAdmin(scope); const value = agentControlInput.parse(input);
  return scoped(scope, async client => {
    const agent = (await client.query('SELECT id,status FROM kff.agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0];
    requireCondition(agent, 'NOT_FOUND', 'Agent 不存在', 404);
    requireCondition(agent.status !== 'REVOKED' || value.action === 'REVOKE', 'VERSION_CONFLICT', '已撤销的凭据不可恢复，请重新配对', 409);
    const status = value.action === 'DRAIN' ? 'DRAINING' : value.action === 'REVOKE' ? 'REVOKED' : 'PAIRED';
    await client.query('UPDATE kff.agents SET status=$1 WHERE id=$2', [status, agentId]);
    const counts = (await client.query("SELECT count(*)::int AS commands,count(*) FILTER(WHERE a.state IN ('SUBMITTING','SUBMITTED'))::int AS in_flight FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id WHERE c.agent_id=$1 AND c.state IN ('READY','CLAIMED')", [agentId])).rows[0];
    await audit(client, scope, 'agent.' + value.action.toLowerCase(), agentId, { reason: value.reason, ...counts }); return { status, ...counts };
  });
}
