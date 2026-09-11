import { z } from 'zod';
import { scoped, transaction } from '@kff/database';
import { actionStateSchema, quiescenceInput, type Scope, type TaskSnapshot } from '@kff/contracts';
import { digest, requireCondition } from './index';
import { audit, requireAdmin, runDetail } from './service';
import type { AgentIdentity } from './execution';

export async function recordQuiescence(agent: AgentIdentity, commandId: string, input: z.infer<typeof quiescenceInput>) {
  const proof = quiescenceInput.parse(input);
  return transaction(async client => {
    const row = (await client.query('SELECT * FROM kff.agent_commands WHERE id=$1 AND agent_id=$2 FOR UPDATE', [commandId, agent.id])).rows[0];
    requireCondition(row && ['DONE','EXPIRED'].includes(row.state), 'VERSION_CONFLICT', '执行上下文只能在命令终止后确认关闭', 409);
    requireCondition(row.organization_id === agent.organization_id && row.brand_id === agent.brand_id && proof.command_id === commandId && proof.action_id === row.action_id, 'FORBIDDEN_SCOPE', '关闭证明与命令不符', 403);
    const previous = (await client.query("SELECT details FROM kff.audit_events WHERE event_type='guardian.quiesced' AND object_id=$1", [commandId])).rows[0];
    if (previous) requireCondition(digest(previous.details.proof) === digest(proof), 'IDEMPOTENCY_CONFLICT', '关闭证明与已记录内容不一致', 409);
    else await client.query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details) VALUES($1,$2,$3,'guardian.quiesced',$4,$5)", [agent.organization_id, agent.brand_id, agent.id, commandId, { actor_kind: 'agent', proof }]);
    await client.query('UPDATE kff.agent_commands SET quiesced_at=COALESCE(quiesced_at,now()) WHERE id=$1', [commandId]); return { quiesced: true };
  });
}
export async function exportDiagnostic(scope: Scope, bundleId: string) {
  requireAdmin(scope);
  return scoped(scope, async client => {
    const bundle = (await client.query('SELECT * FROM kff.diagnostic_bundles WHERE id=$1 AND expires_at>now()', [bundleId])).rows[0];
    requireCondition(bundle, 'NOT_FOUND', '诊断记录不存在或已过期', 404);
    const manifest = bundle.manifest;
    const scene = z.object({ identity_count: z.number().int().min(0).max(100), submit_controls: z.number().int().min(0).max(100), result_count: z.number().int().min(0).max(100) }).strict();
    const schema = z.object({ schema_version: z.literal('kff.diagnostic.v1'), organization_id: z.literal(scope.organization_id), brand_id: z.literal(scope.brand_id), action_id: z.literal(bundle.action_id), level: z.enum(['D0', 'D1']), step: z.string().regex(/^[a-z0-9_-]{1,60}$/), error_code: z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(), created_at: z.string().datetime(), redaction_version: z.literal('allowlist-v1'), files: z.array(z.object({ name: z.literal('semantic-counts.json'), sha256: z.string(), content: scene }).strict()).max(1), omitted: z.array(z.enum(['raw_dom', 'screenshots', 'trace', 'cookies', 'message_body', 'network_bodies'])), downgrade_reason: z.enum(['本驱动未取得可安全导出的现场，保留 D0']).nullable() }).strict();
    const schemaV2 = schema.extend({ schema_version: z.literal('kff.diagnostic.v2'), protocol_version: z.literal('kff.agent.v1'), adapter_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).nullable(), attempt_id: z.string().uuid().nullable(), outcome: actionStateSchema.nullable(), duration_ms: z.number().int().min(0).max(3600000).nullable(), executor_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).nullable(), browser_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).nullable() });
    const parsed = z.union([schema, schemaV2]).safeParse(manifest);
    requireCondition(parsed.success && parsed.data.files.every(file => digest(file.content) === file.sha256), 'DIAGNOSTIC_REDACTION_FAILED', '诊断包未通过共享前检查', 409);
    await audit(client, scope, 'diagnostic.exported', bundleId, { action_id: bundle.action_id, sha256: digest(parsed.data), level: parsed.data.level });
    return parsed.data;
  });
}
const fixturePosts = z.array(z.object({ id: z.string().regex(/^synthetic_[a-f0-9-]{36}$/), account_id: z.string(), action_id: z.string().uuid(), body: z.string().max(5000), content_hash: z.string(), created_at: z.string().datetime() }).strict()).max(100);
export async function reconcileSynthetic(scope: Scope, runId: string, readPosts?: (actionId: string) => Promise<unknown>) {
  requireAdmin(scope); const detail = await runDetail(scope, runId);
  requireCondition(detail.task.snapshot.is_synthetic, 'PILOT_PERMIT_REQUIRED', '真实结果需使用相应只读许可和远端对象核验', 409);
  requireCondition(detail.run.action_state === 'UNKNOWN_OUTCOME' || detail.run.action_state === 'VERIFIED_SUCCEEDED', 'VERSION_CONFLICT', '当前运行没有待核验的提交', 409);
  const actionId = detail.run.action_id!;
  const source = readPosts ?? (async (id: string) => {
    const response = await fetch('http://127.0.0.1:4311/posts?action_id=' + encodeURIComponent(id), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    requireCondition(response.ok && Number(response.headers.get('content-length') ?? 0) <= 1000000, 'REMOTE_ERROR', '合成记录暂时无法核验', 502);
    const text = await response.text(); requireCondition(text.length <= 1000000, 'REMOTE_ERROR', '合成记录超过读取上限', 502); return JSON.parse(text);
  });
  const posts = fixturePosts.parse(await source(actionId));
  const snapshot = detail.task.snapshot;
  const matches = posts.filter(post => post.action_id === actionId && post.account_id === snapshot.external_account_id && post.content_hash === snapshot.content_hash && digest(post.body) === snapshot.content_hash);
  return scoped(scope, async client => {
    await client.query('SELECT id FROM kff.runs WHERE id=$1 FOR UPDATE', [runId]);
    const action = (await client.query('SELECT * FROM kff.actions WHERE id=$1 FOR UPDATE', [actionId])).rows[0];
    requireCondition(action.adjudication_version === 0, 'MANUAL_DECISION_EXISTS', '已有人工裁定记录，自动核验不能覆盖该记录', 409);
    requireCondition(['UNKNOWN_OUTCOME', 'VERIFIED_SUCCEEDED'].includes(action.state), 'VERSION_CONFLICT', '运行状态已变化', 409);
    if (matches.length !== 1 || posts.length !== 1) {
      await audit(client, scope, 'action.reconciliation_inconclusive', actionId, { matches: matches.length, observed_count: posts.length });
      return { reconciled: false, reason_code: 'SUBMISSION_UNCERTAIN', message: '证据不足，保留原状态；没有创建新动作' };
    }
    const receipt = { remote_id: matches[0].id, actual_account_id: snapshot.external_account_id, content_hash: snapshot.content_hash, evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() };
    await client.query("UPDATE kff.actions SET state='VERIFIED_SUCCEEDED',receipt=$1,error_code=NULL WHERE id=$2", [receipt, actionId]);
    await client.query("UPDATE kff.runs SET status='SUCCEEDED',updated_at=now() WHERE id=$1", [runId]);
    await client.query("UPDATE kff.tasks SET status='SUCCEEDED' WHERE id=$1", [detail.task.id]);
    await audit(client, scope, 'action.reconciled', actionId, { remote_id: matches[0].id, evidence_kind: 'synthetic_dom' });
    return { reconciled: true, reason_code: 'VERIFIED_SUCCEEDED', message: '已核实原提交；环境解除隔离仍需执行上下文关闭证据' };
  });
}
export async function releaseQuarantine(scope: Scope, runId: string) {
  requireAdmin(scope); return scoped(scope, async client => {
    const run = (await client.query('SELECT r.*,t.snapshot FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id WHERE r.id=$1 FOR UPDATE OF r', [runId])).rows[0];
    requireCondition(run, 'NOT_FOUND', '运行不存在', 404);
    const action = (await client.query('SELECT * FROM kff.actions WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
    requireCondition(['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'NEEDS_HUMAN'].includes(action.state), 'SUBMISSION_UNCERTAIN', '提交结果仍未知，不能解除隔离', 409);
    if (action.state === 'NEEDS_HUMAN') {
      const submitted = await client.query('SELECT id FROM kff.action_attempts WHERE action_id=$1 AND submitted_at IS NOT NULL', [action.id]);
      requireCondition(!submitted.rowCount, 'SUBMISSION_UNCERTAIN', '存在提交意图，必须先核实结果', 409);
    }
    const pending = await client.query("SELECT id FROM kff.agent_commands WHERE action_id=$1 AND (state NOT IN ('DONE','EXPIRED') OR quiesced_at IS NULL)", [action.id]);
    requireCondition(!pending.rowCount, 'GUARDIAN_UNCONFIRMED', '执行器尚未确认旧上下文关闭', 409);
    const snapshot = run.snapshot as TaskSnapshot;
    await client.query('UPDATE kff.resource_leases SET quarantined=false,holder_attempt_id=NULL,expires_at=now() WHERE holder_attempt_id IN (SELECT id FROM kff.action_attempts WHERE action_id=$1)', [action.id]);
    const other = await client.query("SELECT resource_id FROM kff.resource_leases WHERE resource_id=ANY($1::uuid[]) AND (quarantined OR holder_attempt_id IS NOT NULL)", [[snapshot.account_id, snapshot.environment_id]]);
    requireCondition(!other.rowCount, 'RESOURCE_BUSY', '资源已由其他运行占用，不能解除隔离', 409);
    await client.query("UPDATE kff.environments SET state='IDLE' WHERE id=$1 AND state='QUARANTINED'", [snapshot.environment_id]);
    await audit(client, scope, 'environment.quarantine_released', action.id, { environment_id: snapshot.environment_id }); return { released: true };
  });
}
