/**
 * Whether a template version may be enabled, and why not when it may not.
 *
 * `setTemplatePolicy` requires a preview with the same `manifest_hash` whose `can_enable` is true:
 * any such preview qualifies, not only the newest one, so a later failed preview must not hide an
 * earlier success. The server reports that readiness per version as `enable_ready`, computed over
 * every preview rather than the recent window the page receives. The rule is not "the account is
 * online" and not "all previews pass": run identity and authorisation stay execution-time checks.
 *
 * A deprecated version is permanent: it can never be enabled again, and the button must not pretend
 * otherwise. That is a real fifth state, not an over-strict condition.
 */
export type TemplateEnableState = 'DRAFT' | 'ALLOWED' | 'DISABLED' | 'DEPRECATED' | string;
export interface TemplateEnableEligibility { allowed: boolean; reason: string | null }

export function templateEnableEligibility(version: { state: TemplateEnableState; enable_ready?: boolean }): TemplateEnableEligibility {
  if (version.state === 'ALLOWED') return { allowed: false, reason: '此版本已允许使用。' };
  if (version.state === 'DEPRECATED') return { allowed: false, reason: '此版本已永久弃用，请从它派生新版本。' };
  if (!version.enable_ready) return { allowed: false, reason: '此版本还没有合格的预演：需要一次相同输入摘要、可以启用的预演通过后再允许。' };
  return { allowed: true, reason: null };
}
