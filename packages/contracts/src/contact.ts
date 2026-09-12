import { z } from 'zod';

const uuid = z.string().uuid();
export const contactChannel = z.enum(['synthetic','facebook_messenger','facebook_comment','facebook_interaction','site_chat']);
export const contactPurpose = z.enum(['customer_service','marketing']);
export const contactTargetInput = z.object({ account_id: uuid, channel: contactChannel, remote_id: z.string().regex(/^[A-Za-z0-9_:+.@-]{1,160}$/) }).strict();
export const contactPolicy = z.object({
  basis_type: z.enum(['inbound_inquiry','explicit_consent']), purpose: contactPurpose,
  source_type: z.enum(['owned_endpoint','platform_event','manual_record']), source_ref: z.string().trim().min(1).max(300),
  source_observed_at: z.string().datetime(), source_use_status: z.enum(['CONFIRMED','UNKNOWN','DENIED']),
  starts_at: z.string().datetime(), expires_at: z.string().datetime(), policy_ref: z.string().trim().min(1).max(160),
  window_rule: z.enum(['EXPLICIT_END','NOT_REQUIRED','UNKNOWN']), window_expires_at: z.string().datetime().nullable(),
  evidence_note: z.string().trim().min(10).max(1000),
}).strict().refine(value => Date.parse(value.starts_at) < Date.parse(value.expires_at), '联系依据有效期无效')
  .refine(value => value.window_rule === 'EXPLICIT_END' ? value.window_expires_at !== null : value.window_expires_at === null, '窗口规则与到期时间不一致')
  .refine(value => value.basis_type !== 'inbound_inquiry' || (value.purpose === 'customer_service' && value.window_rule === 'EXPLICIT_END'), '主动咨询依据只能用于明确窗口内的客户服务');
export const contactPermissionInput = z.object({ target_id: uuid, request_id: uuid, resume_opt_out: z.boolean().default(false), policy: contactPolicy }).strict();
export const contactExitInput = z.object({ request_id: uuid, expected_version: z.number().int().positive(), reason: z.string().trim().min(1).max(300) }).strict();
export const contactReviewInput = z.object({ target_id: uuid, permission_id: uuid, purpose: contactPurpose }).strict();
export const contactSelectionSchema = contactReviewInput.extend({ account_id: uuid, channel: contactChannel, remote_id: z.string(), target_version: z.number().int().positive(), policy_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ContactSelection = z.infer<typeof contactSelectionSchema>;
