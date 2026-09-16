import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.describe.configure({ mode: 'serial' });

// NOTE: the `web` project drives the running server on 127.0.0.1:3000, which this workspace starts
// as `next start` (a production build) rather than `next dev`. These assertions therefore describe
// the *served* bundle, not the working tree: they stay red until `next build apps/web` is run and
// the local runtime is restarted. The pure rules they cover are unit-tested directly in
// tests/contracts/environment-accounts.test.ts, contact-channel.test.ts and
// reception-transport.test.ts, which exercise the real modules without a server.

const operator = () => JSON.parse(readFileSync('.kff/local-config.json', 'utf8')).operator_password;
async function signIn(page: import('@playwright/test').Page, path: string) {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3000' ? route.continue() : route.abort());
  await page.goto(path);
  await page.getByLabel('密码', { exact: true }).fill(operator());
  await page.getByRole('button', { name: '进入工作台' }).click();
}

// A site account has no browser identity, so the browser-environment entry must not offer it: the
// old form listed every account, and the operator only met the refusal when the environment check
// tried to build a browser snapshot it cannot support.
test('the browser environment entry withholds accounts it cannot check', async ({ page }) => {
  await signIn(page, '/environments');
  await expect(page.getByRole('heading', { name: '环境中心', exact: true })).toBeVisible();
  const workspace = await (await page.request.get('/api/workspace')).json();
  const offered = workspace.accounts.filter((account: { platform: string }) => ['facebook', 'instagram', 'kff'].includes(account.platform));
  const withheld = workspace.accounts.filter((account: { platform: string }) => !['facebook', 'instagram', 'kff'].includes(account.platform));
  // The local database does contain site accounts, so this comparison is meaningful.
  expect(withheld.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: '创建环境', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建独立环境', exact: true });
  await expect(dialog.getByLabel('绑定账号', { exact: true })).toHaveCount(1);
  const values = await dialog.getByLabel('绑定账号', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean));
  // The entry offers exactly the accounts a browser snapshot can be built for, in server order.
  expect(values).toEqual(offered.map((account: { id: string }) => account.id));
  // The omission is explained rather than silent.
  await expect(dialog.getByText('站内渠道账号没有浏览器身份', { exact: false })).toBeVisible();
});

// The contact target form derived its channel from "is_synthetic", so every real account was
// submitted as a Facebook target. The channel is now shown and comes from the account itself.
test('the contact target form states the channel it will submit', async ({ page }) => {
  await signIn(page, '/accounts');
  await expect(page.getByRole('heading', { name: '账号中心', exact: true })).toBeVisible();
  const workspace = await (await page.request.get('/api/workspace')).json();
  const synthetic = workspace.accounts.find((account: { is_synthetic: boolean; platform: string }) => account.is_synthetic && account.platform === 'kff');
  expect(synthetic).toBeTruthy();
  await page.getByLabel('联系依据所属账号', { exact: true }).selectOption(synthetic.id);
  await page.getByRole('button', { name: '管理联系依据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '联系依据与退出', exact: true });
  // The channel is derived, visible, and read-only: the operator cannot pick a mismatched one.
  const channel = dialog.getByLabel('联系渠道', { exact: true });
  await expect(channel).toBeVisible();
  await expect(channel).toHaveValue('本地合成');
  await expect(channel).toBeDisabled();
  // A synthetic account keeps the stable-identifier pattern, not the numeric Facebook one.
  await expect(dialog.getByLabel('目标在此账号下的标识', { exact: true })).toHaveAttribute('pattern', '[A-Za-z0-9_:+.@\\-]{1,160}');
  await expect(dialog.getByText('本地合成账号使用稳定标识', { exact: false })).toBeVisible();
});
