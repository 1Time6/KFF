import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction, projectRoot } from '@kff/database';
import { resultInput, type AgentCommand, type TaskSnapshot, type Capability, type ActionState, type ActionReport, type LeaseToken } from '@kff/contracts';
import { assertTransition, buildDiagnostic, canExecute, digest, isWrite, requireCondition } from './index';
import { findPermit, haltPilot } from './permits';
import { adapterImplementationDigest } from './artifacts';
import { markCostPending } from './costs';

export interface AgentIdentity { id: string; organization_id: string; brand_id: string; status: string }
interface CommandRow { id: string; organization_id: string; brand_id: string; action_id: string; attempt_id: string; agent_id: string; state: string; expires_at: Date; run_id: string; task_id: string; snapshot: TaskSnapshot; snapshot_hash: string; leases: LeaseToken[]; action_state: ActionState; stop_requested: boolean }

export async function authenticateAgent(request: Request): Promise<AgentIdentity> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  requireCondition(token && /^[a-f0-9]{64}$/.test(token), 'UNAUTHORIZED', 'Agent 身份无效', 401);
  const agent = (await query<AgentIdentity>("SELECT id,organization_id,brand_id,status FROM kff.agents WHERE token_hash=$1 AND status<>'REVOKED'", [digest(token)]))[0];
  requireCondition(agent, 'UNAUTHORIZED', 'Agent 未配对或已撤销', 401); return agent;
}
const commandSelect = 'SELECT c.*,a.run_id,a.task_id,a.state AS action_state,r.stop_requested,t.snapshot,t.snapshot_hash,at.leases FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id JOIN kff.runs r ON r.id=a.run_id JOIN kff.tasks t ON t.id=a.task_id JOIN kff.action_attempts at ON at.id=c.attempt_id';
async function lockedCommand(client: PoolClient, agentId: string, commandId: string): Promise<CommandRow> {
  const found = (await client.query<CommandRow>(commandSelect + ' WHERE c.id=$1 AND c.agent_id=$2', [commandId, agentId])).rows[0];
  requireCondition(found, 'FORBIDDEN_SCOPE', '命令不属于当前 Agent', 403);
  await client.query('SELECT id FROM kff.runs WHERE id=$1 FOR UPDATE', [found.run_id]);
  await client.query('SELECT id FROM kff.actions WHERE id=$1 FOR UPDATE', [found.action_id]);
  return (await client.query<CommandRow>(commandSelect + ' WHERE c.id=$1 FOR UPDATE OF c', [commandId])).rows[0];
}
async function validateLeases(client: PoolClient, command: CommandRow): Promise<void> {
  const time = (await client.query<{ valid: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS valid', [command.expires_at])).rows[0];
  requireCondition(time.valid && command.state === 'CLAIMED', 'LEASE_STALE', '命令已过期或不再受控', 409);
  requireCondition(command.leases.length === 2, 'LEASE_STALE', '命令资源租约不完整', 409);
  for (const lease of command.leases) {
    const valid = await client.query('SELECT resource_id FROM kff.resource_leases WHERE organization_id=$1 AND brand_id=$2 AND resource_type=$3 AND resource_id=$4 AND token=$5 AND holder_attempt_id=$6 AND expires_at>clock_timestamp() AND NOT quarantined FOR UPDATE', [command.organization_id, command.brand_id, lease.resource_type, lease.resource_id, lease.token, command.attempt_id]);
    requireCondition(valid.rowCount === 1, 'LEASE_STALE', '执行控制权已过期，环境保持隔离', 409);
  }
}
async function dispatchAllowed(client: PoolClient, snapshot: TaskSnapshot, taskId: string, reserveForAction?: string): Promise<void> {
  const account = (await client.query('SELECT a.*,o.outbound_paused AS organization_paused,b.outbound_paused AS brand_paused FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE a.id=$1 FOR SHARE OF o,b,a', [snapshot.account_id])).rows[0];
  const capability = (await client.query<Capability>('SELECT * FROM kff.capabilities WHERE id=$1', [snapshot.capability_id])).rows[0];
  requireCondition((account.state === 'ACTIVE' || (account.state === 'DRAFT' && !isWrite(snapshot) && snapshot.mode === 'CONTROLLED_PILOT')) && account.external_id === snapshot.external_account_id && (snapshot.account_version === undefined || account.version === snapshot.account_version) && (snapshot.credential_ref === undefined || account.credential_ref === snapshot.credential_ref), 'AUTH_EXPIRED', '账号已停用、凭据或身份已变化', 409);
  requireCondition(!account.organization_paused && !account.brand_paused && !account.outbound_paused, 'STOP_REQUESTED', '组织、品牌或账号已暂停', 409);
  requireCondition(capability.revision === snapshot.capability_revision && capability.adapter_version === snapshot.adapter_version, 'VERSION_CONFLICT', '能力版本已变化', 409);
  if (!snapshot.is_synthetic) requireCondition(snapshot.implementation_digest && snapshot.implementation_digest === capability.implementation_digest && snapshot.implementation_digest === adapterImplementationDigest(projectRoot, 'facebook'), 'VERSION_CONFLICT', '适配器实现已变化，旧试验许可不可复用', 409);
  if (!snapshot.is_synthetic) requireCondition(snapshot.platform_api_version && snapshot.platform_api_version === process.env.KFF_FACEBOOK_GRAPH_VERSION, 'VERSION_CONFLICT', 'Graph API 配置版本与任务快照不符', 409);
  if (snapshot.mode === 'CONTROLLED_PILOT') await findPermit(client, taskId, snapshot, reserveForAction);
  const permission = canExecute(capability, snapshot.mode, process.env.KFF_ENABLE_LIVE === 'true', snapshot.mode === 'CONTROLLED_PILOT');
  requireCondition(permission.allowed, permission.reason_code, '此动作当前不可执行', 409);
}

export async function dispatchOne(): Promise<boolean> {
  const candidate = (await query<{ id: string; run_id: string }>("SELECT j.id,a.run_id FROM kff.jobs j JOIN kff.actions a ON a.id=j.action_id JOIN kff.runs r ON r.id=a.run_id JOIN kff.tasks t ON t.id=a.task_id JOIN kff.accounts ac ON ac.id=t.account_id JOIN kff.brands b ON b.id=j.brand_id JOIN kff.organizations o ON o.id=j.organization_id WHERE j.state='READY' AND j.available_at<=now() AND NOT r.stop_requested AND NOT b.outbound_paused AND NOT o.outbound_paused AND NOT ac.outbound_paused ORDER BY j.created_at LIMIT 1"))[0];
  if (!candidate) return false;
  return transaction(async client => {
    await client.query('SELECT id FROM kff.runs WHERE id=$1 FOR UPDATE', [candidate.run_id]);
    const job = (await client.query<{ id: string; organization_id: string; brand_id: string; action_id: string }>("SELECT * FROM kff.jobs WHERE id=$1 AND state='READY' FOR UPDATE SKIP LOCKED", [candidate.id])).rows[0];
    if (!job) return false;
    const action = (await client.query('SELECT a.*,t.snapshot,t.snapshot_hash FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id WHERE a.id=$1 FOR UPDATE OF a', [job.action_id])).rows[0];
    if (action.state !== 'QUEUED') { await client.query("UPDATE kff.jobs SET state='DONE' WHERE id=$1", [job.id]); return false; }
    const snapshot = action.snapshot as TaskSnapshot;
    const agent = (await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status='ONLINE' AND heartbeat_at>now()-interval '20 seconds' FOR UPDATE", [snapshot.agent_id])).rows[0];
    const occupied = await client.query("SELECT id FROM kff.agent_commands WHERE agent_id=$1 AND state IN ('READY','CLAIMED')", [snapshot.agent_id]);
    const environment = (await client.query("SELECT id FROM kff.environments WHERE id=$1 AND state='IDLE'", [snapshot.environment_id])).rows[0];
    if (!agent || !environment || occupied.rowCount) { await client.query("UPDATE kff.jobs SET available_at=now()+interval '2 seconds' WHERE id=$1", [job.id]); return false; }
    try { await dispatchAllowed(client, snapshot, action.task_id); }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'CAPABILITY_BLOCKED';
      await client.query("UPDATE kff.actions SET state='BLOCKED',error_code=$1 WHERE id=$2", [code, action.id]);
      await client.query("UPDATE kff.runs SET status='FAILED',updated_at=now() WHERE id=$1", [action.run_id]);
      await client.query("UPDATE kff.tasks SET status='FAILED' WHERE id=$1", [action.task_id]);
      await client.query("UPDATE kff.jobs SET state='DONE' WHERE id=$1", [job.id]); return true;
    }
    const resources: { type: 'account' | 'environment'; id: string }[] = [{ type: 'account', id: snapshot.account_id }, { type: 'environment', id: snapshot.environment_id }];
    for (const resource of resources) {
      await client.query('INSERT INTO kff.resource_leases(organization_id,brand_id,resource_type,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [job.organization_id, job.brand_id, resource.type, resource.id]);
      const lease = (await client.query('SELECT *,expires_at>clock_timestamp() AS active FROM kff.resource_leases WHERE organization_id=$1 AND resource_type=$2 AND resource_id=$3 FOR UPDATE', [job.organization_id, resource.type, resource.id])).rows[0];
      if (lease.quarantined || lease.holder_attempt_id) {
        // Expired ownership is recovered separately; a new dispatcher never steals it.
        await client.query("UPDATE kff.jobs SET available_at=now()+interval '2 seconds' WHERE id=$1", [job.id]); return false;
      }
    }
    const attemptId = randomUUID();
    if (snapshot.mode === 'CONTROLLED_PILOT' && !isWrite(snapshot)) await findPermit(client, action.task_id, snapshot, action.id);
    await client.query('INSERT INTO kff.action_attempts(id,organization_id,brand_id,action_id,attempt_number,agent_id) VALUES($1,$2,$3,$4,1,$5)', [attemptId, job.organization_id, job.brand_id, action.id, snapshot.agent_id]);
    const leases: LeaseToken[] = [];
    for (const resource of resources) {
      const lease = (await client.query<{ token: string }>("UPDATE kff.resource_leases SET token=token+1,holder_attempt_id=$1,expires_at=clock_timestamp()+interval '30 seconds' WHERE organization_id=$2 AND resource_type=$3 AND resource_id=$4 RETURNING token", [attemptId, job.organization_id, resource.type, resource.id])).rows[0];
      leases.push({ resource_type: resource.type, resource_id: resource.id, token: lease.token });
    }
    await client.query('UPDATE kff.action_attempts SET leases=$1 WHERE id=$2', [JSON.stringify(leases), attemptId]);
    await client.query("INSERT INTO kff.agent_commands(organization_id,brand_id,action_id,attempt_id,agent_id,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '2 minutes')", [job.organization_id, job.brand_id, action.id, attemptId, snapshot.agent_id]);
    await client.query("UPDATE kff.actions SET state='PREPARING' WHERE id=$1", [action.id]);
    await client.query("UPDATE kff.runs SET status='RUNNING',updated_at=now() WHERE id=$1", [action.run_id]);
    await client.query("UPDATE kff.tasks SET status='RUNNING' WHERE id=$1", [action.task_id]);
    await client.query("UPDATE kff.environments SET state='BUSY' WHERE id=$1", [snapshot.environment_id]);
    await client.query("UPDATE kff.jobs SET state='DONE',attempts=attempts+1,leased_at=now() WHERE id=$1", [job.id]);
    return true;
  });
}

export async function agentHeartbeat(agent: AgentIdentity, commandId?: string) {
  return transaction(async client => {
    const current = (await client.query('SELECT status FROM kff.agents WHERE id=$1 FOR UPDATE', [agent.id])).rows[0];
    requireCondition(current && ['PAIRED', 'ONLINE', 'OFFLINE', 'DRAINING'].includes(current.status), 'UNAUTHORIZED', 'Agent 已停止接单', 401);
    await client.query("UPDATE kff.agents SET heartbeat_at=now(),status=CASE WHEN status='DRAINING' THEN status ELSE 'ONLINE' END WHERE id=$1", [agent.id]);
    if (!commandId) return { continue: true, lease_ms: 30000 };
    const command = await lockedCommand(client, agent.id, commandId);
    await validateLeases(client, command);
    const paused = (await client.query('SELECT b.outbound_paused OR o.outbound_paused OR a.outbound_paused AS paused FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE a.id=$1', [command.snapshot.account_id])).rows[0].paused;
    const beforeSubmission = command.action_state === 'PREPARING';
    const proceed = !(command.stop_requested || paused || current.status === 'DRAINING') || !beforeSubmission;
    for (const lease of command.leases) await client.query("UPDATE kff.resource_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE organization_id=$1 AND resource_type=$2 AND resource_id=$3 AND token=$4 AND holder_attempt_id=$5", [command.organization_id, lease.resource_type, lease.resource_id, lease.token, command.attempt_id]);
    return { continue: proceed, lease_ms: 30000 };
  });
}
export async function claimCommand(agent: AgentIdentity): Promise<AgentCommand | null> {
  return transaction(async client => {
    const current = (await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status='ONLINE' FOR UPDATE", [agent.id])).rows[0];
    if (!current) return null;
    const busy = await client.query("SELECT id FROM kff.agent_commands WHERE agent_id=$1 AND state='CLAIMED'", [agent.id]);
    if (busy.rowCount) return null;
    const command = (await client.query<CommandRow>(commandSelect + " WHERE c.agent_id=$1 AND c.state='READY' AND c.expires_at>clock_timestamp() AND NOT r.stop_requested AND NOT EXISTS(SELECT 1 FROM kff.accounts ac JOIN kff.brands b ON b.id=ac.brand_id JOIN kff.organizations o ON o.id=ac.organization_id WHERE ac.id=t.account_id AND (ac.outbound_paused OR b.outbound_paused OR o.outbound_paused)) ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED", [agent.id])).rows[0];
    if (!command) return null;
    await client.query("UPDATE kff.agent_commands SET state='CLAIMED',claimed_at=now() WHERE id=$1", [command.id]);
    return { protocol_version: 'kff.agent.v1', id: command.id, action_id: command.action_id, attempt_id: command.attempt_id, run_id: command.run_id, organization_id: command.organization_id, brand_id: command.brand_id, agent_id: command.agent_id, snapshot: command.snapshot, snapshot_hash: command.snapshot_hash, leases: command.leases, expires_at: command.expires_at.toISOString() };
  });
}
export async function beginSubmission(agent: AgentIdentity, commandId: string) {
  return transaction(async client => {
    const current = (await client.query('SELECT status FROM kff.agents WHERE id=$1 FOR SHARE', [agent.id])).rows[0];
    requireCondition(current?.status === 'ONLINE', 'STOP_REQUESTED', 'Agent 已停止接单', 409);
    const command = await lockedCommand(client, agent.id, commandId);
    await validateLeases(client, command);
    requireCondition(!command.stop_requested, 'STOP_REQUESTED', '运行已请求停止', 409);
    requireCondition(command.action_state === 'PREPARING', 'SUBMISSION_UNCERTAIN', '提交意图已记录，不能重复提交', 409);
    await dispatchAllowed(client, command.snapshot, command.task_id, command.action_id);
    requireCondition(digest(command.snapshot) === command.snapshot_hash, 'APPROVAL_STALE', '任务快照校验失败', 409);
    requireCondition(isWrite(command.snapshot), 'INVALID_INPUT', '只读动作不能进入写入阶段');
    await client.query("UPDATE kff.actions SET state='SUBMITTING' WHERE id=$1", [command.action_id]);
    await client.query("UPDATE kff.action_attempts SET state='SUBMITTING',submitted_at=now() WHERE id=$1", [command.attempt_id]);
    return { allowed: true, action_id: command.action_id };
  });
}
export async function commandStatus(agent: AgentIdentity, commandId: string) {
  const row = (await query<{ state: string; action_state: ActionState }>("SELECT c.state,a.state AS action_state FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id WHERE c.id=$1 AND c.agent_id=$2", [commandId, agent.id]))[0];
  requireCondition(row, 'FORBIDDEN_SCOPE', '命令不属于当前 Agent', 403); return row;
}
export async function acceptReport(agent: AgentIdentity, input: ActionReport) {
  const report = resultInput.parse(input); const payloadHash = digest(report);
  return transaction(async client => {
    const duplicate = (await client.query('SELECT payload_hash FROM kff.inbound_events WHERE id=$1 AND agent_id=$2', [report.event_id, agent.id])).rows[0];
    if (duplicate) { requireCondition(duplicate.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT', '重复回执内容不一致', 409); return { accepted: true, duplicate: true }; }
    const command = await lockedCommand(client, agent.id, report.command_id);
    await validateLeases(client, command);
    assertTransition(command.action_state, report.outcome);
    if (report.outcome === 'VERIFIED_SUCCEEDED') {
      requireCondition(report.receipt?.actual_account_id === command.snapshot.external_account_id, 'FORBIDDEN_SCOPE', '回执账号与任务不符', 403);
      requireCondition(report.receipt.evidence_kind === (command.snapshot.is_synthetic ? 'synthetic_dom' : 'graph_object'), 'INVALID_INPUT', '证据类型与运行范围不匹配');
      if (isWrite(command.snapshot)) {
        requireCondition(['SUBMITTING', 'SUBMITTED'].includes(command.action_state), 'SUBMISSION_UNCERTAIN', '缺少持久提交意图', 409);
        requireCondition(report.receipt.content_hash === command.snapshot.content_hash, 'INVALID_INPUT', '远端内容摘要不符');
      }
    }
    await client.query('INSERT INTO kff.inbound_events(id,organization_id,brand_id,agent_id,command_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6)', [report.event_id, agent.organization_id, agent.brand_id, agent.id, command.id, payloadHash]);
    await client.query('UPDATE kff.actions SET state=$1,error_code=$2,receipt=$3 WHERE id=$4', [report.outcome, report.error_code ?? null, report.receipt ?? null, command.action_id]);
    if (report.outcome !== 'VERIFIED_SUCCEEDED') await haltPilot(client, command.action_id);
    await markCostPending(client, command.action_id, 'ACTION_' + report.outcome);
    if (report.outcome === 'VERIFIED_SUCCEEDED' && !command.snapshot.is_synthetic && !isWrite(command.snapshot)) await client.query("UPDATE kff.accounts SET state='ACTIVE' WHERE id=$1 AND version=$2 AND credential_ref=$3", [command.snapshot.account_id, command.snapshot.account_version, command.snapshot.credential_ref]);
    await client.query('UPDATE kff.action_attempts SET state=$1,completed_at=now() WHERE id=$2', [report.outcome, command.attempt_id]);
    await client.query("UPDATE kff.agent_commands SET state='DONE' WHERE id=$1", [command.id]);
    const quarantine = report.outcome === 'UNKNOWN_OUTCOME' || report.error_code === 'AGENT_RESTART';
    for (const lease of command.leases) await client.query('UPDATE kff.resource_leases SET quarantined=$1,holder_attempt_id=CASE WHEN $1 THEN holder_attempt_id ELSE NULL END,expires_at=clock_timestamp() WHERE organization_id=$2 AND resource_type=$3 AND resource_id=$4 AND token=$5 AND holder_attempt_id=$6', [quarantine, command.organization_id, lease.resource_type, lease.resource_id, lease.token, command.attempt_id]);
    await client.query('UPDATE kff.environments SET state=$1 WHERE id=$2', [quarantine ? 'QUARANTINED' : 'IDLE', command.snapshot.environment_id]);
    const status = report.outcome === 'VERIFIED_SUCCEEDED' ? 'SUCCEEDED' : report.outcome === 'CANCELED' ? 'CANCELED' : ['UNKNOWN_OUTCOME', 'NEEDS_HUMAN'].includes(report.outcome) ? 'NEEDS_HUMAN' : 'FAILED';
    await client.query('UPDATE kff.runs SET status=$1,updated_at=now() WHERE id=$2', [status, command.run_id]);
    await client.query('UPDATE kff.tasks SET status=$1 WHERE id=$2', [status, command.task_id]);
    const manifest = buildDiagnostic(report.diagnostic, report.error_code, agent, command.action_id, { adapter_version: command.snapshot.adapter_version, attempt_id: command.attempt_id, outcome: report.outcome });
    await client.query('INSERT INTO kff.diagnostic_bundles(organization_id,brand_id,action_id,manifest) VALUES($1,$2,$3,$4)', [agent.organization_id, agent.brand_id, command.action_id, manifest]);
    await client.query('INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6)', [agent.organization_id, agent.brand_id, agent.id, 'action.reported', command.action_id, { outcome: report.outcome, error_code: report.error_code ?? null, evidence_kind: report.receipt?.evidence_kind ?? null }]);
    return { accepted: true, duplicate: false };
  });
}
export async function recoverExpired(): Promise<number> {
  const expired = await query<{ id: string; agent_id: string }>("SELECT DISTINCT c.id,c.agent_id FROM kff.agent_commands c JOIN kff.action_attempts at ON at.id=c.attempt_id JOIN kff.resource_leases l ON l.holder_attempt_id=at.id JOIN kff.agents ag ON ag.id=c.agent_id JOIN kff.actions a ON a.id=c.action_id JOIN kff.runs r ON r.id=a.run_id JOIN kff.tasks t ON t.id=a.task_id JOIN kff.accounts ac ON ac.id=t.account_id JOIN kff.brands b ON b.id=c.brand_id JOIN kff.organizations o ON o.id=c.organization_id WHERE c.state IN ('READY','CLAIMED') AND (c.expires_at<=clock_timestamp() OR l.expires_at<=clock_timestamp() OR ag.status='REVOKED' OR (c.state='READY' AND (r.stop_requested OR b.outbound_paused OR o.outbound_paused OR ac.outbound_paused OR ag.status='DRAINING')))");
  let count = 0;
  for (const row of expired) await transaction(async client => {
    const command = await lockedCommand(client, row.agent_id, row.id);
    if (!['READY', 'CLAIMED'].includes(command.state)) return;
    const stillExpired = await client.query("SELECT 1 FROM kff.resource_leases l JOIN kff.agents ag ON ag.id=$2 JOIN kff.accounts ac ON ac.id=$4 JOIN kff.brands b ON b.id=ac.brand_id JOIN kff.organizations o ON o.id=ac.organization_id WHERE l.holder_attempt_id=$1 AND (l.expires_at<=clock_timestamp() OR $3::timestamptz<=clock_timestamp() OR ag.status='REVOKED' OR ($5 AND ($6 OR b.outbound_paused OR o.outbound_paused OR ac.outbound_paused OR ag.status='DRAINING')))", [command.attempt_id, command.agent_id, command.expires_at, command.snapshot.account_id, command.state === 'READY', command.stop_requested]);
    if (!stillExpired.rowCount) return;
    const neverClaimed = command.state === 'READY';
    const outcome = neverClaimed ? 'CANCELED' : ['SUBMITTING', 'SUBMITTED'].includes(command.action_state) ? 'UNKNOWN_OUTCOME' : 'NEEDS_HUMAN';
    assertTransition(command.action_state, outcome);
    await client.query('UPDATE kff.actions SET state=$1,error_code=$2 WHERE id=$3', [outcome, neverClaimed ? 'COMMAND_NOT_STARTED' : 'LEASE_EXPIRED', command.action_id]);
    await haltPilot(client, command.action_id);
    await markCostPending(client, command.action_id, neverClaimed ? 'COMMAND_NEVER_CLAIMED' : 'EXECUTION_LEASE_EXPIRED');
    await client.query("UPDATE kff.action_attempts SET state=$1,completed_at=now() WHERE id=$2", [outcome, command.attempt_id]);
    await client.query("UPDATE kff.agent_commands SET state='EXPIRED',quiesced_at=CASE WHEN $1 THEN now() ELSE quiesced_at END WHERE id=$2", [neverClaimed, command.id]);
    await client.query('UPDATE kff.resource_leases SET quarantined=NOT $1,holder_attempt_id=CASE WHEN $1 THEN NULL ELSE holder_attempt_id END,expires_at=now() WHERE holder_attempt_id=$2', [neverClaimed, command.attempt_id]);
    await client.query('UPDATE kff.environments SET state=$1 WHERE id=$2', [neverClaimed ? 'IDLE' : 'QUARANTINED', command.snapshot.environment_id]);
    await client.query('UPDATE kff.runs SET status=$1,updated_at=now() WHERE id=$2', [neverClaimed ? 'CANCELED' : 'NEEDS_HUMAN', command.run_id]);
    await client.query('UPDATE kff.tasks SET status=$1 WHERE id=$2', [neverClaimed ? 'CANCELED' : 'NEEDS_HUMAN', command.task_id]);
    await client.query('INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6)', [command.organization_id, command.brand_id, command.agent_id, neverClaimed ? 'action.canceled_before_claim' : 'action.lease_expired', command.action_id, { outcome, quarantined: !neverClaimed, closure_evidence: neverClaimed ? 'controller_never_claimed' : null }]);
    count++;
  });
  await query("UPDATE kff.agents SET status='OFFLINE' WHERE status='ONLINE' AND heartbeat_at<now()-interval '25 seconds'");
  return count;
}
