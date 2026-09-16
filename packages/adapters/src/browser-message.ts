import type { AgentCommand, ActionReport } from '@kff/contracts';
import { AppError, digest, requireCondition, validateTargetUrl } from '@kff/core';
import { openManagedBrowser } from './browser-profile';
import { assertTemplateSnapshot } from './templates';
import { browserMessageWrite } from './browser-message-fixture';
import type { ExecutorHooks } from './fixture';

export async function executeBrowserMessage(command: AgentCommand, root: string, hooks: ExecutorHooks, fixtureOrigin = 'http://127.0.0.1:4311'): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  const snapshot = command.snapshot, target = snapshot.message?.browser, environment = snapshot.browser_environment;
  requireCondition(snapshot.is_synthetic && snapshot.mode === 'TEST_ONLY' && snapshot.capability_key === 'kff.fixture.messenger.reply.browser' && snapshot.adapter_version === 'fixture-browser-messenger-v1' && target && environment?.configuration.driver === 'native', 'FORBIDDEN_SCOPE', '此浏览器回复模板只执行本项目合成会话');
  requireCondition(digest(snapshot) === command.snapshot_hash && digest(snapshot.body) === snapshot.content_hash, 'APPROVAL_STALE', '回复快照已变化'); assertTemplateSnapshot(snapshot); hooks.assertControlled();
  const origin = new URL(fixtureOrigin);
  requireCondition(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'FORBIDDEN_SCOPE', '合成回复只允许本机固定来源');
  const managed = await openManagedBrowser(root, environment, true);
  let intent = false, postAvailable = false, step = 'prepare';
  try {
    hooks.onContext(managed.context);
    await managed.context.route('**/*', route => {
      try {
        const request = route.request(); validateTargetUrl(request.url(), [], origin.origin);
        if (request.method() === 'GET') return route.continue();
        requireCondition(request.method() === 'POST' && new URL(request.url()).pathname === '/browser-message-send' && intent && postAvailable, 'FORBIDDEN_SCOPE', '未授权的浏览器提交');
        const payload = browserMessageWrite.parse(request.postDataJSON());
        requireCondition(payload.account_id === snapshot.external_account_id && payload.action_id === command.action_id && payload.thread_id === target.thread_id && payload.peer_id === target.peer_id && payload.last_seen_message_id === target.last_seen_message_id && payload.body === snapshot.body, 'SUBMISSION_UNCERTAIN', '提交身份或正文变化');
        postAvailable = false; return route.continue();
      } catch { return route.abort('blockedbyclient'); }
    });
    const page = await managed.context.newPage(); page.setDefaultTimeout(10000);
    const url = new URL('/browser-conversation', origin); url.searchParams.set('request', JSON.stringify({ account_id: snapshot.external_account_id, login_account_id: environment.configuration.login_account_id, action_id: command.action_id, target, scenario: snapshot.fixture_scenario }));
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' }); requireCondition(response?.ok(), 'REMOTE_ERROR', '会话页面读取失败');
    const current = async () => {
      hooks.assertControlled();
      for (const [id, expected] of [['login-identity', environment.configuration.login_account_id], ['account-identity', snapshot.external_account_id]] as const) {
        const node = page.getByTestId(id); requireCondition(await node.count() === 1 && await node.isVisible(), 'AUTH_EXPIRED', '缺少唯一可见身份'); requireCondition((await node.innerText()).trim() === expected, 'ACCOUNT_MISMATCH', '当前登录账号或操作身份不一致');
      }
      const thread = page.getByTestId('conversation');
      requireCondition(await thread.count() === 1 && await thread.isVisible() && await thread.getAttribute('data-thread-id') === target.thread_id && await thread.getAttribute('data-peer-id') === target.peer_id, 'MESSAGE_IDENTITY_MISMATCH', '当前会话或对方身份不一致');
      const rows = thread.getByTestId('message-row');
      requireCondition(await rows.count() > 0, 'MESSAGE_IDENTITY_MISMATCH', '页面没有可核对的会话历史');
      requireCondition(await rows.last().isVisible() && await rows.last().getAttribute('data-message-id') === target.last_seen_message_id, 'INBOUND_SUPERSEDED', '页面会话出现新消息，请先重新收件');
      const trigger = thread.locator('[data-testid="message-row"]').filter({ visible: true });
      const ids = await trigger.evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-message-id'), peer: node.getAttribute('data-peer-id'), direction: node.getAttribute('data-direction') })));
      const triggers = ids.filter(row => row.id === target.trigger_remote_message_id);
      requireCondition(new Set(ids.map(row => row.id)).size === ids.length && triggers.length === 1 && triggers[0].peer === target.peer_id && triggers[0].direction === 'INBOUND', 'MESSAGE_IDENTITY_MISMATCH', '主动咨询消息缺失或不唯一');
      const send = page.getByTestId('send'); requireCondition(await send.count() === 1 && await send.isVisible() && await send.isEnabled(), 'NEEDS_HUMAN', '发送入口不唯一或不可用');
    };
    await current(); await page.getByRole('textbox', { name: 'Reply', exact: true }).fill(snapshot.body); step = 'prepared';
    if (snapshot.fixture_scenario === 'slow') await page.waitForTimeout(8000);
    await current(); await hooks.beforeSubmit(); intent = true; step = 'submitted';
    await current(); requireCondition(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue() === snapshot.body, 'SUBMISSION_UNCERTAIN', '待发送正文变化'); postAvailable = true;
    await page.getByTestId('send').click(); const result = page.getByTestId('sent-message'); await result.waitFor({ state: 'visible' });
    if (snapshot.fixture_scenario === 'lost_after_submit') throw new AppError('SUBMISSION_UNCERTAIN', '合成场景：提交后丢失回执');
    requireCondition(await result.count() === 1 && await result.getAttribute('data-account-id') === snapshot.external_account_id && await result.getAttribute('data-thread-id') === target.thread_id && await result.getAttribute('data-peer-id') === target.peer_id && digest(await result.innerText()) === snapshot.content_hash, 'SUBMISSION_UNCERTAIN', '发送结果与原回复不符');
    const remoteId = await result.getAttribute('data-message-id'); requireCondition(remoteId && remoteId !== target.last_seen_message_id, 'SUBMISSION_UNCERTAIN', '缺少新的消息标识');
    return { outcome: 'VERIFIED_SUCCEEDED', receipt: { remote_id: remoteId, thread_id: target.thread_id, recipient_id: target.peer_id, actual_account_id: snapshot.external_account_id, content_hash: snapshot.content_hash, evidence_kind: 'synthetic_message', observed_at: new Date().toISOString() }, diagnostic: { step: 'browser-message-verified', browser_version: managed.context.browser()?.version() } };
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'EXECUTOR_ERROR';
    return { outcome: intent ? 'UNKNOWN_OUTCOME' : code === 'STOP_REQUESTED' ? 'CANCELED' : code === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN' : 'BLOCKED', error_code: code, diagnostic: { step } };
  } finally { await managed.close(); hooks.onContext(null); }
}
