import type { PoolClient } from 'pg';
import { scoped, transaction } from '@kff/database';
import type { Scope, TaskSnapshot } from '@kff/contracts';
import { browserEnvironmentSnapshot, environmentConfigurationInput, environmentControlInput, environmentOperationInput, environmentOpenedInput, environmentResultInput, environmentCommand, type EnvironmentCommand } from '../../contracts/src/environment';
import { digest, requireCondition } from './index';
import { requireAdmin, audit } from './service';
import type { AgentIdentity } from './execution';

export async function assertEnvironmentSnapshot(client: PoolClient, snapshot: TaskSnapshot) {
  const environment = (await client.query('SELECT * FROM kff.environments WHERE id=$1 FOR SHARE', [snapshot.environment_id])).rows[0];
  requireCondition(environment && environment.account_id === snapshot.account_id && environment.agent_id === snapshot.agent_id && environment.profile_key === snapshot.profile_key && environment.configuration_version === (snapshot.environment_version ?? 1), 'ENVIRONMENT_CHANGED', '环境绑定或配置已变化，请重新创建并审核任务', 409);
  requireCondition(environment.state !== 'DISABLED', 'ENVIRONMENT_DISABLED', '环境已禁用', 409);
  if (snapshot.browser_environment) requireCondition(digest(snapshot.browser_environment.configuration) === digest(environment.browser_configuration), 'ENVIRONMENT_CHANGED', '受管浏览器配置与任务不符', 409);
}

export async function environmentWorkspace(scope: Scope) {
  return scoped(scope, async client => (await client.query(`SELECT e.*,a.display_name,a.external_id,a.platform,a.account_type,a.is_synthetic,
    ag.name AS agent_name,ag.status AS agent_status,ag.heartbeat_at>clock_timestamp()-interval '20 seconds' AS agent_online,
    c.id AS command_id,c.operation,c.state AS command_state,c.stop_requested,c.opened_at,
    identity_check.result AS identity_result,identity_check.state AS identity_check_state
    FROM kff.environments e JOIN kff.accounts a ON a.id=e.account_id JOIN kff.agents ag ON ag.id=e.agent_id
    LEFT JOIN LATERAL(SELECT * FROM kff.environment_commands WHERE environment_id=e.id ORDER BY created_at DESC,id LIMIT 1)c ON true
    LEFT JOIN LATERAL(SELECT result,state FROM kff.environment_commands WHERE environment_id=e.id AND operation='CHECK'
      AND snapshot->>'account_type'='profile' AND snapshot->>'configuration_version'=e.configuration_version::text
      ORDER BY created_at DESC,id LIMIT 1)identity_check ON true
    ORDER BY e.created_at,e.id`)).rows);
}

async function idleEnvironment(client: PoolClient, environmentId: string) {
  const environment = (await client.query('SELECT * FROM kff.environments WHERE id=$1 FOR UPDATE', [environmentId])).rows[0];
  requireCondition(environment, 'NOT_FOUND', '环境不存在', 404);
  const commands = await client.query("SELECT id FROM kff.environment_commands WHERE environment_id=$1 AND state IN ('QUEUED','RUNNING','QUARANTINED')", [environmentId]);
  const leases = await client.query("SELECT resource_id FROM kff.resource_leases WHERE (resource_type='environment' AND resource_id=$1 OR resource_type='account' AND resource_id=$2) AND (holder_attempt_id IS NOT NULL OR holder_control_id IS NOT NULL OR quarantined)", [environmentId, environment.account_id]);
  requireCondition(['IDLE', 'DISABLED'].includes(environment.state) && !commands.rowCount && !leases.rowCount, 'RESOURCE_BUSY', '账号或环境正在执行、人工登录或等待关闭证明', 409);
  return environment;
}

export async function configureEnvironment(scope: Scope, environmentId: string, input: unknown) {
  requireAdmin(scope); const value = environmentConfigurationInput.parse(input);
  return scoped(scope, async client => {
    const environment = await idleEnvironment(client, environmentId);
    requireCondition(environment.configuration_version === value.expected_version, 'VERSION_CONFLICT', '环境版本已变化', 409);
    const account = (await client.query('SELECT external_id FROM kff.accounts WHERE id=$1', [environment.account_id])).rows[0];
    requireCondition(account.external_id === value.configuration.operating_identity_id, 'ACCOUNT_MISMATCH', '操作身份必须与绑定账号一致');
    if (value.configuration.driver === 'adspower') {
      // Serialize duplicate Profile assignments across brands on the same host.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [environment.agent_id + ':adspower:' + value.configuration.provider_profile_id]);
      const bound = await client.query("SELECT id FROM kff.environments WHERE agent_id=$1 AND browser_configuration->>'driver'='adspower' AND browser_configuration->>'provider_profile_id'=$2 AND id<>$3", [environment.agent_id, value.configuration.provider_profile_id, environmentId]);
      requireCondition(!bound.rowCount, 'PROFILE_ALREADY_BOUND', '这个 Profile 已绑定其他环境', 409);
    }
    const updated = (await client.query("UPDATE kff.environments SET browser_configuration=$1,configuration_version=configuration_version+1,browser_status='UNASSESSED',browser_checked_at=NULL,browser_error_code=NULL WHERE id=$2 RETURNING *", [value.configuration, environmentId])).rows[0];
    await audit(client, scope, 'environment.configured', environmentId, { version: updated.configuration_version, driver: value.configuration.driver });
    return updated;
  });
}

export async function queueEnvironmentOperation(scope: Scope, environmentId: string, input: unknown) {
  requireAdmin(scope); const value = environmentOperationInput.parse(input); const requestHash = digest({ environmentId, ...value });
  return scoped(scope, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope.brand_id + ':environment:' + value.request_id]);
    const existing = (await client.query('SELECT * FROM kff.environment_commands WHERE request_id=$1', [value.request_id])).rows[0];
    if (existing) { requireCondition(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', '请求标识已用于不同操作', 409); return existing; }
    const environment = await idleEnvironment(client, environmentId);
    requireCondition(environment.state === 'IDLE', 'ENVIRONMENT_DISABLED', '请先启用环境', 409);
    requireCondition(environment.configuration_version === value.expected_version, 'VERSION_CONFLICT', '环境版本已变化', 409);
    requireCondition(environment.browser_configuration, 'ENVIRONMENT_UNCONFIGURED', '请先保存浏览器配置', 409);
    const account = (await client.query('SELECT * FROM kff.accounts WHERE id=$1', [environment.account_id])).rows[0];
    const agent = (await client.query('SELECT status FROM kff.agents WHERE id=$1', [environment.agent_id])).rows[0];
    requireCondition(!['REVOKED', 'DRAINING', 'QUARANTINED'].includes(agent.status), 'AGENT_UNAVAILABLE', 'Agent 当前不接受新操作', 409);
    const snapshot = browserEnvironmentSnapshot.parse({ environment_id: environment.id, account_id: account.id, agent_id: environment.agent_id, organization_id: scope.organization_id, brand_id: scope.brand_id, profile_key: environment.profile_key, configuration_version: environment.configuration_version, configuration: environment.browser_configuration, platform: account.platform, account_type: account.account_type, is_synthetic: account.is_synthetic });
    const command = (await client.query("INSERT INTO kff.environment_commands(organization_id,brand_id,environment_id,account_id,agent_id,operation,snapshot,snapshot_hash,request_id,request_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '15 minutes') RETURNING *", [scope.organization_id, scope.brand_id, environment.id, account.id, environment.agent_id, value.operation, snapshot, digest(snapshot), value.request_id, requestHash])).rows[0];
    await audit(client, scope, 'environment.operation_queued', environmentId, { command_id: command.id, operation: value.operation });
    return command;
  });
}

export async function controlEnvironment(scope: Scope, environmentId: string, input: unknown) {
  requireAdmin(scope); const value = environmentControlInput.parse(input);
  return scoped(scope, async client => {
    const environment = value.action === 'STOP' ? (await client.query('SELECT * FROM kff.environments WHERE id=$1', [environmentId])).rows[0] : await idleEnvironment(client, environmentId);
    requireCondition(environment, 'NOT_FOUND', '环境不存在', 404);
    requireCondition(environment.configuration_version === value.expected_version, 'VERSION_CONFLICT', '环境版本已变化', 409);
    if (value.action === 'STOP') {
      await client.query("UPDATE kff.environment_commands SET stop_requested=true,state=CASE WHEN state='QUEUED' THEN 'FAILED' ELSE state END WHERE environment_id=$1 AND state IN ('QUEUED','RUNNING','QUARANTINED')", [environmentId]);
    } else await client.query("UPDATE kff.environments SET state=$1,configuration_version=configuration_version+1 WHERE id=$2", [value.action === 'DISABLE' ? 'DISABLED' : 'IDLE', environmentId]);
    await audit(client, scope, 'environment.' + value.action.toLowerCase(), environmentId);
    return { accepted: true };
  });
}

export async function claimEnvironmentCommand(agent: AgentIdentity): Promise<EnvironmentCommand | null> {
  return transaction(async client => {
    const current = (await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status='ONLINE' FOR UPDATE", [agent.id])).rows[0];
    if (!current) return null;
    const busy = await client.query("SELECT id FROM kff.agent_commands WHERE agent_id=$1 AND (state IN ('READY','CLAIMED') OR quiesced_at IS NULL) UNION ALL SELECT id FROM kff.environment_commands WHERE agent_id=$1 AND state IN ('RUNNING','QUARANTINED')", [agent.id]);
    if (busy.rowCount) return null;
    const candidate = (await client.query("SELECT * FROM kff.environment_commands WHERE agent_id=$1 AND state='QUEUED' AND NOT stop_requested AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE", [agent.id])).rows[0];
    if (!candidate) return null;
    const environment = (await client.query('SELECT * FROM kff.environments WHERE id=$1 FOR UPDATE', [candidate.environment_id])).rows[0];
    const snapshot = browserEnvironmentSnapshot.parse(candidate.snapshot);
    if (environment.configuration_version !== snapshot.configuration_version || environment.agent_id !== agent.id || environment.state === 'DISABLED') {
      await client.query("UPDATE kff.environment_commands SET state='FAILED',stop_requested=true WHERE id=$1", [candidate.id]); return null;
    }
    if (environment.state !== 'IDLE') return null;
    const resources = [['account', candidate.account_id], ['environment', candidate.environment_id]];
    for (const [type, resourceId] of resources) {
      await client.query('INSERT INTO kff.resource_leases(organization_id,brand_id,resource_type,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [agent.organization_id, agent.brand_id, type, resourceId]);
      const lease = (await client.query('SELECT * FROM kff.resource_leases WHERE organization_id=$1 AND resource_type=$2 AND resource_id=$3 FOR UPDATE', [agent.organization_id, type, resourceId])).rows[0];
      if (lease.holder_attempt_id || lease.holder_control_id || lease.quarantined) return null;
    }
    for (const [type, resourceId] of resources) await client.query("UPDATE kff.resource_leases SET token=token+1,holder_control_id=$1,expires_at=clock_timestamp()+interval '30 seconds' WHERE organization_id=$2 AND resource_type=$3 AND resource_id=$4", [candidate.id, agent.organization_id, type, resourceId]);
    await client.query("UPDATE kff.environment_commands SET state='RUNNING',heartbeat_at=clock_timestamp() WHERE id=$1", [candidate.id]);
    await client.query("UPDATE kff.environments SET state='BUSY',browser_status='STARTING',browser_error_code=NULL WHERE id=$1", [environment.id]);
    return environmentCommand.parse({ protocol_version: 'kff.environment.v1', id: candidate.id, operation: candidate.operation, snapshot, snapshot_hash: candidate.snapshot_hash, expires_at: candidate.expires_at.toISOString() });
  });
}

export async function environmentHeartbeat(agent: AgentIdentity, commandId: string, opened?: unknown) {
  const observation = opened === undefined ? undefined : environmentOpenedInput.parse(opened);
  return transaction(async client => {
    const current = (await client.query('SELECT status FROM kff.agents WHERE id=$1 FOR UPDATE', [agent.id])).rows[0];
    const command = (await client.query('SELECT * FROM kff.environment_commands WHERE id=$1 AND agent_id=$2 FOR UPDATE', [commandId, agent.id])).rows[0];
    requireCondition(command, 'FORBIDDEN_SCOPE', '环境命令不属于当前 Agent', 403);
    const valid = command.state === 'RUNNING' && Date.parse(command.expires_at) > Date.now() && current.status === 'ONLINE' && !command.stop_requested;
    if (!valid) return { continue: false };
    // An expired lease is never resurrected by a delayed heartbeat.
    const leases = await client.query('SELECT resource_id FROM kff.resource_leases WHERE holder_control_id=$1 AND expires_at>clock_timestamp() AND NOT quarantined FOR UPDATE', [commandId]);
    if (leases.rowCount !== 2) return { continue: false };
    await client.query("UPDATE kff.resource_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE holder_control_id=$1", [commandId]);
    await client.query('UPDATE kff.environment_commands SET heartbeat_at=clock_timestamp(),opened_at=CASE WHEN $2 THEN COALESCE(opened_at,clock_timestamp()) ELSE opened_at END WHERE id=$1', [commandId, !!observation]);
    if (observation) await client.query("UPDATE kff.environments SET browser_status='RUNNING',browser_version=$1 WHERE id=$2", [observation.browser_version, command.environment_id]);
    return { continue: true };
  });
}

export async function completeEnvironmentCommand(agent: AgentIdentity, commandId: string, input: unknown) {
  const result = environmentResultInput.parse(input);
  return transaction(async client => {
    const command = (await client.query('SELECT * FROM kff.environment_commands WHERE id=$1 AND agent_id=$2 FOR UPDATE', [commandId, agent.id])).rows[0];
    requireCondition(command, 'FORBIDDEN_SCOPE', '环境命令不属于当前 Agent', 403);
    if (command.result) { requireCondition(digest(command.result) === digest(result), 'IDEMPOTENCY_CONFLICT', '关闭回执内容不一致', 409); return { accepted: true, duplicate: true }; }
    requireCondition(['RUNNING', 'QUARANTINED'].includes(command.state), 'VERSION_CONFLICT', '环境命令没有取得执行权', 409);
    requireCondition(result.outcome !== 'CHECKED' || command.operation === 'CHECK', 'INVALID_INPUT', '登录窗口关闭不能记作检查成功');
    const snapshot = browserEnvironmentSnapshot.parse(command.snapshot);
    const profileCheck = command.operation === 'CHECK' && snapshot.platform === 'facebook' && snapshot.account_type === 'profile' && !snapshot.is_synthetic;
    requireCondition(!result.identity || profileCheck, 'INVALID_INPUT', '此环境操作不能提交个人账号身份回执');
    if (profileCheck && result.outcome === 'CHECKED') requireCondition(result.identity, 'IDENTITY_UNVERIFIED', '个人账号检查缺少页面身份回执');
    if (result.identity) {
      requireCondition(result.identity.operating_identity_id === snapshot.configuration.operating_identity_id, 'ACCOUNT_MISMATCH', '身份回执与绑定账号不符');
      requireCondition(Date.parse(result.identity.observed_at) >= Date.parse(command.created_at) && Date.parse(result.identity.observed_at) <= Date.now() + 30000, 'INVALID_INPUT', '身份回执核验时间无效');
    }
    await client.query("UPDATE kff.environment_commands SET state=$1,result=$2,closed_at=clock_timestamp() WHERE id=$3", [result.outcome === 'BLOCKED' ? 'FAILED' : 'CLOSED', result, commandId]);
    await client.query("UPDATE kff.resource_leases SET holder_control_id=NULL,quarantined=false,expires_at=clock_timestamp() WHERE holder_control_id=$1", [commandId]);
    await client.query("UPDATE kff.environments SET state='IDLE',browser_status='CLOSED',browser_version=COALESCE($1,browser_version),browser_checked_at=CASE WHEN $2 THEN clock_timestamp() ELSE browser_checked_at END,browser_error_code=$3 WHERE id=$4", [result.browser_version ?? null, result.outcome === 'CHECKED', result.error_code ?? null, command.environment_id]);
    return { accepted: true, duplicate: false };
  });
}

export async function recoverEnvironmentCommands() {
  return transaction(async client => {
    await client.query("UPDATE kff.environment_commands SET state='FAILED',stop_requested=true WHERE state='QUEUED' AND expires_at<=clock_timestamp()");
    const commands = (await client.query("SELECT c.* FROM kff.environment_commands c WHERE c.state='RUNNING' AND (c.heartbeat_at<clock_timestamp()-interval '30 seconds' OR c.expires_at<=clock_timestamp()) FOR UPDATE OF c SKIP LOCKED")).rows;
    for (const command of commands) {
      await client.query("UPDATE kff.environment_commands SET state='QUARANTINED',stop_requested=true WHERE id=$1", [command.id]);
      await client.query('UPDATE kff.resource_leases SET quarantined=true WHERE holder_control_id=$1', [command.id]);
      await client.query("UPDATE kff.environments SET state='QUARANTINED',browser_status='UNKNOWN',browser_error_code='GUARDIAN_UNCONFIRMED' WHERE id=$1", [command.environment_id]);
    }
    return commands.length;
  });
}
