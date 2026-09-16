import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { browserMessageContext, browserInboxMessage } from '../../contracts/src/browser-inbox';
import { fixtureScenarioSchema } from '@kff/contracts';
import { inboxFixtureMessages } from './browser-inbox-fixture';

const remote = z.string().regex(/^[0-9]{1,128}$/);
export const browserMessageFixtureRequest = z.object({
  account_id: remote, login_account_id: remote, action_id: z.string().uuid(), target: browserMessageContext,
  scenario: fixtureScenarioSchema,
}).strict();
export const browserMessageWrite = z.object({
  account_id: remote, action_id: z.string().uuid(), thread_id: browserInboxMessage.shape.thread_id,
  peer_id: remote, last_seen_message_id: browserInboxMessage.shape.message_id, body: z.string().trim().min(1).max(2000),
}).strict();
export const browserFixtureInbound = browserMessageWrite.omit({ action_id: true, last_seen_message_id: true }).extend({ display_name: z.string().max(80).nullable() });
export const browserFixtureEvent = z.object({ account_id: remote, action_id: z.string().uuid().nullable(), message: browserInboxMessage }).strict();
export type BrowserFixtureEvent = z.infer<typeof browserFixtureEvent>;
export const browserFixtureHistory = (accountId: string, events: BrowserFixtureEvent[]) => [...inboxFixtureMessages(), ...events.filter(row => row.account_id === accountId).map(row => row.message)];
export function newBrowserFixtureEvent(events: BrowserFixtureEvent[], raw: unknown, direction: 'INBOUND' | 'OUTBOUND'): BrowserFixtureEvent {
  const input = direction === 'INBOUND' ? browserFixtureInbound.parse(raw) : browserMessageWrite.parse(raw);
  const history = browserFixtureHistory(input.account_id, events).filter(row => row.thread_id === input.thread_id);
  if (history.some(row => row.peer_id !== input.peer_id)) throw new Error('Synthetic thread peer changed');
  if ('action_id' in input && (history.at(-1)?.message_id !== input.last_seen_message_id || events.some(row => row.action_id === input.action_id))) throw new Error('Synthetic conversation changed or action already submitted');
  return browserFixtureEvent.parse({ account_id: input.account_id, action_id: 'action_id' in input ? input.action_id : null, message: {
    message_id: 'synthetic_' + randomUUID(), thread_id: input.thread_id, peer_id: input.peer_id, thread_kind: 'DIRECT', direction,
    body: input.body, display_name: 'display_name' in input ? input.display_name : history.at(-1)?.display_name ?? null,
    occurred_at: new Date().toISOString(), has_attachment: false, source_url: 'https://www.facebook.com/messages/t/' + input.thread_id,
  } });
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderBrowserMessageFixture(input: z.infer<typeof browserMessageFixtureRequest>, events: BrowserFixtureEvent[]) {
  const account = input.scenario === 'wrong_account' ? '999' : input.account_id;
  const rows = browserFixtureHistory(input.account_id, events).filter(row => row.thread_id === input.target.thread_id);
  const history = rows.map(row => `<article data-testid="message-row" data-message-id="${escape(row.message_id)}" data-peer-id="${row.peer_id}" data-direction="${row.direction}"><p>${escape(row.body)}</p></article>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local browser conversation</title><body><h1>Local synthetic conversation</h1>
    ${input.scenario === 'login_expired' ? '<button>Log in</button>' : `<p data-testid="login-identity">${input.login_account_id}</p><p data-testid="account-identity">${account}</p>`}
    <main data-testid="conversation" data-thread-id="${escape(input.target.thread_id)}" data-peer-id="${input.target.peer_id}"><div data-testid="history">${history}</div>
    <label>Reply<textarea aria-label="Reply"></textarea></label><button data-testid="send">Send reply</button>${input.scenario === 'duplicate_control' ? '<button data-testid="send">Send again</button>' : ''}<div data-testid="result"></div></main>
    <script>
    const pinned=${JSON.stringify({ account_id: account, action_id: input.action_id, thread_id: input.target.thread_id, peer_id: input.target.peer_id }).replaceAll('<', '\\u003c')};
    document.querySelector('[data-testid=send]').addEventListener('click',async()=>{
      const history=document.querySelector('[data-testid=history]'),tail=history.lastElementChild?.dataset.messageId;
      const response=await fetch('/browser-message-send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...pinned,last_seen_message_id:tail,body:document.querySelector('textarea').value})});
      if(!response.ok)return; const row=await response.json();
      const node=document.createElement('article');node.dataset.testid='sent-message';node.dataset.messageId=row.message.message_id;node.dataset.accountId=row.account_id;node.dataset.threadId=row.message.thread_id;node.dataset.peerId=row.message.peer_id;node.textContent=row.message.body;
      document.querySelector('[data-testid=result]').append(node);
    });
    </script></body></html>`;
}
