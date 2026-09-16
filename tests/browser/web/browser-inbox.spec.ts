import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closePool } from '../../../packages/database/src/index';
import { leadScope } from '../../helpers/lead-fixture';
import { browserInboxSetup, browserInboxSample, ingestBrowserBatch } from '../../helpers/browser-inbox';

test('the existing Inbox displays synthetic browser observations and keeps API sending unavailable', async ({ page }) => {
  const fixture = await browserInboxSetup(leadScope), batch = browserInboxSample(fixture.binding);
  batch.messages[0].body = '浏览器收件入库验证：客户询问服务内容';
  batch.messages[0].display_name = '浏览器消息合同验证';
  const result = await ingestBrowserBatch(leadScope, fixture.binding, batch); await closePool();
  const origin = 'http://127.0.0.1:3000', errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto('/inbox');
  const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
  await page.getByLabel('密码', { exact: true }).fill(config.operator_password);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: '客户收件箱', exact: true })).toBeVisible();
  await page.goto('/inbox?conversation=' + result.events[0].conversation_id);
  const panel = page.getByRole('region', { name: '会话详情' });
  await expect(panel.getByRole('list', { name: '已保存的客户消息' })).toContainText(batch.messages[0].body);
  await expect(panel).toContainText('浏览器会话目前支持查看和跟进，请在原会话回复。');
  await expect(page.getByRole('form', { name: '人工回复' })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: '客户档案 →' })).toBeVisible();
  await panel.screenshot({ path: 'output/playwright/browser-inbox-contract.png' });
  await page.reload(); await expect(panel).toContainText(batch.messages[0].body);
  expect(errors).toEqual([]);
});
