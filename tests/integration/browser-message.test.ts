import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { startFixtureServer } from '../../scripts/fixture-server';
import { query, closePool } from '@kff/database';
import { AppError, digest } from '@kff/core';
import { quiescenceInput, type ActionReport, type AgentCommand } from '@kff/contracts';
import { receptionPolicy } from '../../packages/contracts/src/lead';
import type { BrowserFixtureEvent } from '../../packages/adapters/src/browser-message-fixture';
import { configureFacebook } from '../../packages/core/src/facebook-inbound';
import { configureBrowserInbox, controlBrowserInbox, prepareBrowserInboxPage, syncBrowserInboxTasks } from '../../packages/core/src/browser-inbox';
import { inboxConversation } from '../../packages/core/src/inbox';
import { sendConversationReply, conversationReception, referralResult, conversationControl } from '../../packages/core/src/lead-reception';
import { processReceptionOne, configureReceptionPolicy } from '../../packages/core/src/reception-worker';
import { dispatchOne, claimCommand, beginSubmission, acceptReport, agentHeartbeat, commandStatus, recordBrowserOpened } from '../../packages/core/src/execution';
import { recordQuiescence, reconcileSynthetic, releaseQuarantine } from '../../packages/core/src/reconciliation';
import { adjudicateAction } from '../../packages/core/src/adjudication';
import { runGuardian } from '../../apps/agent/src/guardian';
import { closureProof, noProgressProtocolVersion, readClosure, readClosureEvidence } from '../../apps/agent/src/guardian-protocol';
import { flushActionJournal, type JournalEntry } from '../../apps/agent/src/action-journal';
import { isProcessAlive } from '../../apps/agent/src/process-tree';
import { browserInboxSetup, ingestBrowserBatch } from '../helpers/browser-inbox';
import { leadScope as scope, leadAgent as agent, clearLeads, seedDestination, claimLead } from '../helpers/lead-fixture';

let fixture: Awaited<ReturnType<typeof startFixtureServer>>, storage: string;
const originals = [process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN, process.env.KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN];
const useOrigin = () => { process.env.KFF_BROWSER_INBOX_FIXTURE_ORIGIN = fixture.origin; process.env.KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN = fixture.origin; };
beforeAll(async () => { await migrate(); await seed(); storage = await mkdtemp(path.resolve('.kff/browser-message-test-')); fixture = await startFixtureServer(0, storage); useOrigin(); });
beforeEach(async () => { await clearLeads(); await query("DELETE FROM kff.inbound_events WHERE source_kind='facebook_browser'"); });
afterAll(async () => { for (const [index, key] of ['KFF_BROWSER_INBOX_FIXTURE_ORIGIN', 'KFF_BROWSER_MESSAGE_FIXTURE_ORIGIN'].entries()) { if (originals[index] === undefined) delete process.env[key]; else process.env[key] = originals[index]; } await fixture?.close(); await closePool(); });
const reply = (version = 1) => ({ request_id: randomUUID(), expected_version: version, body: 'Thanks, our team can help.', refer_whatsapp: false, fixture_scenario: 'normal' as const });
async function postEvent(accountId: string, body = 'Hello, I would like to know more.') {
  const response = await fetch(fixture.origin + '/browser-inbox/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: accountId, thread_id: '000777', peer_id: '999888777666555', body, display_name: 'Browser reception customer' }) });
  expect(response.status).toBe(200); return await response.json() as BrowserFixtureEvent;
}
async function setup(auto = false, readDom = false) {
  const h = await browserInboxSetup(scope), page = h.binding.environment.configuration.operating_identity_id;
  const config = { request_id: randomUUID(), account_id: h.account_id, environment_id: h.environment_id, expected_version: 0, transport: 'BROWSER' as const, state: 'ACTIVE' as const, auto_reply: auto, reply_window_hours: 24, policy_ref: 'kff.browser-fixture.service-window.v1' };
  await configureFacebook(scope, config);
  await configureReceptionPolicy(scope, { request_id: randomUUID(), account_id: h.account_id, expected_version: 1, policy: receptionPolicy.parse({ min_reply_interval_seconds: 0 }) });
  const event = await postEvent(page);
  if (!readDom) await ingestBrowserBatch(scope, h.binding, { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: h.binding.environment.configuration.login_account_id, operating_identity_id: page, observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: [event.message] });
  return { ...h, page, config, event };
}
async function conversation(accountId: string) { return (await query("SELECT v.id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.account_id=$1 AND i.remote_id='000777'", [accountId]))[0].id as string; }
async function execute(command: AgentCommand) {
  const control = new AbortController(), timer = setInterval(() => { void agentHeartbeat(agent, command.id).then(row => { if (!row.continue) control.abort(); }, () => control.abort()); }, 2500);
  try { return await runGuardian(command, path.join(storage, randomUUID()), digest(randomUUID()), { signal: control.signal, beforeSubmit: async () => { await beginSubmission(agent, command.id); } }); }
  finally { clearInterval(timer); }
}
async function finish(command: AgentCommand) {
  const closure = await execute(command), report = { ...closure.result, event_id: randomUUID(), command_id: command.id };
  await acceptReport(agent, report); await recordQuiescence(agent, command.id, closureProof(closure));
  expect(closure.context_closed).toBe(true); return { closure, report };
}
async function scan(environmentId: string) {
  let monitor = (await query('SELECT * FROM kff.browser_inbox_monitors WHERE environment_id=$1', [environmentId]))[0];
  if (!monitor) monitor = await configureBrowserInbox(scope, { request_id: randomUUID(), environment_id: environmentId, expected_version: 0, page_size: 50, interval_seconds: 10, raw_retention_hours: 1 });
  await controlBrowserInbox(scope, monitor.id, { request_id: randomUUID(), expected_version: monitor.version, action: 'SCAN' });
  expect(await prepareBrowserInboxPage()).not.toBeNull(); await dispatchOne(); const command = (await claimCommand(agent))!;
  const result = await finish(command); expect(result.report.outcome).toBe('VERIFIED_SUCCEEDED'); await syncBrowserInboxTasks(); return result;
}
const receipts = async (actionId: string) => (await (await fetch(fixture.origin + '/browser-message-receipts?action_id=' + actionId)).json()) as Array<Record<string, unknown>>;
/**
 * The three endpoints `main.ts` sends the journal through, wired to the real controller functions
 * instead of a stub, so a flush in these tests proves what the production flush would do.
 */
const controller = async <T>(endpoint: string, data?: unknown): Promise<T> => {
  const parts = endpoint.split('/');
  if (endpoint === 'action-reports') return await acceptReport(agent, data as ActionReport) as T;
  if (parts[0] === 'commands' && parts[2] === 'status') return await commandStatus(agent, parts[1]) as T;
  if (parts[0] === 'commands' && parts[2] === 'quiescence') return await recordQuiescence(agent, parts[1], quiescenceInput.parse(data)) as T;
  throw new Error('Unexpected controller endpoint ' + endpoint);
};

/**
 * The liveness ladder the two stall cases run under. Production uses `force: 10000`; these cases pin a
 * shorter one so a single case does not spend ten seconds waiting on a decision that is already made.
 *
 * The override exists so the §7 capacity matrix can measure the *production* budget under load without
 * the two configurations drifting apart in any other respect. It changes no default - an unset variable
 * reproduces the pinned value exactly - and it is read here rather than plumbed through the policy so
 * that a mis-set variable fails loudly instead of silently running a ladder nobody asked for.
 */
const livenessForce = () => {
  const raw = process.env.KFF_TEST_LIVENESS_FORCE;
  if (raw === undefined) return 5000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000) throw new Error('KFF_TEST_LIVENESS_FORCE must be an integer >= 1000, got ' + raw);
  return value;
};
const liveness = (phase: 'granting' | 'awaiting-intent') => ({ [phase]: 1500, grace: 1000, force: livenessForce() });

/**
 * §8-G: a recording wrapper around the controller. It appends to an array and does nothing else - it
 * does not retry, reorder, delay or swallow - so the flush it observes runs as close to unperturbed as
 * an observation can be. What it buys is that a failure carries its own explanation: which endpoint
 * refused and with which domain code, instead of another load run spent guessing at it.
 */
function recordingController() {
  const log: Array<{ endpoint: string; error?: string }> = [];
  const wrapped = async <T>(endpoint: string, data?: unknown): Promise<T> => {
    try { const value = await controller<T>(endpoint, data); log.push({ endpoint }); return value; }
    catch (error) { log.push({ endpoint, error: error instanceof AppError ? error.code : String((error as Error)?.message ?? error) }); throw error; }
  };
  return { wrapped, log };
}

/**
 * §8-G: what the machine looked like at the moment the flush refused. Printed rather than asserted,
 * because the run this exists to explain is the failing one, and the assertions that would describe it
 * are downstream of the failure. The five facts are the ones a reader needs to place the refusal: the
 * command's lifecycle and its quiescence, the action's adjudicated state, the leases and whether they
 * had aged out, the journal entry the flush was working from, and the guardian proof it read.
 */
async function flushDiagnostics(command: AgentCommand, runtime: string, journal: Record<string, JournalEntry>, identity: { command_id: string; action_id: string; guardian_nonce: string }, calls: unknown[]) {
  const report = async (label: string, body: () => Promise<unknown>) => { try { return await body(); } catch (error) { return { 'read_error': (error as { code?: string }).code ?? String(error) }; } };
  const evidence = await report('proof', async () => readClosureEvidence(runtime, identity));
  console.log('[§8-G] flush refused: ' + JSON.stringify({
    calls,
    // `since_claim` is the number this whole question turns on: the resource leases are issued for 30s
    // at dispatch and are renewed only by a heartbeat, so the flush's distance from the claim is what
    // decides whether `validateLeases` still finds them live.
    command: await report('command', async () => (await query('SELECT state, quiesced_at, expires_at, created_at, claimed_at, clock_timestamp() AS now, clock_timestamp() - claimed_at AS since_claim FROM kff.agent_commands WHERE id=$1', [command.id]))[0]),
    action: await report('action', async () => (await query('SELECT state, error_code FROM kff.actions WHERE id=$1', [command.action_id]))[0]),
    attempt: await report('attempt', async () => (await query('SELECT state, leases FROM kff.action_attempts WHERE id=$1', [command.attempt_id]))[0]),
    // Column names here are the schema's, not the words the prose uses: there is no `held` column and
    // the environment is reached through `resource_id`. The three conditions of `validateLeases` are
    // evaluated explicitly so the refusal is read off the row rather than inferred from the code.
    leases: await report('leases', async () => await query('SELECT resource_type, resource_id, token, expires_at, quarantined, expires_at < clock_timestamp() AS expired, clock_timestamp() AS now FROM kff.resource_leases WHERE holder_attempt_id=$1 ORDER BY resource_type', [command.attempt_id])),
    lease_gate: await report('lease_gate', async () => (await query("SELECT (SELECT state='CLAIMED' FROM kff.agent_commands WHERE id=$1) AS command_claimed, (SELECT expires_at>clock_timestamp() FROM kff.agent_commands WHERE id=$1) AS command_unexpired, (SELECT jsonb_array_length(leases)=2 FROM kff.action_attempts WHERE id=$2) AS leases_complete", [command.id, command.attempt_id]))[0]),
    environment: await report('environment', async () => (await query("SELECT state, browser_status FROM kff.environments WHERE id=(SELECT resource_id FROM kff.resource_leases WHERE holder_attempt_id=$1 AND resource_type='environment' LIMIT 1)", [command.attempt_id]))[0]),
    journal: journal[command.id],
    proof: evidence,
  }, null, 2));
}

type EvidenceRef = { command_id: string; action_id: string; guardian_nonce: string };

/**
 * §7-A: the record a failing run needs, read from the run that is already failing.
 *
 * The case asserts two things in order - the process is gone, then the tree was proven dead - and both
 * assertions sit *upstream* of the read that would explain them, so the run that would answer the
 * question is the one run that cannot reach the answer. This reads it anyway. The fresh probe is the
 * part the ruling's open question turns on: a record saying `DEAD` beside a pid that is alive again is
 * what a reused pid looks like, and without both readings the two cannot be told apart.
 *
 * Every read here is guarded, the liveness probe included. A diagnostic that throws would replace the
 * failure it was written to explain, and a substituted error is worse than no diagnostic at all: it
 * would send the reader after a fault in the instrument.
 */
async function explainTree(pid: number | undefined, runtime: string, identity: EvidenceRef) {
  const read = (body: () => unknown) => { try { return body(); } catch (error) { return { 'read_error': (error as { code?: string }).code ?? String(error) }; } };
  read(() => console.log('[§7-A] failure diagnostics: ' + JSON.stringify({
    guardian_pid: pid, pid_alive_now: read(() => isProcessAlive(pid)), record: read(() => readClosureEvidence(runtime, identity)),
  }, null, 2)));
}
/**
 * §7-A: runs an assertion, and when it fails records the process facts before rethrowing the original
 * error unchanged. The error is rethrown rather than replaced, so the case still fails exactly where it
 * failed before - this adds an explanation, not a verdict.
 */
async function withTreeDiagnostics<T>(pid: number | undefined, runtime: string, identity: EvidenceRef, body: () => Promise<T>): Promise<T> {
  try { return await body(); } catch (error) {
    try { await explainTree(pid, runtime, identity); } catch (diagnostic) { console.log('[§7-A] diagnostics themselves failed: ' + String(diagnostic)); }
    throw error;
  }
}

/**
 * §8-G: the flush, observed. The assertion is unchanged - `true` or the case fails - so nothing here
 * widens what the batch accepts; it only makes a refusal legible when it happens.
 *
 * The controller is wrapped rather than replaced, so the flush talks to the real endpoints and every
 * call it makes is recorded on the way past - a refusal is only placeable if the sequence that led to
 * it is known. The wrapper rethrows untouched, so the real refusal still propagates as itself.
 */
async function flushObserved(command: AgentCommand, runtime: string, journal: Record<string, JournalEntry>, identity: { command_id: string; action_id: string; guardian_nonce: string }) {
  const { wrapped, log } = recordingController();
  const flushed = await flushActionJournal(runtime, journal, () => {}, wrapped);
  if (!flushed) {
    try { await flushDiagnostics(command, runtime, journal, identity, log); } catch (diagnostic) { console.log('[§8-G] diagnostics themselves failed: ' + String(diagnostic)); }
  }
  return flushed;
}

it('reads actual Inbox DOM, sends one browser WhatsApp invitation, persists the receipt and deduplicates the later echo', async () => {
  const h = await setup(false, true); await seedDestination(h.account_id); await scan(h.environment_id); const id = await conversation(h.account_id);
  const input = { ...reply(), body: '', refer_whatsapp: true }, queued = await sendConversationReply(scope, id, input);
  expect(await sendConversationReply(scope, id, input)).toMatchObject({ action_id: queued.action_id });
  expect((await conversationReception(scope, id)).referrals[0].state).toBe('QUEUED');
  const command = await claimLead(); expect(command.snapshot).toMatchObject({ capability_key: 'kff.fixture.messenger.reply.browser', message: { browser: { thread_id: '000777', peer_id: '999888777666555', last_seen_message_id: h.event.message.message_id } } });
  const { report } = await finish(command); expect(report.outcome).toBe('VERIFIED_SUCCEEDED');
  expect(report.receipt).toMatchObject({ thread_id: '000777', recipient_id: '999888777666555', content_hash: digest(command.snapshot.body) });
  await acceptReport(agent, report); expect(await receipts(command.action_id)).toHaveLength(1);
  let detail = await inboxConversation(scope, id); expect(detail.outbound_available).toBe(true); expect(detail.messages.filter(row => row.direction === 'OUTBOUND')).toHaveLength(1);
  // The same fixture event survives a server restart before the next visible-page poll.
  await fixture.close(); fixture = await startFixtureServer(0, storage); useOrigin(); await scan(h.environment_id);
  detail = await inboxConversation(scope, id); expect(detail.messages.filter(row => row.direction === 'OUTBOUND')).toHaveLength(1); expect(detail.messages.filter(row => row.direction === 'EXTERNAL_OUTBOUND')).toHaveLength(0);
  const referral = (await conversationReception(scope, id)).referrals[0]; expect(referral.state).toBe('REFERRED');
  await referralResult(scope, referral.id, { request_id: randomUUID(), expected_version: referral.version, result: 'CONFIRMED', reason: 'Synthetic sales confirmation, not a real WhatsApp contact' });
  expect((await inboxConversation(scope, id)).conversation.lead_status).toBe('HANDOFF_COMPLETE');
}, 90000);

it('retains an unknown browser submission, rejects the wrong thread or peer and reconciles the original message once', async () => {
  const h = await setup(), id = await conversation(h.account_id), queued = await sendConversationReply(scope, id, { ...reply(), fixture_scenario: 'lost_after_submit' });
  const command = await claimLead(), { report } = await finish(command); expect(report.outcome).toBe('UNKNOWN_OUTCOME');
  await expect(sendConversationReply(scope, id, reply(2))).rejects.toMatchObject({ code: 'MESSAGE_IN_FLIGHT' });
  const observed = await receipts(command.action_id); expect(observed).toHaveLength(1);
  for (const changed of [{ thread_id: 'different' }, { recipient_id: '123' }]) expect((await reconcileSynthetic(scope, queued.run_id, async () => [{ ...observed[0], ...changed }])).reconciled).toBe(false);
  expect((await reconcileSynthetic(scope, queued.run_id, async () => observed)).reconciled).toBe(true);
  expect((await reconcileSynthetic(scope, queued.run_id, async () => observed)).reconciled).toBe(true);
  await releaseQuarantine(scope, queued.run_id);
  expect((await inboxConversation(scope, id)).messages.filter(row => row.direction === 'OUTBOUND')).toHaveLength(1);
  const duplicate = await fetch(fixture.origin + '/browser-message-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: h.page, action_id: command.action_id, thread_id: '000777', peer_id: '999888777666555', last_seen_message_id: observed[0].id, body: command.snapshot.body }) });
  expect(duplicate.status).toBe(409); expect(await receipts(command.action_id)).toHaveLength(1); expect((await query('SELECT count(*)::int AS n FROM kff.actions'))[0].n).toBe(1);
}, 60000);

it.each(['wrong_account', 'login_expired', 'duplicate_control', 'new-visible-message'] as const)('blocks %s before a persisted submit intention or browser write', async scenario => {
  const h = await setup(), id = await conversation(h.account_id); await sendConversationReply(scope, id, { ...reply(), fixture_scenario: scenario === 'new-visible-message' ? 'normal' : scenario });
  const command = await claimLead(); if (scenario === 'new-visible-message') await postEvent(h.page, 'A newer question visible before KFF has polled it');
  const { report } = await finish(command); expect(['BLOCKED', 'NEEDS_HUMAN']).toContain(report.outcome); expect(await receipts(command.action_id)).toHaveLength(0);
  expect((await query('SELECT submitted_at FROM kff.action_attempts WHERE id=$1', [command.attempt_id]))[0].submitted_at).toBeNull();
}, 45000);

it.each(['new-inbound', 'transport-change'] as const)('invalidates a claimed reply on %s through the shared submit gate', async change => {
  const h = await setup(), id = await conversation(h.account_id); await sendConversationReply(scope, id, reply()); const command = await claimLead();
  if (change === 'transport-change') await configureFacebook(scope, { ...h.config, request_id: randomUUID(), expected_version: 2, transport: 'API' });
  else { const event = await postEvent(h.page, 'Please answer this newer question'); await ingestBrowserBatch(scope, h.binding, { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: h.binding.environment.configuration.login_account_id, operating_identity_id: h.page, observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: [event.message] }); }
  await expect(beginSubmission(agent, command.id)).rejects.toMatchObject({ code: change === 'new-inbound' ? 'INBOUND_SUPERSEDED' : 'RECEPTION_CONFIG_STALE' });
  const { report } = await finish(command); expect(['CANCELED', 'BLOCKED']).toContain(report.outcome); expect(await receipts(command.action_id)).toHaveLength(0);
}, 45000);

it('uses the existing AI preparation queue for browser replies and respects human takeover of a later prepared reply', async () => {
  const h = await setup(true), id = await conversation(h.account_id); await processReceptionOne();
  const command = await claimLead(); expect(command.snapshot.message?.actor_kind).toBe('AI'); expect(command.snapshot.message?.browser?.thread_id).toBe('000777');
  expect((await finish(command)).report.outcome).toBe('VERIFIED_SUCCEEDED');
  const event = await postEvent(h.page, 'Hello again'); await ingestBrowserBatch(scope, h.binding, { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: h.binding.environment.configuration.login_account_id, operating_identity_id: h.page, observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: [event.message] });
  await processReceptionOne(); const later = await claimLead(), detail = await inboxConversation(scope, id);
  await conversationControl(scope, id, { request_id: randomUUID(), expected_version: detail.conversation.control_version, mode: 'HUMAN', reason: 'Operator takes the synthetic browser conversation' });
  await expect(beginSubmission(agent, later.id)).rejects.toMatchObject({ code: 'CONVERSATION_STALE' }); expect(await receipts(later.action_id)).toHaveLength(0);
}, 60000);

it('requires both thread and peer for human review of an unknown browser message', async () => {
  const h = await setup(), id = await conversation(h.account_id), queued = await sendConversationReply(scope, id, { ...reply(), fixture_scenario: 'lost_after_submit' });
  const command = await claimLead(); expect((await finish(command)).report.outcome).toBe('UNKNOWN_OUTCOME'); const observed = (await receipts(command.action_id))[0];
  const input = { request_id: randomUUID(), snapshot_hash: command.snapshot_hash, expected_version: 0, expected_state: 'UNKNOWN_OUTCOME' as const, decision: 'CONFIRMED_SUCCESS' as const, evidence: { source: 'owned_fixture' as const, external_account_id: h.page, recipient_id: command.snapshot.message!.browser!.peer_id, thread_id: '000777', content_hash: command.snapshot.content_hash, remote_id: String(observed.id), observed_at: new Date().toISOString(), reference: 'Review of persisted local synthetic browser event', failure_basis: null, matched_original_submission: true }, reason: 'Reviewed the original local browser send and exact conversation', confirmation: 'I_REVIEWED_THIS_ORIGINAL_ACTION' as const };
  await expect(adjudicateAction(scope, queued.run_id, { ...input, evidence: { ...input.evidence, thread_id: 'different' } })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  await adjudicateAction(scope, queued.run_id, input); expect((await query('SELECT receipt FROM kff.actions WHERE id=$1', [command.action_id]))[0].receipt.thread_id).toBe('000777');
  expect((JSON.parse(await readFile(path.join(storage, 'fixture-browser-messages.json'), 'utf8')) as BrowserFixtureEvent[]).filter(row => row.action_id === command.action_id)).toHaveLength(1);
}, 60000);

/**
 * The one path that can leave a real write genuinely unknowable. The guardian is a real child running
 * the real browser adapter against the real fixture: it opens a real context, reaches the submission
 * boundary, and the controller really records the submit intention. Only then does it stop making
 * progress, so afterwards nobody can say whether the platform write happened - and the whole point of
 * the record is that it says exactly that much and nothing more.
 */
it('ends a guardian that stopped answering while it held submission authority, and keeps the unknown outcome isolated', async () => {
  const h = await setup(), id = await conversation(h.account_id);
  await sendConversationReply(scope, id, reply());
  const command = await claimLead();
  const runtime = path.join(storage, '.kff', 'agent-process-tests', 'granting');
  await mkdir(runtime, { recursive: true });
  const value = randomBytes(32).toString('hex');
  // The child only arms the stall for a runtime inside `<KFF_ROOT>/.kff/agent-process-tests/`, so the
  // real root is moved onto this test's throwaway directory for the length of the run - which also
  // keeps the browser profile it launches inside that directory - and restored immediately after.
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['NODE_ENV', environment.NODE_ENV], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT]] as const;
  environment.KFF_ROOT = storage; environment.NODE_ENV = 'test'; environment.KFF_TEST_GUARDIAN_HANG_AT = 'before-grant';
  const journal: Record<string, JournalEntry> = {};
  journal[command.id] = { command_id: command.id, action_id: command.action_id, phase: 'claimed', guardian_nonce: value };
  let guardian: number | undefined;
  try {
    await expect(runGuardian(command, runtime, value, {
      signal: new AbortController().signal,
      onSpawn: spawned => { guardian = spawned; journal[command.id].guardian_pid = spawned; },
      onContextOpened: async () => { journal[command.id].phase = 'context_open'; if (command.snapshot.browser_environment) await recordBrowserOpened(agent, command.id); },
      // The journal reaches `submitting` because the real controller call really happened. The phase
      // the parent observed is still `granting`, because the grant it decided on was never delivered.
      beforeSubmit: async () => { journal[command.id].phase = 'intent_requested'; await beginSubmission(agent, command.id); journal[command.id].phase = 'submitting'; return new Promise(() => {}); },
      liveness: liveness('granting'),
    })).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  } finally { for (const [key, stored] of previous) { if (stored === undefined) delete environment[key]; else environment[key] = stored; } }
  expect(guardian).toBeGreaterThan(0);
  const identity = { command_id: command.id, action_id: command.action_id, guardian_nonce: value };
  await withTreeDiagnostics(guardian, runtime, identity, () => expect.poll(() => isProcessAlive(guardian), { timeout: 10000 }).toBe(false));
  // Three facts, recorded as three facts: the process is proven gone, a context really was opened, and
  // whether the platform write happened is precisely what nobody can answer any more. There is no
  // `context_closed` to read, because ending a process never closes anything.
  const record = readClosureEvidence(runtime, identity);
  await withTreeDiagnostics(guardian, runtime, identity, async () => expect(record).toMatchObject({
    protocol_version: noProgressProtocolVersion, command_id: command.id, action_id: command.action_id, nonce: value,
    phase: 'granting', context_opened: true, submission_state: 'UNKNOWN', forced: true, grace_ms: 1000,
    // What the parent proved about the process is a three-state fact with its observations, not the
    // boolean this file used to assert. The tree here really was enumerated and really was killed, and
    // the probes afterwards are what let the command be completed at all - so the state is asserted,
    // not tolerated: `UNKNOWN` or `ALIVE` would leave the command unfinished and the environment
    // isolated, which the assertions below depend on.
    termination: { process_tree: 'DEAD', root: 'DEAD', descendants: 'DEAD', enumeration: 'LISTED', tool: expect.any(String), sampled: expect.any(Number), elapsed_ms: expect.any(Number) },
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' },
  }));
  expect(record).not.toHaveProperty('context_closed');
  expect((record as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(1500);
  // A termination is not a closure, so the weaker record can never be read back as one.
  const asClosure = (() => { try { readClosure(runtime, identity); return 'closed'; } catch (error) { return (error as { code?: string }).code; } })();
  expect(asClosure).toBe('GUARDIAN_UNCONFIRMED');
  // The real flush against the real controller: the same three endpoints `main.ts` uses.
  expect(await flushObserved(command, runtime, journal, identity)).toBe(true);
  // The parent's own record said NEEDS_HUMAN. The action state is what corrects it: a persisted submit
  // intention means nobody may be told this was harmless, so what actually leaves the machine is
  // UNKNOWN_OUTCOME - never CANCELED and never VERIFIED_FAILED.
  expect(journal[command.id].report).toMatchObject({ outcome: 'UNKNOWN_OUTCOME', error_code: 'GUARDIAN_NO_PROGRESS' });
  expect(journal[command.id].quiesced).toBe(true);
  expect((await query('SELECT state,error_code FROM kff.actions WHERE id=$1', [command.action_id]))[0]).toEqual({ state: 'UNKNOWN_OUTCOME', error_code: 'GUARDIAN_NO_PROGRESS' });
  const stored = (await query('SELECT state,quiesced_at FROM kff.agent_commands WHERE id=$1', [command.id]))[0];
  expect(stored.state).toBe('DONE'); expect(stored.quiesced_at).not.toBeNull();
  // The command lifecycle closed, so the slot is free - and the environment is still isolated, still
  // reporting the browser it was really running: a termination proves nothing about that browser, so
  // nothing here may project it as closed.
  expect(await query("SELECT 1 FROM kff.agent_commands WHERE agent_id=$1 AND state IN ('READY','CLAIMED')", [agent.id])).toHaveLength(0);
  expect((await query('SELECT state,browser_status FROM kff.environments WHERE id=$1', [h.environment_id]))[0]).toEqual({ state: 'QUARANTINED', browser_status: 'RUNNING' });
  const leases = await query<{ resource_type: string; quarantined: boolean }>('SELECT resource_type,quarantined FROM kff.resource_leases WHERE holder_attempt_id=$1 ORDER BY resource_type', [command.attempt_id]);
  expect(leases.map(lease => lease.resource_type)).toEqual(['account', 'environment']);
  expect(leases.every(lease => lease.quarantined)).toBe(true);
  expect((await query('SELECT r.status AS run_status,t.status AS task_status FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id WHERE r.id=$1', [command.run_id]))[0]).toEqual({ run_status: 'NEEDS_HUMAN', task_status: 'NEEDS_HUMAN' });
  // One attempt, one report, one command for this action: the terminated run is never resent.
  expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [command.action_id]))[0].n).toBe(1);
  expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE event_type='action.reported' AND object_id=$1", [command.action_id]))[0].n).toBe(1);
  expect((await query('SELECT count(*)::int AS n FROM kff.agent_commands WHERE action_id=$1', [command.action_id]))[0].n).toBe(1);
  // The same terminal outcome reported without the no-progress fact does hand the environment back, so
  // the isolation above comes from what the record proves rather than from a failure in general.
  const h2 = await setup();
  await sendConversationReply(scope, await conversation(h2.account_id), reply());
  const other = await claimLead();
  const held = await query<{ resource_id: string }>('SELECT resource_id FROM kff.resource_leases WHERE holder_attempt_id=$1', [other.attempt_id]);
  expect(held.length).toBeGreaterThan(0);
  await acceptReport(agent, { event_id: randomUUID(), command_id: other.id, outcome: 'NEEDS_HUMAN', error_code: 'EXECUTOR_ERROR', diagnostic: { step: 'executor-failed' } });
  expect((await query('SELECT state FROM kff.environments WHERE id=$1', [h2.environment_id]))[0].state).toBe('IDLE');
  for (const lease of held) expect((await query('SELECT quarantined FROM kff.resource_leases WHERE resource_id=$1', [lease.resource_id])).every(row => row.quarantined === false)).toBe(true);
}, 90000);

it('ends a child that went silent just after it opened a real browser, and never records that browser as closed', async () => {
  const h = await setup(), id = await conversation(h.account_id);
  await sendConversationReply(scope, id, reply());
  const command = await claimLead();
  // The premise of this case: the command really drives a browser, so the child really opens one and
  // really reports it. Nothing about the stall below is simulated at the parent's side of the wire.
  expect(command.snapshot.browser_environment).toBeTruthy();
  const runtime = path.join(storage, '.kff', 'agent-process-tests', 'intent');
  await mkdir(runtime, { recursive: true });
  const value = randomBytes(32).toString('hex');
  const environment = process.env as Record<string, string | undefined>;
  const previous = [['KFF_ROOT', environment.KFF_ROOT], ['NODE_ENV', environment.NODE_ENV], ['KFF_TEST_GUARDIAN_HANG_AT', environment.KFF_TEST_GUARDIAN_HANG_AT]] as const;
  environment.KFF_ROOT = storage; environment.NODE_ENV = 'test'; environment.KFF_TEST_GUARDIAN_HANG_AT = 'after-context';
  const journal: Record<string, JournalEntry> = {};
  journal[command.id] = { command_id: command.id, action_id: command.action_id, phase: 'claimed', guardian_nonce: value };
  let guardian: number | undefined, intentRequested = false;
  try {
    await expect(runGuardian(command, runtime, value, {
      signal: new AbortController().signal,
      onSpawn: spawned => { guardian = spawned; journal[command.id].guardian_pid = spawned; },
      // The parent only sets this phase because it really received `context-opened` from the child.
      onContextOpened: async () => { journal[command.id].phase = 'context_open'; await recordBrowserOpened(agent, command.id); },
      beforeSubmit: async () => { intentRequested = true; },
      liveness: liveness('awaiting-intent'),
    })).rejects.toMatchObject({ code: 'GUARDIAN_NO_PROGRESS' });
  } finally { for (const [key, stored] of previous) { if (stored === undefined) delete environment[key]; else environment[key] = stored; } }
  // A child frozen inside the callback that opens the context never asks to submit, so this run never
  // held submission authority at any point.
  expect(intentRequested).toBe(false);
  expect(guardian).toBeGreaterThan(0);
  const identity = { command_id: command.id, action_id: command.action_id, guardian_nonce: value };
  await withTreeDiagnostics(guardian, runtime, identity, () => expect.poll(() => isProcessAlive(guardian), { timeout: 10000 }).toBe(false));
  const record = readClosureEvidence(runtime, identity);
  // Three separate facts, recorded as three separate facts: the process is gone, the context really
  // opened, and no submission was ever attempted. A termination proves only the first of them.
  await withTreeDiagnostics(guardian, runtime, identity, async () => expect(record).toMatchObject({ protocol_version: noProgressProtocolVersion, command_id: command.id, action_id: command.action_id, nonce: value,
    phase: 'awaiting-intent', context_opened: true, submission_state: 'NOT_SUBMITTED', forced: true, grace_ms: 1000,
    // Same three-state fact as the case above: the process tree was enumerated, killed, and probed.
    termination: { process_tree: 'DEAD', root: 'DEAD', descendants: 'DEAD', enumeration: 'LISTED', tool: expect.any(String), sampled: expect.any(Number), elapsed_ms: expect.any(Number) },
    result: { outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' } }));
  expect(record).not.toHaveProperty('context_closed');
  expect((record as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(1500);
  const asClosure = (() => { try { readClosure(runtime, identity); return 'closed'; } catch (error) { return (error as { code?: string }).code; } })();
  expect(asClosure).toBe('GUARDIAN_UNCONFIRMED');
  expect(await flushObserved(command, runtime, journal, identity)).toBe(true);
  // The action never left PREPARING, so the outcome the parent recorded stands: the run is handed to a
  // human, and the browser it had really opened is not written off as closed.
  expect(journal[command.id].report).toMatchObject({ outcome: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' });
  expect(journal[command.id].quiesced).toBe(true);
  expect((await query('SELECT state,error_code FROM kff.actions WHERE id=$1', [command.action_id]))[0]).toEqual({ state: 'NEEDS_HUMAN', error_code: 'GUARDIAN_NO_PROGRESS' });
  const stored = (await query('SELECT state,quiesced_at FROM kff.agent_commands WHERE id=$1', [command.id]))[0];
  expect(stored.state).toBe('DONE'); expect(stored.quiesced_at).not.toBeNull();
  expect(await query("SELECT 1 FROM kff.agent_commands WHERE agent_id=$1 AND state IN ('READY','CLAIMED')", [agent.id])).toHaveLength(0);
  // A real context was open and nothing proves it was closed, so it is not projected as closed.
  expect((await query('SELECT state,browser_status FROM kff.environments WHERE id=$1', [h.environment_id]))[0]).toEqual({ state: 'QUARANTINED', browser_status: 'RUNNING' });
  const leases = await query<{ resource_type: string; quarantined: boolean }>('SELECT resource_type,quarantined FROM kff.resource_leases WHERE holder_attempt_id=$1 ORDER BY resource_type', [command.attempt_id]);
  expect(leases.map(lease => lease.resource_type)).toEqual(['account', 'environment']);
  expect(leases.every(lease => lease.quarantined)).toBe(true);
  expect((await query('SELECT r.status AS run_status,t.status AS task_status FROM kff.runs r JOIN kff.tasks t ON t.id=r.task_id WHERE r.id=$1', [command.run_id]))[0]).toEqual({ run_status: 'NEEDS_HUMAN', task_status: 'NEEDS_HUMAN' });
  expect((await query('SELECT count(*)::int AS n FROM kff.action_attempts WHERE action_id=$1', [command.action_id]))[0].n).toBe(1);
  expect((await query("SELECT count(*)::int AS n FROM kff.audit_events WHERE event_type='action.reported' AND object_id=$1", [command.action_id]))[0].n).toBe(1);
  expect((await query('SELECT count(*)::int AS n FROM kff.agent_commands WHERE action_id=$1', [command.action_id]))[0].n).toBe(1);
}, 90000);
