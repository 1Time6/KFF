import { z } from 'zod';

export const templateCapabilityKey = z.enum(['kff.fixture.page.read.browser', 'kff.fixture.page.publish.browser', 'facebook.page.read.api', 'facebook.page.publish.api']);
const steps = z.enum(['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original']);
export const templateManifestSchema = z.object({
  schema_version: z.literal('kff.template.v1'), engine: z.literal('fixed-page-v1'), capability_key: templateCapabilityKey,
  adapter_version: z.enum(['fixture-page-v1', 'facebook-graph-v1']),
  input: z.object({ body_required: z.boolean(), max_body_length: z.number().int().min(1).max(5000) }).strict(),
  steps: z.array(steps).min(2).max(5), permission_gate: z.literal('common_execution_gate'),
  success_evidence: z.enum(['page_identity', 'published_object_identity_author_content']), automatic_write_retry: z.literal(false),
}).strict().superRefine((value, context) => {
  const write = value.capability_key.includes('.publish.'); const synthetic = value.capability_key.startsWith('kff.fixture.');
  const expectedSteps = write ? ['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original'] : ['validate_input', 'verify_identity'];
  if (value.adapter_version !== (synthetic ? 'fixture-page-v1' : 'facebook-graph-v1') || value.input.body_required !== write || value.success_evidence !== (write ? 'published_object_identity_author_content' : 'page_identity') || JSON.stringify(value.steps) !== JSON.stringify(expectedSteps)) context.addIssue({ code: 'custom', message: '模板定义与已安装的固定动作不匹配' });
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
}
export interface TemplatePreview {
  id: string; template_version_id: string; manifest_hash: string; account_id: string; environment_id: string; capability_id: string;
  can_enable: boolean; created_at: string;
  result: { execution_authorized: false; external_calls: 0; checks: { code: string; state: 'PASS' | 'FAIL' | 'NOT_CHECKED'; message: string }[] };
}
