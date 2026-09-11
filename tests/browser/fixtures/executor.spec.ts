import { test, expect } from '@playwright/test';
import path from 'node:path';
import { executeFixture, type ExecutorHooks } from '../../../packages/adapters/src/fixture';
import { fixtureCommand } from '../../helpers/commands';
import { AppError } from '../../../packages/core/src/index';

const root = path.resolve('.kff/fixture-test-profiles');
function hooks(): ExecutorHooks & { submits: number } { return { submits: 0, async beforeSubmit() { this.submits++; }, assertControlled() {}, onContext() {} }; }
test('reads the intended identity without a write', async () => {
  const command = fixtureCommand({ capability_key: 'kff.fixture.page.read.browser' }); const control = hooks();
  const report = await executeFixture(command, root, control);
  expect(report.outcome).toBe('VERIFIED_SUCCEEDED'); expect(control.submits).toBe(0);
  expect(report.receipt?.actual_account_id).toBe(command.snapshot.external_account_id);
});
test('publishes multiline content and verifies one durable object', async ({ request }) => {
  const command = fixtureCommand(); const control = hooks();
  const report = await executeFixture(command, root, control);
  expect(report.outcome).toBe('VERIFIED_SUCCEEDED'); expect(control.submits).toBe(1);
  const posts = await (await request.get('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json();
  expect(posts).toHaveLength(1); expect(posts[0].body).toBe(command.snapshot.body); expect(posts[0].content_hash).toBe(report.receipt?.content_hash);
});
for (const [scenario, code] of [['login_expired', 'AUTH_EXPIRED'], ['wrong_account', 'ACCOUNT_MISMATCH'], ['duplicate_control', 'NEEDS_HUMAN']] as const) {
  test('blocks before submission for ' + scenario, async ({ request }) => {
    const command = fixtureCommand({ fixture_scenario: scenario }); const control = hooks();
    const report = await executeFixture(command, root, control);
    expect(report.error_code).toBe(code); expect(control.submits).toBe(0);
    expect(await (await request.get('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json()).toHaveLength(0);
    expect(report.diagnostic.scene).toBeDefined();
  });
}
test('retains unknown when the local receipt is lost after remote acceptance', async ({ request }) => {
  const command = fixtureCommand({ fixture_scenario: 'lost_after_submit' }); const control = hooks();
  const report = await executeFixture(command, root, control);
  expect(report.outcome).toBe('UNKNOWN_OUTCOME'); expect(control.submits).toBe(1);
  expect(await (await request.get('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json()).toHaveLength(1);
});
test('stops before the side effect when the guardian rejects control', async ({ request }) => {
  const command = fixtureCommand(); const control = hooks(); control.assertControlled = () => { throw new AppError('STOP_REQUESTED', 'Synthetic stop'); };
  expect((await executeFixture(command, root, control)).outcome).toBe('CANCELED'); expect(control.submits).toBe(0);
  expect(await (await request.get('http://127.0.0.1:4311/posts?action_id=' + command.action_id)).json()).toHaveLength(0);
});
test('isolates persistent browser storage', async () => {
  const first = fixtureCommand({ capability_key: 'kff.fixture.page.read.browser' });
  await executeFixture(first, root, hooks());
  const { chromium } = await import('@playwright/test');
  const context = await chromium.launchPersistentContext(path.join(root, first.snapshot.profile_key), { headless: true });
  await context.addCookies([{ name: 'synthetic_identity', value: 'profile-one-only', url: 'http://127.0.0.1:4311' }]); await context.close();
  const second = fixtureCommand({ capability_key: 'kff.fixture.page.read.browser' });
  const secondContext = await chromium.launchPersistentContext(path.join(root, second.snapshot.profile_key), { headless: true });
  expect(await secondContext.cookies()).toEqual([]); await secondContext.close();
});
test('blocks unmatched requests before network access', async () => {
  let blocked = false; let context: import('@playwright/test').BrowserContext | null = null;
  const controls = hooks();
  controls.onContext = value => { context = value; value?.on('requestfailed', request => { if (request.url().includes('example.invalid')) blocked = true; }); };
  controls.beforeSubmit = async () => {
    await context!.pages()[0].evaluate(async () => { try { await fetch('https://example.invalid/unmatched-fixture-request'); } catch { /* Expected route rejection. */ } });
  };
  await executeFixture(fixtureCommand(), root, controls);
  expect(blocked).toBe(true);
});
