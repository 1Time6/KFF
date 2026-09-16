import { it, expect } from 'vitest';
import { resultInput } from '../../packages/contracts/src/index';
import { browserInboxDiscoverySummary } from '../../packages/contracts/src/browser-inbox';
import { inboxDiscoveryDiagnostic } from '../../packages/adapters/src/facebook-browser-inbox';

// Three conversations that each failed for their own local reason: a timeout while reading the
// conversation, a label conflict on the verified peer, and a sender that could not be verified.
const failedWindow = {
  strategy: 'RECENT_ACCEPTED' as const, visible_threads: 3, unparsed_rows: 0,
  threads: [], window_limited: true, empty_list: false,
  skipped: [
    { thread_id: '00456', reason: 'THREAD_WINDOW_UNAVAILABLE' as const, failure: { stage: 'facebook-inbox-load' as const, code: 'TIMEOUT' as const } },
    { thread_id: '00789', reason: 'THREAD_IDENTITY_UNVERIFIED' as const, failure: { stage: 'facebook-inbox-directory-identity' as const, code: 'THREAD_IDENTITY_UNVERIFIED' as const } },
    { thread_id: '00999', reason: 'THREAD_INPUT_FOREIGN' as const, failure: { stage: 'facebook-inbox-directory-composer' as const, code: 'THREAD_INPUT_FOREIGN' as const }, composer_surface: { stage: 'facebook-inbox-directory-composer' as const, candidate_count: 1, label_kind: 'NAMED_PREFIX' as const, label_length: 20, placeholder: false, reachable: true, hit_target: false, role: 'textbox' as const, contenteditable: true } },
  ],
  coverage: { threads_attempted: 3, threads_read: 0, threads_skipped: 0, threads_failed: 3 },
};
const summary = browserInboxDiscoverySummary.parse(failedWindow);
const blocked = (discovery: unknown = summary) => Object.assign(new Error('当前窗口没有可核实的已接受会话；需要人工查看，不认定没有消息'), { code: 'INBOX_WINDOW_UNAVAILABLE', discovery });

const report = (diagnostic: unknown) => ({ event_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15eb', command_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15ec', outcome: 'BLOCKED', error_code: 'INBOX_WINDOW_UNAVAILABLE', diagnostic });

// A window that fails closed used to return only a step, an error kind and a truncated message, so
// the per-conversation reasons it had already collected were lost at the adapter boundary.
it('returns every per-conversation reason when a whole window fails to read', () => {
  const diagnostic = inboxDiscoveryDiagnostic(blocked());
  expect(diagnostic.inbox_discovery?.skipped.map(s => [s.thread_id, s.reason, s.failure?.code])).toEqual([
    ['00456', 'THREAD_WINDOW_UNAVAILABLE', 'TIMEOUT'],
    ['00789', 'THREAD_IDENTITY_UNVERIFIED', 'THREAD_IDENTITY_UNVERIFIED'],
    ['00999', 'THREAD_INPUT_FOREIGN', 'THREAD_INPUT_FOREIGN'],
  ]);
  // The failed window stays a failure: it is never dressed up as a successful empty Inbox.
  expect(diagnostic.inbox_discovery).toMatchObject({ window_limited: true, empty_list: false, threads: [] });
  expect(resultInput.parse(report({ step: 'facebook-inbox-read', error_kind: 'INBOX_WINDOW_UNAVAILABLE', ...diagnostic })).diagnostic.inbox_discovery?.coverage).toEqual({ threads_attempted: 3, threads_read: 0, threads_skipped: 0, threads_failed: 3 });
});

// The diagnostic is a bounded contract, not a passthrough. Raw page text, message bodies, provider
// output and selector strings must not survive it, and an unvalidated object is dropped entirely.
it('carries only the validated observation and never raw page or provider content', () => {
  expect(inboxDiscoveryDiagnostic(blocked())).not.toHaveProperty('error_message');
  expect(JSON.stringify(inboxDiscoveryDiagnostic(blocked()))).not.toMatch(/message_body|Original inquiry|Cookie|Bearer/);
  // A summary that a client tried to widen with free text fails validation and is dropped.
  const widened = { ...failedWindow, note: 'original inquiry text from the page' };
  expect(inboxDiscoveryDiagnostic(blocked(widened))).toEqual({});
  // A body carried inside a skipped entry is refused by the same bounded contract.
  const withBody = { ...failedWindow, skipped: [{ thread_id: '00456', reason: 'THREAD_WINDOW_UNAVAILABLE', failure: { stage: 'facebook-inbox-load', code: 'TIMEOUT' }, body: 'Original inquiry' }] };
  expect(inboxDiscoveryDiagnostic(blocked(withBody))).toEqual({});
  // An error without an attached window keeps the old behaviour instead of inventing evidence.
  expect(inboxDiscoveryDiagnostic(new Error('no discovery attached'))).toEqual({});
  expect(inboxDiscoveryDiagnostic(undefined)).toEqual({});
});

// The diagnostic field is part of the report contract, so a smuggled field is refused at the
// boundary rather than silently accepted.
it('refuses a failure report whose discovery evidence does not satisfy the contract', () => {
  expect(resultInput.safeParse(report({ step: 'facebook-inbox-read', inbox_discovery: { ...failedWindow, threads: [{ thread_id: '1', peer_id: '2', display_name: 'x', read: false, read_only_reason: 'THREAD_COMPOSER_ABSENT' }] } })).success).toBe(false);
  expect(resultInput.safeParse(report({ step: 'facebook-inbox-read', inbox_discovery: { ...failedWindow, raw_page: '<div>anything</div>' } })).success).toBe(false);
  expect(resultInput.safeParse(report({ step: 'facebook-inbox-read', inbox_discovery: summary })).success).toBe(true);
});
