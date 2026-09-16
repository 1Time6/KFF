import { chromium, type BrowserContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { AgentCommand, ActionReport } from '@kff/contracts';
import { AppError, digest, isWrite, profilePath, requireCondition, validateTargetUrl } from '@kff/core';
import { assertTemplateSnapshot } from './templates';
import { openManagedBrowser } from './browser-profile';

export interface ExecutorHooks { beforeSubmit(): Promise<void>; assertControlled(): void; onContext(context: BrowserContext | null): void }
export async function executeFixture(command: AgentCommand, root: string, hooks: ExecutorHooks, fixtureOrigin = 'http://127.0.0.1:4311'): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  requireCondition(command.snapshot.is_synthetic && command.snapshot.mode === 'TEST_ONLY' && command.snapshot.adapter_version === 'fixture-page-v1', 'FORBIDDEN_SCOPE', '此执行器仅支持本项目的合成输入');
  requireCondition(digest(command.snapshot) === command.snapshot_hash, 'APPROVAL_STALE', '任务快照不一致');
  assertTemplateSnapshot(command.snapshot);
  const directory = profilePath(root, command.snapshot.profile_key); await mkdir(directory, { recursive: true });
  const managed = command.snapshot.browser_environment ? await openManagedBrowser(root, command.snapshot.browser_environment, true) : undefined;
  const context = managed?.context ?? await chromium.launchPersistentContext(directory, { headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'], viewport: { width: 1100, height: 760 } });
  hooks.onContext(context);
  let submitted = false;
  let step = 'prepare';
  let scene = { identity_count: 0, submit_controls: 0, result_count: 0 };
  const diagnostic = (atStep: string) => ({ step: atStep, scene, browser_version: context.browser()?.version() });
  try {
    await context.route('**/*', route => { try { validateTargetUrl(route.request().url(), [], fixtureOrigin); return route.continue(); } catch { return route.abort('blockedbyclient'); } });
    const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10000);
    const url = new URL('/page', fixtureOrigin);
    url.searchParams.set('account', command.snapshot.external_account_id); url.searchParams.set('action', command.action_id); url.searchParams.set('scenario', command.snapshot.fixture_scenario);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' }); step = 'identity';
    scene = { identity_count: await page.getByTestId('account-identity').count(), submit_controls: await page.getByTestId('publish').count(), result_count: 0 };
    requireCondition(scene.identity_count === 1, 'AUTH_EXPIRED', '当前页面缺少已登录账号');
    const identity = (await page.getByTestId('account-identity').innerText()).trim();
    requireCondition(identity === command.snapshot.external_account_id, 'ACCOUNT_MISMATCH', '当前账号与任务指定账号不一致');
    hooks.assertControlled();
    if (!isWrite(command.snapshot)) return { outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: identity, actual_account_id: identity, evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: diagnostic('read-verified') };
    requireCondition(scene.submit_controls === 1, 'NEEDS_HUMAN', '发布入口不唯一，已停止自动操作');
    await page.getByRole('textbox', { name: '发布内容' }).fill(command.snapshot.body); step = 'prepared';
    if (command.snapshot.fixture_scenario === 'slow') await page.waitForTimeout(8000);
    hooks.assertControlled();
    await hooks.beforeSubmit(); submitted = true; step = 'submitted';
    // Only this guarded boundary may cause a synthetic write.
    await page.getByTestId('publish').click();
    await page.getByTestId('published-post').waitFor({ state: 'visible' });
    if (command.snapshot.fixture_scenario === 'lost_after_submit') throw new AppError('SUBMISSION_UNCERTAIN', '合成场景：提交成功后回执丢失');
    const post = page.getByTestId('published-post'); scene.result_count = await post.count();
    requireCondition(scene.result_count === 1, 'SUBMISSION_UNCERTAIN', '结果不唯一，待核实');
    const body = await post.textContent() ?? ''; const remoteId = await post.getAttribute('data-remote-id'); const actualAccount = await post.getAttribute('data-account-id');
    requireCondition(remoteId && actualAccount === identity && digest(body) === command.snapshot.content_hash, 'SUBMISSION_UNCERTAIN', '结果证据与任务不一致');
    return { outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: remoteId, actual_account_id: identity, content_hash: digest(body), evidence_kind: 'synthetic_dom', observed_at: new Date().toISOString() }, diagnostic: diagnostic('write-verified') };
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'EXECUTOR_ERROR';
    return { outcome: submitted ? 'UNKNOWN_OUTCOME' : code === 'STOP_REQUESTED' ? 'CANCELED' : code === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN' : 'BLOCKED', error_code: code, diagnostic: diagnostic(step) };
  } finally { if (managed) await managed.close(); else await context.close(); hooks.onContext(null); }
}
