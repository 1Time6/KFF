import type { ActionReport, AgentCommand } from '@kff/contracts';
import { browserInboxMessage, browserInboxPage } from '../../contracts/src/browser-inbox';
import { digest, requireCondition, validateTargetUrl } from '@kff/core';
import { openManagedBrowser } from './browser-profile';
import { assertTemplateSnapshot } from './templates';
import type { ExecutorHooks } from './fixture';

export async function executeBrowserInbox(command: AgentCommand, root: string, hooks: ExecutorHooks, fixtureOrigin = 'http://127.0.0.1:4311'): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  const snapshot = command.snapshot, request = snapshot.inbox, environment = snapshot.browser_environment;
  requireCondition(snapshot.capability_key === 'kff.fixture.inbox.read.browser' && snapshot.adapter_version === 'browser-inbox-v1' && snapshot.is_synthetic && snapshot.mode === 'TEST_ONLY' && request?.template === 'fixture-inbox-dom-v1' && environment?.configuration.driver === 'native', 'FORBIDDEN_SCOPE', '当前收件模板只支持本地合成环境');
  requireCondition(digest(snapshot) === command.snapshot_hash && digest(environment) === digest(request.binding.environment), 'APPROVAL_STALE', '收件快照或环境绑定不一致');
  const controlled = () => { hooks.assertControlled(); requireCondition(Date.parse(request.expires_at) > Date.now(), 'RETENTION_EXPIRED', '收件原始回执已到期'); };
  assertTemplateSnapshot(snapshot); controlled();
  const origin = new URL(fixtureOrigin);
  requireCondition(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'FORBIDDEN_SCOPE', '合成收件只允许本机固定来源');
  const managed = await openManagedBrowser(root, environment, true);
  try {
    hooks.onContext(managed.context);
    await managed.context.route('**/*', route => {
      try { validateTargetUrl(route.request().url(), [], origin.origin); requireCondition(route.request().method() === 'GET', 'FORBIDDEN_SCOPE', '收件不能提交数据'); return route.continue(); }
      catch { return route.abort('blockedbyclient'); }
    });
    const page = await managed.context.newPage(); page.setDefaultTimeout(10000);
    const url = new URL('/browser-inbox', origin); url.searchParams.set('request', JSON.stringify(request));
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    requireCondition(response?.ok(), 'REMOTE_ERROR', '收件页面未正常返回');
    for (const [selector, expected] of [['login-identity', environment.configuration.login_account_id], ['account-identity', snapshot.external_account_id]] as const) {
      const node = page.getByTestId(selector);
      requireCondition(await node.count() === 1 && await node.isVisible(), 'AUTH_EXPIRED', '页面缺少唯一可见账号身份');
      requireCondition((await node.innerText()).trim() === expected, 'ACCOUNT_MISMATCH', '当前登录或操作身份与环境不一致');
    }
    const main = page.getByTestId('inbox-page');
    requireCondition(await main.count() === 1 && await main.isVisible() && await main.getAttribute('data-monitor-id') === request.monitor_id && await main.getAttribute('data-cursor') === (request.cursor ?? ''), 'INBOX_SOURCE_MISMATCH', '会话区域或游标与任务不符');
    const next = await main.getAttribute('data-next-cursor'), more = await main.getAttribute('data-has-more');
    requireCondition(next !== null && (more === 'true' || more === 'false'), 'INBOX_SOURCE_MISMATCH', '分页状态不明确');
    const rows = main.getByTestId('inbox-row'); requireCondition(await rows.count() <= request.limit, 'INBOX_PAGE_LIMIT', '消息超过单页上限');
    const messages = [];
    for (const row of await rows.all()) {
      controlled(); requireCondition(await row.isVisible(), 'INBOX_SOURCE_MISMATCH', '消息不可见');
      for (const selector of ['[data-field="body"]', '[data-field="name"]', 'time', 'a[data-source-url]']) {
        const field = row.locator(selector); requireCondition(await field.count() === 1 && await field.isVisible(), 'INBOX_SOURCE_MISMATCH', '消息字段缺失、重复或不可见');
      }
      const attachment = await row.getAttribute('data-attachment'); requireCondition(attachment === 'true' || attachment === 'false', 'INBOX_SOURCE_MISMATCH', '附件状态不明确');
      messages.push(browserInboxMessage.parse({ message_id: await row.getAttribute('data-message-id'), thread_id: await row.getAttribute('data-thread-id'), peer_id: await row.getAttribute('data-peer-id'), thread_kind: 'DIRECT', direction: await row.getAttribute('data-direction'), has_attachment: attachment === 'true', body: await row.locator('[data-field="body"]').innerText(), display_name: await row.locator('[data-field="name"]').getAttribute('data-is-null') === 'true' ? null : await row.locator('[data-field="name"]').innerText(), occurred_at: await row.locator('time').getAttribute('datetime'), source_url: await row.locator('a[data-source-url]').getAttribute('href') }));
    }
    controlled(); const observed = new Date().toISOString();
    const inboxPage = browserInboxPage.parse({ monitor_id: request.monitor_id, cursor: request.cursor, next_cursor: next || null, has_more: more === 'true', batch: { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: environment.configuration.login_account_id, operating_identity_id: snapshot.external_account_id, observed_at: observed, coverage: 'VISIBLE_MESSAGES_ONLY', messages } });
    return { outcome: 'VERIFIED_SUCCEEDED', inbox_page: inboxPage, receipt: { remote_id: 'inbox:' + request.monitor_id + ':' + request.token, actual_account_id: snapshot.external_account_id, content_hash: digest(inboxPage), evidence_kind: 'synthetic_dom', observed_at: observed }, diagnostic: { step: 'browser-inbox-read', browser_version: managed.context.browser()?.version(), scene: { identity_count: 1, submit_controls: 0, result_count: messages.length } } };
  } finally { await managed.close(); hooks.onContext(null); }
}
