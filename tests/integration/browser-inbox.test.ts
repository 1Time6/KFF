import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { receiveBrowserInboxBatchInTransaction, injectFacebookFixture, configureFacebook } from '../../packages/core/src/facebook-inbound';
import { inboxConversation, inboxWorkspace } from '../../packages/core/src/inbox';
import { configureEnvironment } from '../../packages/core/src/environments';
import { conversationControl, sendConversationReply } from '../../packages/core/src/lead-reception';
import { browserInboxSetup, browserInboxSample, ingestBrowserBatch } from '../helpers/browser-inbox';
import { leadScope as scope, clearLeads, leadEvent } from '../helpers/lead-fixture';

beforeAll(async () => { await migrate(); await seed(); });
beforeEach(async () => { await clearLeads(); await query("DELETE FROM kff.inbound_events WHERE source_kind='facebook_browser'"); });
afterAll(closePool);

it('projects browser messages into the original Inbox with provenance and a distinct identity namespace', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding), result = await ingestBrowserBatch(scope, h.binding, batch);
  const detail = await inboxConversation(scope, result.events[0].conversation_id!);
  expect(detail.conversation).toMatchObject({ account_id: h.account_id, channel_kind: 'FACEBOOK_BROWSER_MESSENGER', handling_mode: 'HUMAN', reply_window_expires_at: null });
  expect(detail.outbound_available).toBe(false); expect(detail.messages[0]).toMatchObject({ body: batch.messages[0].body, direction: 'INBOUND', source: { transport: 'BROWSER', thread_id: '000777', peer_id: batch.messages[0].peer_id } });
  expect((await query('SELECT contact_permission_id FROM kff.messages WHERE id=$1', [detail.messages[0].id]))[0].contact_permission_id).toBeNull();
  const evidence = (await query('SELECT source_details FROM kff.inbound_events WHERE id=$1', [result.events[0].event_id]))[0].source_details;
  expect(evidence.browser_evidence).toMatchObject({ environment_id: h.environment_id, configuration_version: 2 });
  expect((await inboxWorkspace(scope)).counts).toEqual({ customers: 1, conversations: 1, inbound_messages: 1 });
  await expect(conversationControl(scope, detail.conversation.id, { request_id: randomUUID(), expected_version: detail.conversation.control_version, mode: 'AI', reason: 'Cannot route browser identity to Send API' })).rejects.toMatchObject({ code: 'RECEPTION_UNAVAILABLE' });
  await expect(sendConversationReply(scope, detail.conversation.id, { request_id: randomUUID(), expected_version: detail.conversation.control_version, body: 'No send transport', refer_whatsapp: false })).rejects.toMatchObject({ code: 'RECEPTION_UNAVAILABLE' });
});

it('deduplicates concurrent reads and later observations with changed display names without extending API eligibility', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding);
  const values = await Promise.all(Array.from({ length: 5 }, () => ingestBrowserBatch(scope, h.binding, batch)));
  expect(values.reduce((n, value) => n + value.stored, 0)).toBe(1);
  const later = { ...batch, observed_at: new Date().toISOString(), messages: [{ ...batch.messages[0], display_name: 'Renamed customer' }] };
  expect(await ingestBrowserBatch(scope, h.binding, later)).toMatchObject({ stored: 0, duplicates: 1 });
  const changed = { ...batch, messages: [{ ...batch.messages[0], body: 'Edited original message' }] };
  await expect(ingestBrowserBatch(scope, h.binding, changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await query('SELECT count(*)::int AS n FROM kff.contact_permissions p JOIN kff.contact_targets t ON t.id=p.target_id WHERE t.account_id=$1', [h.account_id]))[0].n).toBe(0);
});

it('keeps identical browser/API numeric IDs and event keys in separate existing customer records', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding), page = h.binding.environment.configuration.operating_identity_id;
  await configureFacebook(scope, { request_id: randomUUID(), account_id: h.account_id, environment_id: h.environment_id, expected_version: 0, state: 'ACTIVE', auto_reply: true, reply_window_hours: 24, policy_ref: 'fixture.namespace-only' });
  const browser = await ingestBrowserBatch(scope, h.binding, batch), api = await injectFacebookFixture(scope, h.account_id, leadEvent(page, { sender_id: batch.messages[0].thread_id, event_id: batch.messages[0].thread_id + '/' + batch.messages[0].message_id }));
  expect(browser.events[0].customer_id).not.toBe(api.customer_id);
  expect((await inboxWorkspace(scope)).counts.customers).toBe(2);
  const detail = await inboxConversation(scope, api.conversation_id!); expect(detail.conversation.handling_mode).toBe('AI');
});

it('rolls back the entire batch when a later message changes the peer of the same thread', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding);
  batch.messages.push({ ...batch.messages[0], message_id: 'second', peer_id: '1234', occurred_at: new Date(Date.now() - 1000).toISOString() });
  await expect(ingestBrowserBatch(scope, h.binding, batch)).rejects.toMatchObject({ code: 'MESSAGE_IDENTITY_MISMATCH' });
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
  expect((await query("SELECT count(*)::int AS n FROM kff.inbound_events WHERE source_kind='facebook_browser'"))[0].n).toBe(0);
});

it('tracks native human replies once, preserves newest inbound sequence, and retains opt-out on later messages', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding);
  batch.messages[0].body = 'Stop contacting me';
  const first = await ingestBrowserBatch(scope, h.binding, batch), id = first.events[0].conversation_id!;
  const echo = { ...batch, messages: [{ ...batch.messages[0], message_id: 'native-reply', direction: 'OUTBOUND' as const, body: 'Understood' }] };
  expect(await ingestBrowserBatch(scope, h.binding, echo)).toMatchObject({ stored: 1 });
  expect(await ingestBrowserBatch(scope, h.binding, echo)).toMatchObject({ duplicates: 1 });
  const next = { ...batch, messages: [{ ...batch.messages[0], message_id: 'next-inbound', body: 'Another message' }] };
  await ingestBrowserBatch(scope, h.binding, next);
  const detail = await inboxConversation(scope, id);
  expect(detail.conversation).toMatchObject({ stage: 'OPTED_OUT', opted_out: true, last_inbound_sequence: 3 });
  expect(detail.messages.map(row => row.direction)).toEqual(['INBOUND', 'EXTERNAL_OUTBOUND', 'INBOUND']);
});

it('rejects wrong actor, environment configuration, brand and viewer before importing a page', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding);
  await expect(ingestBrowserBatch(scope, h.binding, { ...batch, login_account_id: '123' })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  await expect(ingestBrowserBatch({ ...scope, role: 'viewer' }, h.binding, batch)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await expect(ingestBrowserBatch({ ...scope, brand_id: randomUUID() }, h.binding, batch)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await configureEnvironment(scope, h.environment_id, { expected_version: 2, configuration: { ...h.binding.environment.configuration, locale: 'en-GB' } });
  await expect(ingestBrowserBatch(scope, h.binding, batch)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
});

it('rolls back browser inbox writes when the surrounding Agent receipt transaction fails', async () => {
  const h = await browserInboxSetup(scope), batch = browserInboxSample(h.binding);
  await expect(scoped(scope, async client => { await receiveBrowserInboxBatchInTransaction(client, scope, h.binding, batch); throw new Error('Receipt transaction lost'); })).rejects.toThrow('Receipt transaction lost');
  expect((await inboxWorkspace(scope)).counts.customers).toBe(0);
  expect(await ingestBrowserBatch(scope, h.binding, batch)).toMatchObject({ stored: 1 });
});

it('keeps one browser thread on two accounts isolated', async () => {
  const a = await browserInboxSetup(scope), b = await browserInboxSetup(scope);
  const one = await ingestBrowserBatch(scope, a.binding, browserInboxSample(a.binding)), two = await ingestBrowserBatch(scope, b.binding, browserInboxSample(b.binding));
  expect(one.events[0].customer_id).not.toBe(two.events[0].customer_id);
  expect((await inboxWorkspace(scope)).counts.customers).toBe(2);
});
