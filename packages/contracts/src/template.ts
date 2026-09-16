import { z } from 'zod';

export const templateCapabilityKey = z.enum(['facebook.comment.reply.browser','facebook.messenger.reply.browser','facebook.inbox.read.browser','facebook.discovery.read.browser','kff.fixture.messenger.reply.browser','kff.fixture.inbox.read.browser', 'kff.fixture.discovery.read.browser', 'kff.fixture.page.read.browser', 'kff.fixture.page.publish.browser', 'facebook.page.read.api', 'facebook.page.publish.api','kff.fixture.messenger.reply.api','facebook.messenger.reply.api','kff.fixture.social.reply.api','social.comment.reply.api','instagram.account.read.api']);
const steps = z.enum(['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original', 'read_page']);
export const templateManifestSchema = z.object({
  schema_version: z.literal('kff.template.v1'), engine: z.enum(['fixed-browser-comment-v1','fixed-browser-message-v1','fixed-inbox-v1','fixed-discovery-v1','fixed-page-v1','fixed-message-v1','fixed-social-v1']), capability_key: templateCapabilityKey,
  adapter_version: z.enum(['facebook-browser-comment-v1','facebook-browser-messenger-v1','facebook-inbox-browser-v1','facebook-search-browser-v1','fixture-browser-messenger-v1','browser-inbox-v1','browser-discovery-v1','fixture-page-v1', 'facebook-graph-v1','fixture-messenger-v1','facebook-messenger-v1','social-outreach-v1','instagram-graph-v1']),
  input: z.object({ body_required: z.boolean(), max_body_length: z.number().int().min(1).max(5000) }).strict(),
  steps: z.array(steps).min(2).max(5), permission_gate: z.literal('common_execution_gate'),
  success_evidence: z.enum(['inbox_page','collection_page','page_identity', 'published_object_identity_author_content','message_acceptance']), automatic_write_retry: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.capability_key === 'facebook.comment.reply.browser') {
    if (value.engine !== 'fixed-browser-comment-v1' || value.adapter_version !== 'facebook-browser-comment-v1' || !value.input.body_required || value.success_evidence !== 'message_acceptance' || JSON.stringify(value.steps) !== JSON.stringify(['validate_input','verify_identity','prepare_content','submit_once','verify_original'])) context.addIssue({code:'custom',message:'公开评论只允许固定对象的一次提交和原回复核验'});
    return;
  }
  if (['kff.fixture.inbox.read.browser','facebook.inbox.read.browser'].includes(value.capability_key)) {
    if (value.engine !== 'fixed-inbox-v1' || value.adapter_version !== (value.capability_key === 'facebook.inbox.read.browser' ? 'facebook-inbox-browser-v1' : 'browser-inbox-v1') || value.input.body_required || value.success_evidence !== 'inbox_page' || JSON.stringify(value.steps) !== JSON.stringify(['validate_input','verify_identity','read_page'])) context.addIssue({ code: 'custom', message: '收件模板只能核对身份并读取一页' });
    return;
  }
  if (['kff.fixture.messenger.reply.browser','facebook.messenger.reply.browser'].includes(value.capability_key)) {
    if (value.engine !== 'fixed-browser-message-v1' || value.adapter_version !== (value.capability_key === 'facebook.messenger.reply.browser' ? 'facebook-browser-messenger-v1' : 'fixture-browser-messenger-v1') || !value.input.body_required || value.success_evidence !== 'message_acceptance' || JSON.stringify(value.steps) !== JSON.stringify(['validate_input','verify_identity','prepare_content','submit_once','verify_original'])) context.addIssue({ code: 'custom', message: '浏览器回复只允许一次受控提交及原消息回读' });
    return;
  }
  const discovery = ['kff.fixture.discovery.read.browser','facebook.discovery.read.browser'].includes(value.capability_key);
  if (discovery) {
    if (value.engine !== 'fixed-discovery-v1' || value.adapter_version !== (value.capability_key === 'facebook.discovery.read.browser' ? 'facebook-search-browser-v1' : 'browser-discovery-v1') || value.input.body_required || value.success_evidence !== 'collection_page' || JSON.stringify(value.steps) !== JSON.stringify(['validate_input','verify_identity','read_page'])) context.addIssue({ code: 'custom', message: '采集模板只能核对身份并读取一页' });
    return;
  }
  const social=value.capability_key.includes('.social.')||value.capability_key==='social.comment.reply.api';const message=value.capability_key.includes('.messenger.')||social;const write = value.capability_key.includes('.publish.')||message; const synthetic = value.capability_key.startsWith('kff.fixture.');
  const expectedSteps = write ? ['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original'] : ['validate_input', 'verify_identity'];
  if (value.engine!==(social?'fixed-social-v1':message?'fixed-message-v1':'fixed-page-v1')||value.adapter_version !== (social?'social-outreach-v1':message?(synthetic?'fixture-messenger-v1':'facebook-messenger-v1'):(synthetic ? 'fixture-page-v1' : value.capability_key==='instagram.account.read.api'?'instagram-graph-v1':'facebook-graph-v1')) || value.input.body_required !== write || value.success_evidence !== (message?'message_acceptance':write ? 'published_object_identity_author_content' : 'page_identity') || JSON.stringify(value.steps) !== JSON.stringify(expectedSteps)) context.addIssue({ code: 'custom', message: '模板定义与已安装的固定动作不匹配' });
});
export type TemplateManifest = z.infer<typeof templateManifestSchema>;
export const templateSnapshotSchema = z.object({ version_id: z.string().uuid(), version_number: z.number().int().positive(), manifest_hash: z.string().regex(/^[a-f0-9]{64}$/), manifest: templateManifestSchema }).strict();
export const templateVersionInput = z.object({ request_id: z.string().uuid(), based_on_version_id: z.string().uuid(), name: z.string().trim().min(1).max(100), version_label: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/), max_body_length: z.number().int().min(1).max(5000), reason: z.string().trim().min(5).max(300) }).strict();
export const templatePolicyInput = z.object({ request_id: z.string().uuid(), expected_policy_version: z.number().int().positive(), action: z.enum(['ALLOW', 'DISABLE', 'DEPRECATE']), reason: z.string().trim().min(5).max(300) }).strict();
export const templatePreviewInput = z.object({ request_id: z.string().uuid(), account_id: z.string().uuid(), environment_id: z.string().uuid(), capability_id: z.string().uuid(), body: z.string().trim().max(5000).default('') }).strict();
export interface TemplateVersion {
  id: string; capability_key: z.infer<typeof templateCapabilityKey>; version_number: number; version_label: string; name: string;
  manifest: TemplateManifest; manifest_hash: string; state: 'DRAFT' | 'ALLOWED' | 'DISABLED' | 'DEPRECATED';
  policy_version: number; origin: 'bundled' | 'derived'; based_on_version_id: string | null; created_at: string;
  /** True when at least one preview with this version's manifest hash can enable it. The server
   *  computes this over every preview, not the recent window the workspace returns. */
  enable_ready?: boolean;
}
export interface TemplatePreview {
  id: string; template_version_id: string; manifest_hash: string; account_id: string; environment_id: string; capability_id: string;
  can_enable: boolean; created_at: string;
  result: { execution_authorized: false; external_calls: 0; checks: { code: string; state: 'PASS' | 'FAIL' | 'NOT_CHECKED'; message: string }[] };
}
