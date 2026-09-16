import { browserInboxMessage, type BrowserInboxTask } from '../../contracts/src/browser-inbox';
import { z } from 'zod';
import { requireCondition } from '@kff/core';

export function inboxFixtureMessages(): z.infer<typeof browserInboxMessage>[] {
  return ['What does a consultation include?', 'Can we discuss the available times?', 'I would like to know the price.', 'I will check the times for you.'].map((body, i) => browserInboxMessage.parse({
    message_id: 'mid.fixture.' + (i + 1), thread_id: i < 2 ? '000777' : '000888', peer_id: i < 2 ? '999888777666555' : '999888777666556',
    thread_kind: 'DIRECT', direction: i === 3 ? 'OUTBOUND' : 'INBOUND', body, display_name: i < 2 ? 'Inbox sample A' : 'Inbox sample B',
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), has_attachment: false,
    source_url: 'https://www.facebook.com/messages/t/' + (i < 2 ? '000777' : '000888'),
  }));
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function renderBrowserInboxFixture(request: BrowserInboxTask, rows = inboxFixtureMessages()) {
  requireCondition(request.cursor === null || /^offset:[0-9]{1,6}$/.test(request.cursor), 'CURSOR_EXPIRED', '合成游标无效');
  const offset = request.cursor ? Number(request.cursor.slice(7)) : 0;
  requireCondition(offset <= rows.length, 'CURSOR_EXPIRED', '合成游标已失效');
  const selected = rows.slice(offset, offset + request.limit).map(row => browserInboxMessage.parse(row));
  const next = offset + selected.length < rows.length ? 'offset:' + (offset + selected.length) : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local Inbox fixture</title><body>
    <h1>Local synthetic Inbox</h1><p data-testid="login-identity">${escape(request.binding.environment.configuration.login_account_id)}</p>
    <p data-testid="account-identity">${escape(request.binding.environment.configuration.operating_identity_id)}</p>
    <main data-testid="inbox-page" data-monitor-id="${request.monitor_id}" data-cursor="${escape(request.cursor ?? '')}" data-next-cursor="${escape(next)}" data-has-more="${Boolean(next)}">
    ${selected.map(row => `<article data-testid="inbox-row" data-message-id="${escape(row.message_id)}" data-thread-id="${escape(row.thread_id)}" data-peer-id="${row.peer_id}" data-direction="${row.direction}" data-attachment="${row.has_attachment}">
      <p data-field="body">${escape(row.body)}</p><span data-field="name" data-is-null="${row.display_name === null}">${escape(row.display_name ?? 'Unnamed contact')}</span>
      <time datetime="${row.occurred_at}">${row.occurred_at}</time><a data-source-url href="${escape(row.source_url)}">Original conversation</a></article>`).join('')}
    </main></body></html>`;
}
