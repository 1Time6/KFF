import { templateCapabilityKey, templateManifestSchema, templateSnapshotSchema, type TemplateManifest, type TaskSnapshot } from '@kff/contracts';
import { digest, requireCondition } from '@kff/core';

export function fixedPageManifest(key: string, maxBodyLength = 5000): TemplateManifest {
  const capability = templateCapabilityKey.parse(key),message=key.includes('.messenger.'),synthetic=key.startsWith('kff.fixture.'); const write = capability.includes('.publish.')||message;
  return templateManifestSchema.parse({ schema_version: 'kff.template.v1', engine: message?'fixed-message-v1':'fixed-page-v1', capability_key: capability, adapter_version: message?(synthetic?'fixture-messenger-v1':'facebook-messenger-v1'):synthetic ? 'fixture-page-v1' : 'facebook-graph-v1', input: { body_required: write, max_body_length: message?Math.min(maxBodyLength,2000):maxBodyLength }, steps: write ? ['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original'] : ['validate_input', 'verify_identity'], permission_gate: 'common_execution_gate', success_evidence: message?'message_acceptance':write ? 'published_object_identity_author_content' : 'page_identity', automatic_write_retry: false });
}
export function validateTemplateInput(manifest: TemplateManifest, body: string) {
  templateManifestSchema.parse(manifest);
  requireCondition(body.length <= manifest.input.max_body_length && (!manifest.input.body_required || body.trim().length > 0), 'TEMPLATE_INPUT_INVALID', '内容不满足所选模板的输入限制', 409);
}
export function assertTemplateSnapshot(snapshot: TaskSnapshot) {
  requireCondition(snapshot.template, 'TEMPLATE_SNAPSHOT_REQUIRED', '历史任务缺少模板版本快照，不能启动新的执行', 409);
  const template = templateSnapshotSchema.parse(snapshot.template);
  requireCondition(digest(template.manifest) === template.manifest_hash && template.manifest.capability_key === snapshot.capability_key && template.manifest.adapter_version === snapshot.adapter_version, 'VERSION_CONFLICT', '模板摘要、动作或执行器版本不一致', 409);
  validateTemplateInput(template.manifest, snapshot.body); return template;
}
