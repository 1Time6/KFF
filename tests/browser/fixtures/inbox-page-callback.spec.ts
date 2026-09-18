import { test, expect } from '@playwright/test';
import { pageCallbackExpression } from '../../../packages/adapters/src/page-evaluate';

/**
 * The packaged Agent runs its adapters through tsx, whose esbuild step injects `__name(...)` calls to
 * preserve function names. Playwright serialises `page.evaluate` callbacks into the page, where that
 * helper does not exist, so a callback containing an arrow function fails with
 * `ReferenceError: __name is not defined` - the exact failure the real inbox directory read reported.
 * The callback below is the shape esbuild emits; the shim must make it runnable inside a real page.
 */
test('runs a keepNames-shaped page callback inside a real page', async ({ page }) => {
  const source = 'function probe(value) { const double = __name((x) => x * 2, "double"); const items = [1, 2].filter((x) => x > 1); return { doubled: double(value.n), count: items.length }; }';
  const probe = new Function('return (' + source + ')')() as (value: { n: number }) => { doubled: number; count: number };
  const raw = await page.evaluate(`(() => (${probe.toString()})({ n: 21 }))()`).catch(error => String(error));
  expect(raw).toContain('__name is not defined');
  const shimmed = await page.evaluate(pageCallbackExpression(probe, { n: 21 }));
  expect(shimmed).toEqual({ doubled: 42, count: 1 });
});
