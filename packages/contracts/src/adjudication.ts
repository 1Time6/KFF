import { z } from 'zod';

export const adjudicationInput = z.object({
  request_id: z.string().uuid(), snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  expected_version: z.number().int().min(0), expected_state: z.enum(['UNKNOWN_OUTCOME', 'NEEDS_HUMAN']),
  decision: z.enum(['CONFIRMED_SUCCESS', 'CONFIRMED_FAILURE', 'INCONCLUSIVE']),
  evidence: z.object({
    source: z.enum(['platform_ui', 'platform_support', 'owned_fixture']),
    external_account_id: z.string().regex(/^[0-9]{1,128}$/), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    parent_id:z.string().regex(/^[0-9]{1,80}$/).optional(),
    source_url:z.string().max(500).optional(),
    recipient_id:z.string().regex(/^[0-9]{1,128}$/).optional(),
    thread_id:z.string().regex(/^[A-Za-z0-9_:+.@-]{1,160}$/).optional(),
    remote_id: z.string().regex(/^[A-Za-z0-9_:.=@$+/-]{1,200}$/).nullable(),
    observed_at: z.string().datetime(), reference: z.string().trim().min(1).max(300),
    failure_basis: z.enum(['FINAL_PLATFORM_REJECTION', 'FINAL_PLATFORM_CANCELLATION']).nullable(),
    matched_original_submission: z.boolean(),
  }).strict(),
  reason: z.string().trim().min(10).max(1500), confirmation: z.literal('I_REVIEWED_THIS_ORIGINAL_ACTION'),
}).strict().superRefine((value, context) => {
  const e = value.evidence;
  if (value.decision === 'CONFIRMED_SUCCESS' && (!e.remote_id || e.failure_basis !== null || !e.matched_original_submission)) context.addIssue({ code: 'custom', message: '确认成功需要匹配原提交的远端对象证据', path: ['evidence'] });
  if (value.decision === 'CONFIRMED_FAILURE' && (!e.failure_basis || !e.matched_original_submission)) context.addIssue({ code: 'custom', message: '确认失败需要原提交的最终拒绝或取消依据，未查到记录不能作为失败', path: ['evidence'] });
  if (value.decision === 'INCONCLUSIVE' && (e.failure_basis !== null || e.matched_original_submission)) context.addIssue({ code: 'custom', message: '证据不足时不得声明已经匹配最终结果', path: ['evidence'] });
});

export interface AdjudicationRecord {
  id: string; action_id: string; reviewer_id: string; expected_version: number; result_version: number;
  previous_state: 'UNKNOWN_OUTCOME' | 'NEEDS_HUMAN'; result_state: 'VERIFIED_SUCCEEDED' | 'VERIFIED_FAILED' | 'NEEDS_HUMAN';
  decision: z.infer<typeof adjudicationInput>['decision']; snapshot_hash: string;
  evidence: z.infer<typeof adjudicationInput>['evidence']; reason: string; created_at: string;
}
