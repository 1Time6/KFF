import { it, expect } from 'vitest';
import { templateEnableEligibility } from '../../apps/web/components/template-enable';

// The server rule this must mirror, copied from setTemplatePolicy as the comparator: enabling needs
// a preview with the same manifest_hash whose can_enable is true. Any such preview qualifies.
const serverAccepts = (state: string, qualifyingPreviewExists: boolean) => state !== 'ALLOWED' && state !== 'DEPRECATED' && qualifyingPreviewExists;

const version = (state: string, enable_ready?: boolean) => ({ state, ...(enable_ready === undefined ? {} : { enable_ready }) });

// A brand-new template has no preview at all, so the button must be refused with a reason instead of
// offering an action the server answers with TEMPLATE_PREVIEW_REQUIRED.
it('refuses to offer enabling a version with no qualifying preview', () => {
  const fresh = templateEnableEligibility(version('DRAFT', false));
  expect(fresh.allowed).toBe(false);
  expect(fresh.reason).toContain('预演');
  expect(serverAccepts('DRAFT', false)).toBe(false);
  // A missing flag is treated as "not ready" rather than as ready: an older payload must not make
  // the button permissive.
  expect(templateEnableEligibility(version('DRAFT')).allowed).toBe(false);
  // Once a qualifying preview exists, the same version may be enabled.
  expect(templateEnableEligibility(version('DRAFT', true))).toEqual({ allowed: true, reason: null });
});

// A version that was enabled once, then had a later failed preview, is still enableable when an
// earlier qualifying preview exists: the flag is computed over every preview, so the newest preview
// on the page must not be used to decide this.
it('does not let a later failed preview hide an earlier qualifying one', () => {
  // The page sees only the newest previews; here the newest is a failure and the qualifying one is
  // outside the returned window. The server flag still says ready.
  expect(templateEnableEligibility(version('DISABLED', true))).toEqual({ allowed: true, reason: null });
  expect(serverAccepts('DISABLED', true)).toBe(true);
  // And a version whose only preview failed is not offered.
  expect(templateEnableEligibility(version('DISABLED', false)).allowed).toBe(false);
});

it('never offers enabling a version that is already allowed or permanently deprecated', () => {
  const allowed = templateEnableEligibility(version('ALLOWED', true));
  expect(allowed.allowed).toBe(false);
  const deprecated = templateEnableEligibility(version('DEPRECATED', true));
  expect(deprecated.allowed).toBe(false);
  expect(deprecated.reason).toContain('弃用');
  // A deprecated version is refused even when a qualifying preview exists, which is the one case
  // where the preview rule alone would say yes.
  expect(serverAccepts('DEPRECATED', true)).toBe(false);
});

// The eligibility decision must agree with the server for every combination of state and readiness.
it('agrees with the server rule for every state', () => {
  for (const state of ['DRAFT', 'ALLOWED', 'DISABLED', 'DEPRECATED']) {
    for (const ready of [false, true]) {
      const eligibility = templateEnableEligibility(version(state, ready));
      expect(eligibility.allowed, state + '/' + ready).toBe(serverAccepts(state, ready));
      // A refusal always explains itself; an allowance carries no restriction.
      if (eligibility.allowed) expect(eligibility.reason).toBeNull();
      else expect(eligibility.reason).toBeTruthy();
    }
  }
});
