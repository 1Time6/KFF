import type { PoolClient } from 'pg';
import { z } from 'zod';
import { scoped } from '@kff/database';
import { templateCapabilityKey, templateManifestSchema, templateVersionInput, templatePolicyInput, templatePreviewInput, type Scope, type TemplateVersion, type TemplatePreview, type TaskSnapshot } from '@kff/contracts';
import { digest, requireCondition } from './index';
import { audit, requireAdmin, requireWrite } from './service';
import { fixedPageManifest, assertTemplateSnapshot, validateTemplateInput } from '../../adapters/src/templates';

export async function ensureBundledTemplates(client: PoolClient, scope: Scope) {
  for (const key of templateCapabilityKey.options) {
    const manifest = fixedPageManifest(key); const name = (key.startsWith('kff.fixture.') ? '本地合成 · ' : 'Facebook · ') + (key.includes('.reply.')?'私信接待':key.includes('.publish.') ? '文本发布' : '身份读取');
    await client.query("INSERT INTO kff.template_versions(organization_id,brand_id,capability_key,version_number,version_label,name,manifest,manifest_hash,state,origin,created_by) VALUES($1,$2,$3,1,'v1',$4,$5,$6,'ALLOWED','bundled',$7) ON CONFLICT(organization_id,brand_id,capability_key,version_number) DO NOTHING", [scope.organization_id, scope.brand_id, key, name, manifest, digest(manifest), scope.user_id]);
  }
}
export async function chooseTemplateVersion(client: PoolClient, key: string, adapterVersion: string, versionId?: string) {
  const row = (await client.query<TemplateVersion>("SELECT * FROM kff.template_versions WHERE capability_key=$1 AND state='ALLOWED' AND ($2::uuid IS NULL OR id=$2) ORDER BY version_number DESC LIMIT 1 FOR SHARE", [key, versionId ?? null])).rows[0];
  requireCondition(row, 'TEMPLATE_UNAVAILABLE', '没有匹配的允许模板版本，请先核对模板状态', 409);
  const manifest = templateManifestSchema.parse(row.manifest);
  requireCondition(manifest.adapter_version === adapterVersion && manifest.capability_key === key && digest(manifest) === row.manifest_hash, 'VERSION_CONFLICT', '模板与当前执行器不匹配', 409);
  return { version_id: row.id, version_number: row.version_number, manifest_hash: row.manifest_hash, manifest };
}
export async function assertCurrentTemplate(client: PoolClient, taskId: string, snapshot: TaskSnapshot) {
  const chosen = assertTemplateSnapshot(snapshot);
  const row = (await client.query<TemplateVersion>('SELECT v.* FROM kff.template_versions v JOIN kff.tasks t ON t.organization_id=v.organization_id AND t.brand_id=v.brand_id WHERE t.id=$1 AND v.id=$2 FOR SHARE OF v', [taskId, chosen.version_id])).rows[0];
  requireCondition(row && row.capability_key === snapshot.capability_key && row.version_number === chosen.version_number && row.manifest_hash === chosen.manifest_hash && digest(row.manifest) === row.manifest_hash, 'VERSION_CONFLICT', '原模板版本与任务快照不匹配', 409);
  requireCondition(row.state === 'ALLOWED', 'TEMPLATE_UNAVAILABLE', '此模板版本已停用或弃用，禁止新动作', 409); return row;
}
async function priorEvent(client: PoolClient, id: string, hash: string) {
  const row = (await client.query('SELECT request_hash,details FROM kff.template_events WHERE id=$1', [id])).rows[0];
  if (row) requireCondition(row.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '同一模板请求已有不同内容', 409); return row;
}
export async function createTemplateVersion(scope: Scope, input: z.infer<typeof templateVersionInput>) {
  requireAdmin(scope); const value = templateVersionInput.parse(input); const hash = digest(value);
  return scoped(scope, async client => {
    const base = (await client.query<TemplateVersion>('SELECT * FROM kff.template_versions WHERE id=$1', [value.based_on_version_id])).rows[0];
    requireCondition(base, 'NOT_FOUND', '来源模板版本不存在', 404);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['template/' + scope.brand_id + '/' + base.capability_key]);
    const previous = await priorEvent(client, value.request_id, hash); if (previous) return previous.details.result as TemplateVersion;
    const manifest = fixedPageManifest(base.capability_key, value.max_body_length);
    const version = (await client.query('SELECT COALESCE(max(version_number),0)+1 AS number FROM kff.template_versions WHERE capability_key=$1', [base.capability_key])).rows[0].number;
    const row = (await client.query<TemplateVersion>("INSERT INTO kff.template_versions(organization_id,brand_id,capability_key,version_number,version_label,name,manifest,manifest_hash,origin,based_on_version_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'derived',$9,$10) RETURNING *", [scope.organization_id, scope.brand_id, base.capability_key, version, value.version_label, value.name, manifest, digest(manifest), base.id, scope.user_id])).rows[0];
    await client.query("INSERT INTO kff.template_events(id,organization_id,brand_id,template_version_id,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,'VERSION_CREATED',$5,$6,$7)", [value.request_id, scope.organization_id, scope.brand_id, row.id, scope.user_id, hash, { reason: value.reason, result: row }]);
    await audit(client, scope, 'template.version_created', row.id, { manifest_hash: row.manifest_hash, version_number: version }); return row;
  });
}
export async function previewTemplate(scope: Scope, versionId: string, input: z.infer<typeof templatePreviewInput>) {
  requireWrite(scope); const value = templatePreviewInput.parse(input); const hash = digest({ version_id: versionId, ...value });
  return scoped(scope, async client => {
    const row = (await client.query<TemplateVersion>('SELECT * FROM kff.template_versions WHERE id=$1 FOR SHARE', [versionId])).rows[0];
    requireCondition(row, 'NOT_FOUND', '模板版本不存在', 404);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['template-preview/' + value.request_id]);
    const previous = (await client.query<TemplatePreview & { request_hash: string }>('SELECT * FROM kff.template_previews WHERE id=$1', [value.request_id])).rows[0];
    if (previous) { requireCondition(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '此预演请求已有不同内容', 409); return previous; }
    const manifest = templateManifestSchema.parse(row.manifest); requireCondition(digest(manifest) === row.manifest_hash, 'VERSION_CONFLICT', '模板摘要不符', 409);
    const account = (await client.query('SELECT id,state,is_synthetic FROM kff.accounts WHERE id=$1', [value.account_id])).rows[0];
    const environment = (await client.query('SELECT id,account_id,agent_id,state FROM kff.environments WHERE id=$1', [value.environment_id])).rows[0];
    const capability = (await client.query('SELECT account_id,capability_key,adapter_version,is_synthetic,mode FROM kff.capabilities WHERE id=$1', [value.capability_id])).rows[0];
    requireCondition(account && environment && capability, 'FORBIDDEN_SCOPE', '预演对象必须属于当前品牌', 403);
    const agent = (await client.query("SELECT status,heartbeat_at>now()-interval '20 seconds' AS online FROM kff.agents WHERE id=$1", [environment.agent_id])).rows[0];
    const bindings = environment.account_id === account.id && capability.account_id === account.id && capability.capability_key === manifest.capability_key && capability.adapter_version === manifest.adapter_version && account.is_synthetic === capability.is_synthetic;
    let validInput = true; try { validateTemplateInput(manifest, value.body); } catch { validInput = false; }
    const checks: TemplatePreview['result']['checks'] = [
      { code: 'input', state: validInput ? 'PASS' : 'FAIL', message: validInput ? '输入满足此版本的长度与必填限制' : '输入不满足此版本的长度或必填限制' },
      { code: 'bindings', state: bindings ? 'PASS' : 'FAIL', message: bindings ? '账号、环境和动作关联一致' : '账号、环境和动作关联不一致' },
      { code: 'account_state', state: account.state === 'ACTIVE' ? 'PASS' : 'FAIL', message: account.state === 'ACTIVE' ? '账号档案当前标记为可连接' : '账号尚未建立可执行连接' },
      { code: 'executor', state: agent?.online && agent.status === 'ONLINE' && environment.state === 'IDLE' ? 'PASS' : 'FAIL', message: agent?.online && agent.status === 'ONLINE' && environment.state === 'IDLE' ? '当前执行端在线且环境空闲' : '当前执行端或环境暂不可用' },
      { code: 'platform_identity', state: 'NOT_CHECKED', message: '尚未连接平台核查实际身份、权限及页面状态' },
      { code: 'execution_authorization', state: 'NOT_CHECKED', message: '审核、试验许可、费用、停止和租约在实际执行前重新核对' },
    ];
    const result: TemplatePreview['result'] = { execution_authorized: false, external_calls: 0, checks };
    const preview = (await client.query<TemplatePreview>('INSERT INTO kff.template_previews(id,organization_id,brand_id,template_version_id,manifest_hash,account_id,environment_id,capability_id,request_hash,input_hash,can_enable,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [value.request_id, scope.organization_id, scope.brand_id, row.id, row.manifest_hash, account.id, environment.id, value.capability_id, hash, digest(value.body), validInput && bindings, result, scope.user_id])).rows[0];
    await audit(client, scope, 'template.previewed', row.id, { preview_id: preview.id, can_enable: preview.can_enable, external_calls: 0 }); return preview;
  });
}
export async function setTemplatePolicy(scope: Scope, versionId: string, input: z.infer<typeof templatePolicyInput>) {
  requireAdmin(scope); const value = templatePolicyInput.parse(input); const hash = digest({ version_id: versionId, ...value });
  return scoped(scope, async client => {
    const row = (await client.query<TemplateVersion>('SELECT * FROM kff.template_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    requireCondition(row, 'NOT_FOUND', '模板版本不存在', 404);
    const previous = await priorEvent(client, value.request_id, hash); if (previous) return previous.details.result as TemplateVersion;
    requireCondition(row.policy_version === value.expected_policy_version, 'VERSION_CONFLICT', '模板策略已变化，请刷新', 409);
    requireCondition(row.state !== 'DEPRECATED', 'TEMPLATE_DEPRECATED', '已弃用版本不能再次启用，请创建新版本', 409);
    if (value.action === 'ALLOW') {
      const preview = await client.query('SELECT id FROM kff.template_previews WHERE template_version_id=$1 AND manifest_hash=$2 AND can_enable LIMIT 1', [row.id, row.manifest_hash]);
      requireCondition(preview.rowCount, 'TEMPLATE_PREVIEW_REQUIRED', '请先完成此版本的输入和关联预演', 409);
    }
    const next = value.action === 'ALLOW' ? 'ALLOWED' : value.action === 'DISABLE' ? 'DISABLED' : 'DEPRECATED';
    const result = (await client.query<TemplateVersion>('UPDATE kff.template_versions SET state=$1,policy_version=policy_version+1 WHERE id=$2 RETURNING *', [next, row.id])).rows[0];
    await client.query("INSERT INTO kff.template_events(id,organization_id,brand_id,template_version_id,event_type,actor_id,request_hash,details) VALUES($1,$2,$3,$4,'POLICY_CHANGED',$5,$6,$7)", [value.request_id, scope.organization_id, scope.brand_id, row.id, scope.user_id, hash, { reason: value.reason, previous_state: row.state, result }]);
    await audit(client, scope, 'template.policy_changed', row.id, { previous_state: row.state, state: next, policy_version: result.policy_version }); return result;
  });
}
export async function templateWorkspace(scope: Scope) {
  return scoped(scope, async client => ({ versions: (await client.query<TemplateVersion>('SELECT * FROM (SELECT * FROM kff.template_versions ORDER BY created_at DESC,id LIMIT 200) recent ORDER BY capability_key,version_number DESC')).rows, previews: (await client.query<TemplatePreview>('SELECT id,template_version_id,manifest_hash,account_id,environment_id,capability_id,can_enable,result,created_at FROM kff.template_previews ORDER BY created_at DESC LIMIT 200')).rows }));
}
