import { it, expect } from 'vitest';
import { browserInboxBatch } from '../../packages/contracts/src/browser-inbox';
const message = { message_id: 'm.001', thread_id: '000777', peer_id: '999', thread_kind: 'DIRECT', direction: 'INBOUND', body: 'Hello', display_name: null, occurred_at: '2026-09-01T00:00:00Z', has_attachment: false, source_url: 'https://www.facebook.com/messages/t/000777' };
const batch = { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: '111', operating_identity_id: '222', observed_at: '2026-09-02T00:00:00Z', coverage: 'VISIBLE_MESSAGES_ONLY', messages: [message] };
it('requires stable message, thread and peer identifiers, explicit direction and exact source URL', () => {
  expect(browserInboxBatch.parse(batch).messages[0].thread_id).toBe('000777');
  for (const change of [{ thread_kind: 'GROUP' }, { peer_id: null }, { message_id: '' }, { direction: 'UNKNOWN' }, { thread_id: 'different' }, { source_url: 'not a URL' }, { source_url: 'https://www.facebook.com.evil.test/messages/t/000777' }, { source_url: 'https://user@www.facebook.com/messages/t/000777' }]) expect(browserInboxBatch.safeParse({ ...batch, messages: [{ ...message, ...change }] }).success).toBe(false);
});
it('refuses self-messages, timestamps after observation, invented coverage and oversized batches', () => {
  for (const change of [{ operating_identity_id: message.peer_id }, { observed_at: '2026-08-01T00:00:00Z' }, { coverage: 'COMPLETE_HISTORY' }, { messages: Array.from({ length: 51 }, () => message) }]) expect(browserInboxBatch.safeParse({ ...batch, ...change }).success).toBe(false);
});
it('does not accept API permissions, action correlation or arbitrary page scripts from an observation', () => {
  for (const change of [{ permission_id: 'forged' }, { correlation_id: 'forged' }, { script: 'any code' }, { psid: message.peer_id }]) expect(browserInboxBatch.safeParse({ ...batch, messages: [{ ...message, ...change }] }).success).toBe(false);
});
it('preserves incomplete displayed times and encrypted request URLs without manufacturing timestamps', () => {
  const row={...message,occurred_at:null,displayed_time:'11:59',thread_kind:'UNVERIFIED',source_url:'https://www.facebook.com/messages/e2ee/requests/t/000777/'};
  expect(browserInboxBatch.parse({...batch,messages:[row]}).messages[0]).toMatchObject({occurred_at:null,displayed_time:'11:59',thread_kind:'UNVERIFIED'});
  expect(browserInboxBatch.safeParse({...batch,messages:[{...row,displayed_time:undefined}]}).success).toBe(false);
  for(const path of ['e2ee/requests/t/different','e2ee/t/000777?x=1','e2ee/t/000777#x','e2ee/requests/new/000777']) expect(browserInboxBatch.safeParse({...batch,messages:[{...row,source_url:'https://www.facebook.com/messages/'+path}]}).success).toBe(false);
});
