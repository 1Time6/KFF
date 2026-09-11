import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3000' ? route.continue() : route.abort());
  await page.goto('/tasks');
  const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
  await page.getByLabel('密码', { exact: true }).fill(config.operator_password);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: '任务工作台', exact: true })).toBeVisible();
  const workspace = await (await page.request.get('/api/workspace')).json();
  expect(workspace.live_enabled).toBe(false);
});
async function createAndRun(page: Page, scenario: string) {
  const title = 'E1 浏览器测试 ' + scenario + ' ' + randomUUID().slice(0, 8);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  await dialog.getByLabel('任务名称', { exact: true }).fill(title);
  await dialog.getByLabel('发布内容', { exact: false }).fill('合成内容\n此测试不向 Facebook 发送内容。');
  await dialog.getByText('本地故障验证场景', { exact: true }).click();
  await dialog.getByLabel('场景', { exact: true }).selectOption(scenario);
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await row.getByRole('button', { name: '审核', exact: true }).click();
  await page.getByRole('dialog', { name: '核对任务', exact: true }).getByRole('button', { name: '审核通过', exact: true }).click();
  await row.getByRole('button', { name: '执行', exact: true }).click();
  return { title, row };
}
test('creates, approves and verifies one durable local publication', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { title, row } = await createAndRun(page, 'normal');
  await expect(row.getByText('核实成功', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('link', { name: '运行记录', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: '运行详情', exact: true });
  await expect(detail.getByText('已取得结果证据', { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await detail.getByRole('button', { name: '下载', exact: true }).click();
  const download = await downloadEvent; expect(download.suggestedFilename()).toMatch(/^kff-diagnostic-/);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'output/playwright/e1-verified-detail.png', fullPage: true });
});
test('records a wrong-account failure with a diagnostic and no publication', async ({ page }) => {
  const { title, row } = await createAndRun(page, 'wrong_account');
  await expect(row.getByText('执行失败', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('link', { name: '运行记录', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: '运行详情', exact: true });
  await expect(detail.getByText('ACCOUNT_MISMATCH', { exact: true })).toBeVisible();
  await expect(detail.getByText('D1 · 脱敏诊断包', { exact: true })).toBeVisible();
  await expect(detail.getByText('已记录提交意图', { exact: true })).toHaveCount(0);
});
test('stops preparation before a publication and displays cancellation', async ({ page }) => {
  const { title } = await createAndRun(page, 'slow');
  await page.getByRole('link', { name: '运行记录', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await expect(row.getByText('准备中', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: '停止', exact: true }).click();
  await expect(row.getByText('已取消', { exact: true })).toBeVisible({ timeout: 30000 });
});
test('reconciles an unknown publication and then releases the quarantined environment', async ({ page }) => {
  const { title, row } = await createAndRun(page, 'lost_after_submit');
  await expect(row.getByText('需人工处理', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('link', { name: '运行记录', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: '运行详情', exact: true });
  await expect(detail.getByText('结果未知', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '核验原提交', exact: true }).click();
  await expect(detail.getByText('核实成功', { exact: true }).first()).toBeVisible();
  await detail.getByRole('button', { name: '解除环境隔离', exact: true }).click();
  await expect(page.getByRole('status').getByText('已解除隔离', { exact: true })).toBeVisible();
  await expect(detail.getByText('执行尝试 1', { exact: true })).toBeVisible();
  await expect(detail.getByText('执行尝试 2', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/e1-reconciled-detail.png', fullPage: true });
});
test('all six workspace pages stay usable at desktop and narrow widths', async ({ page }) => {
  for (const [section, title] of [['overview', '执行总览'], ['accounts', '账号中心'], ['environments', '环境中心'], ['tasks', '任务工作台'], ['runs', '运行记录'], ['capabilities', '能力与验证']]) {
    await page.goto('/' + section); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('Internal Server Error');
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/tasks');
  await expect(page.getByRole('button', { name: '创建任务', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/workbench-mobile.png', fullPage: true });
});
