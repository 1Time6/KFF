import type { Page } from '@playwright/test';

/**
 * Serialises a callback for `page.evaluate` with the transpiler's `keepNames` helper defined inside
 * the page. tsx/esbuild injects `__name(...)` calls into functions to preserve their names, and that
 * helper exists only in the Node module - the browser page has no such binding - so a callback that
 * contains an arrow function or a named inner function throws `ReferenceError: __name is not defined`
 * at runtime. Defining the helper in the page keeps the callback source unchanged and is harmless
 * when no `__name` calls were injected.
 */
export function pageCallbackExpression(fn: (...args: never[]) => unknown, ...callArgs: unknown[]): string {
  const call = callArgs.length ? '(' + callArgs.map(value => JSON.stringify(value)).join(',') + ')' : '()';
  return `(() => { const __name = (target) => target; return (${fn.toString()})${call}; })()`;
}

export function evaluateWithNameShim<R>(page: Page, fn: () => R): Promise<R>;
export function evaluateWithNameShim<A, R>(page: Page, fn: (arg: A) => R, arg: A): Promise<R>;
export async function evaluateWithNameShim(page: Page, fn: (...args: never[]) => unknown, ...callArgs: unknown[]): Promise<unknown> {
  return await page.evaluate(pageCallbackExpression(fn, ...callArgs));
}
