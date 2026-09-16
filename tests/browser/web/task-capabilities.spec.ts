import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.describe.configure({ mode: 'serial' });

// NOTE: the `web` project drives the running server on 127.0.0.1:3000, which this workspace starts
// as `next start` (a production build) rather than `next dev`. This assertion therefore describes
// the *served* bundle, not the working tree: it only covers the task-modal capability rule once
// `next build apps/web` has been run and the local runtime restarted. The rule itself is
// unit-tested directly in tests/contracts/task-capabilities.test.ts against the real module.

// The task modal must never hold or submit a capability that it does not also render as an option.
// Initialisation and the account switch used to choose the first capability that merely was not
// discovery or inbox, so an account whose first capability was a Messenger or comment reply opened
// the action box empty (or on a value with no matching option), and the server then refused the
// task for a missing conversation or comment snapshot.
test('the task modal always shows the action it selected', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3000' ? route.continue() : route.abort());
  await page.goto('/tasks');
  const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
  await page.getByLabel('密码', { exact: true }).fill(config.operator_password);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: '任务工作台', exact: true })).toBeVisible();

  const workspace = await (await page.request.get('/api/workspace')).json();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  const accountSelect = dialog.getByLabel('执行账号', { exact: true });
  const actionSelect = dialog.getByLabel('执行动作', { exact: true });

  // Every account the modal offers must open on an action that is one of its rendered options.
  const accounts = workspace.accounts as { id: string; display_name: string }[];
  for (const account of accounts) {
    await accountSelect.selectOption(account.id);
    const options = await actionSelect.locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(value => value !== ''));
    const selected = await actionSelect.inputValue();
    if (selected === '') {
      // Nothing offered is a legal state; it must be explained, not silent.
      expect(options, account.display_name).toHaveLength(0);
      await expect(actionSelect.locator('option[value=""]')).toHaveText('此账号没有可在此创建的动作');
      continue;
    }
    expect(options, 'selected action for ' + account.display_name + ' must be a rendered option').toContain(selected);
  }

  // The account the modal opens on is the one it preselects, and its action is visible there too.
  await dialog.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '创建任务', exact: true });
  const selectedAccount = await reopened.getByLabel('执行账号', { exact: true }).inputValue();
  const reopenedOptions = await reopened.getByLabel('执行动作', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(value => value !== ''));
  const reopenedSelected = await reopened.getByLabel('执行动作', { exact: true }).inputValue();
  expect(accounts.map(account => account.id)).toContain(selectedAccount);
  expect(reopenedOptions.includes(reopenedSelected) || reopenedSelected === '').toBe(true);
});
