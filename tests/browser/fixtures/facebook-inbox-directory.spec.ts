import { test, expect } from '@playwright/test';
import { inspectFacebookInboxComposerDom, inspectFacebookInboxHeaderDom } from '../../../packages/adapters/src/facebook-inbox-directory-dom';
import { readFacebookInboxDirectory, readFacebookInboxThread } from '../../../packages/adapters/src/facebook-browser-inbox';
import type { BrowserInboxTask } from '../../../packages/contracts/src/browser-inbox';
import { browserInboxPage } from '../../../packages/contracts/src/browser-inbox';

const expected = { thread_id: '9988', display_name: 'Facebook 用户' };
const source = 'https://www.facebook.com/messages/e2ee/t/9988/';

test('resolves an initial placeholder only after a unique numeric header and real name appear', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><h3>Facebook 用户</h3></main>' }));
  await page.goto(source);
  expect(await page.evaluate(inspectFacebookInboxHeaderDom, expected)).toBeNull();
  await page.setContent('<main><a href="/1122/"><h3>Peer Fullname</h3></a></main>');
  expect(await page.evaluate(inspectFacebookInboxHeaderDom, expected)).toEqual({ thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname' });
});

for (const [name, html, label, url] of [
  ['name without a profile', '<h3>Peer Fullname</h3>', 'Facebook 用户', source],
  ['placeholder with a profile', '<a href="/1122/"><h3>Facebook 用户</h3></a>', 'Facebook 用户', source],
  ['nonnumeric profile', '<a href="/peer.name/"><h3>Peer Fullname</h3></a>', 'Facebook 用户', source],
  ['two numeric profiles', '<a href="/1122/"><h3>Peer Fullname</h3></a><a href="/3344/"><h3>Peer Fullname</h3></a>', 'Facebook 用户', source],
  ['different established name', '<a href="/1122/"><h3>Peer Fullname</h3></a>', 'Another Person', source],
  ['different thread', '<a href="/1122/"><h3>Peer Fullname</h3></a>', 'Facebook 用户', 'https://www.facebook.com/messages/e2ee/t/7777/'],
  ['external profile', '<a href="https://example.org/1122/"><h3>Peer Fullname</h3></a>', 'Facebook 用户', source],
  ['profile inside message log', '<div role="log"><a href="/1122/"><h3>Peer Fullname</h3></a></div>', 'Facebook 用户', source],
] as const) {
  test('keeps placeholder resolution closed for ' + name, async ({ page }) => {
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main>' + html + '</main>' }));
    await page.goto(url);
    expect(await page.evaluate(inspectFacebookInboxHeaderDom, { ...expected, display_name: label })).toBeNull();
  });
}

for (const alreadyHydrated of [false, true]) {
test('original directory reader verifies the ' + (alreadyHydrated ? 'already hydrated' : 'delayed') + ' header against the incoming avatar', async ({ page }) => {
  const directory = '<nav aria-label="对话列表"><div role="tab" aria-selected="true">全部</div><div role="grid" aria-label="聊天"><div role="row"><a href="/messages/e2ee/t/9988/">Facebook 用户</a><button aria-label="Facebook 用户的更多选项">更多</button></div></div></nav>';
  const thread = '<main><div id="header"><h3>Facebook 用户</h3></div><div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div><div role="log" aria-label="与Peer Fullname的对话中的消息"><div role="article"><div data-message-id="incoming.1" aria-label="03:57，Peer Fullname：Original inquiry"><div dir="auto">Original inquiry</div><div role="button" aria-haspopup="dialog" style="width:30px;height:30px" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<a role=menuitem href=/1122/>查看个人主页</a>\');document.body.dataset.avatarVerified=\'yes\'"><span aria-hidden="true"><img alt="Peer Fullname" style="width:20px;height:20px"></span></div></div></div></div></main><script>setTimeout(()=>document.querySelector("#header").innerHTML=\'<a href="/1122/"><h3>Peer Fullname</h3></a>\',750);document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelector("[role=menuitem]")?.remove()})</script>';
  const content = alreadyHydrated ? thread.replace('<div id="header"><h3>Facebook 用户</h3></div>', '<div id="header"><a href="/1122/"><h3>Peer Fullname</h3></a></div>') : thread;
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: directory + (route.request().url().includes('/e2ee/') ? content : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const result = await readFacebookInboxDirectory(page, request, () => {});
  expect(result.discovery.threads).toMatchObject([{ thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname', read: true, message_count: 1 }]);
  expect(result.discovery.skipped).toEqual([]);
  expect(result.messages.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
  expect(await page.locator('body').getAttribute('data-avatar-verified')).toBe('yes');
});
}

const composerDirectory = (label = 'Facebook 用户') => '<nav aria-label="对话列表"><div role="tab" aria-selected="true">全部</div><div role="grid" aria-label="聊天"><div role="row"><a href="/messages/e2ee/t/9988/">' + label + '</a><button aria-label="' + label + '的更多选项">更多</button></div></div></nav>';
const composerMessage = '<div role="article"><div data-message-id="incoming.1" aria-label="03:57，Peer Fullname：Original inquiry"><div dir="auto">Original inquiry</div><div role="button" aria-haspopup="dialog" style="width:30px;height:30px" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<a role=menuitem href=/1122/>查看个人主页</a>\');document.body.dataset.avatarVerified=\'yes\'"><span aria-hidden="true"><img alt="Peer Fullname" style="width:20px;height:20px"></span></div></div></div>';
const composerKeyboard = '<script>document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelector("[role=menuitem]")?.remove()})</script>';
const composerThread = (composer: string) => '<main><div id="header"><a href="/1122/"><h3>Peer Fullname</h3></a></div>' + composer + '<div role="log" aria-label="与Peer Fullname的对话中的消息">' + composerMessage + '</div></main>' + composerKeyboard;
// A verified thread without any input box. The read-only path still requires the unique numeric
// header and the message log that names exactly that peer; a log naming somebody else is refused.
const readOnlyThread = (logName = 'Peer Fullname', header = '<a href="/1122/"><h3>Peer Fullname</h3></a>') => '<main><div id="header">' + header + '</div><div role="log" aria-label="与' + logName + '的对话中的消息">' + composerMessage + '</div></main>' + composerKeyboard;

// The exact label is preferred, not required, but "any 发消息给…" is not evidence:
// a bare prefix, the placeholder itself, a search box, or another person's name while
// the directory already shows a real name are all refused. Every case keeps its
// fact-only observation, including the zero-input case.
for (const [name, composer, identity, expected, directoryLabel] of [
  ['a composer labelled with the resolved name', '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>', '9999', { composer: 'EXACT_NAME', composer_length: 17, surface: 'EXACT_NAME', surface_length: 17, candidates: 1, readable: true }, 'Facebook 用户'],
  ['a composer whose label exactly equals the resolved name', '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>', '9999', { composer: 'EXACT_NAME', composer_length: 17, surface: 'EXACT_NAME', surface_length: 17, candidates: 1, readable: true }, 'Peer Fullname'],
  ['a composer that only repeats the directory placeholder', '<div role="textbox" aria-label="发消息给Facebook 用户" contenteditable="true"></div>', '9999', { composer: null, composer_length: null, surface: 'NAMED_PREFIX', surface_length: 15, candidates: 1, readable: false, reason: 'THREAD_COMPOSER_UNVERIFIED' }, 'Facebook 用户'],
  ['a composer without an accepted-chat label', '<div role="textbox" aria-label="搜索" contenteditable="true"></div>', '9999', { composer: null, composer_length: null, surface: 'OTHER', surface_length: 2, candidates: 1, readable: false, reason: 'THREAD_INPUT_FOREIGN' }, 'Facebook 用户'],
  ['a bare send-message label that names nobody', '<div role="textbox" aria-label="发消息给" contenteditable="true"></div>', '9999', { composer: null, composer_length: null, surface: 'BARE_PREFIX', surface_length: 4, candidates: 1, readable: false, reason: 'THREAD_INPUT_FOREIGN' }, 'Peer Fullname'],
  ['a disabled composer', '<div role="textbox" aria-label="发消息给Peer Fullname" aria-disabled="true" contenteditable="true"></div>', '9999', { composer: 'EXACT_NAME', composer_length: 17, surface: 'EXACT_NAME', surface_length: 17, candidates: 1, readable: false, reason: 'THREAD_INPUT_UNUSABLE' }, 'Facebook 用户'],
  // A composer that exists but names somebody else (here the operating account itself) is a
  // contradictory page state, so the conversation stays unread: no read-only bypass.
  ['a composer that names the operating account', '<div role="textbox" aria-label="发消息给XiangHuan Master" contenteditable="true"></div>', 'XiangHuan Master', { composer: null, composer_length: null, surface: 'NAMED_PREFIX', surface_length: 20, candidates: 1, readable: false, reason: 'THREAD_INPUT_FOREIGN' }, 'Facebook 用户'],
] as const) {
  test('composer resolution reports ' + name, async ({ page }) => {
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory(directoryLabel) + (route.request().url().includes('/e2ee/') ? composerThread(composer) : '') }));
    const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: identity } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
    // The directory reader fails closed: a composer it cannot verify is never read.
    let readable = false, skipped: { reason?: string; failure?: { code?: string; stage?: string }; composer_surface?: unknown } | undefined;
    try { const result = await readFacebookInboxDirectory(page, request, () => {}); readable = result.discovery.threads.length === 1; skipped = result.discovery.skipped[0]; }
    catch (error) {
      const failure = error as { code?: string; discovery?: { skipped: typeof skipped[] } };
      expect(failure.code).toBe('INBOX_WINDOW_UNAVAILABLE');
      // A refused window still carries the per-thread observations.
      skipped = failure.discovery?.skipped[0];
    }
    expect(readable).toBe(expected.readable);
    // The caller's rule: the placeholder directory allows the header's name in the label.
    const probe = await page.evaluate(inspectFacebookInboxComposerDom, { display_name: 'Peer Fullname', allow_other_name: directoryLabel === 'Facebook 用户', operating_identity_id: identity });
    expect({
      composer: probe.composer?.kind ?? null, composer_length: probe.composer?.value.length ?? null,
      surface: probe.surface?.label_kind ?? null, surface_length: probe.surface?.label_length ?? null, candidates: probe.candidate_count,
    }).toMatchObject({ composer: expected.composer, composer_length: expected.composer_length, surface: expected.surface, surface_length: expected.surface_length, candidates: expected.candidates });
    if (!expected.readable) {
      expect(skipped?.reason).toBe(expected.reason);
      expect(skipped?.failure?.code).toBe(expected.reason);
      // The observation must survive every failure, including zero candidates.
      expect(skipped?.composer_surface).toMatchObject({ candidate_count: expected.candidates, label_kind: expected.surface, label_length: expected.surface_length });
    }
  });
}

// A contradictory or repeated composer is two observations, not zero. The old reader only
// recorded its single-input observation, so every multi-candidate page fell back to the same
// zero-input object the read-only path keys off. Absence has to stay a fact with one cause.
for (const [name, composer] of [
  ['one correct and one foreign input box',
    '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div><div role="textbox" aria-label="发消息给Someone Else" contenteditable="true"></div>'],
  ['two input boxes with the same accepted label',
    '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div><div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>'],
  ['two input boxes that both name another person',
    '<div role="textbox" aria-label="发消息给Someone Else" contenteditable="true"></div><div role="textbox" aria-label="发消息给Another Person" contenteditable="true"></div>'],
] as const) {
  test('keeps ' + name + ' an observed ambiguity instead of an absent input box', async ({ page }) => {
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory() + (route.request().url().includes('/e2ee/') ? composerThread(composer) : '') }));
    const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
    const failure = await readFacebookInboxDirectory(page, request, () => {}).then(() => null, error => error as { code?: string; discovery?: { skipped: { reason?: string; composer_surface?: { candidate_count?: number; label_kind?: string } }[] } });
    // Two candidates cannot be resolved into one accepted composer, so the conversation stays unread.
    // The window fails closed because it has nothing readable, and the per-conversation record
    // names the real cause (a two-candidate ambiguity) instead of a generic window failure.
    expect(failure?.code).toBe('INBOX_WINDOW_UNAVAILABLE');
    expect(failure?.discovery?.skipped[0]).toMatchObject({ reason: 'THREAD_COMPOSER_AMBIGUOUS', failure: { stage: 'facebook-inbox-directory-composer', code: 'THREAD_COMPOSER_AMBIGUOUS' } });
    // The observation names the real cause: two candidates were seen, not none.
    expect(failure?.discovery?.skipped[0].composer_surface).toMatchObject({ candidate_count: 2 });
    expect(failure?.discovery?.skipped[0].composer_surface?.label_kind).not.toBe('ABSENT');
    // The observation the caller keeps must say the same thing.
    const probe = await page.evaluate(inspectFacebookInboxComposerDom, { display_name: 'Peer Fullname', allow_other_name: true, operating_identity_id: '9999' });
    expect(probe).toMatchObject({ composer: null, candidate_count: 2 });
    expect(probe.surface.label_kind).not.toBe('ABSENT');
  });
}

// Requirement: a verified thread with no input box is not automatically unreadable. The read-only
// path needs the numeric header identity plus the message log that names that same peer, and it
// still verifies every incoming avatar against the header profile.
test('reads a verified thread read-only when no input box appears, and records why', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory() + (route.request().url().includes('/e2ee/') ? readOnlyThread() : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const result = await readFacebookInboxDirectory(page, request, () => {});
  expect(result.discovery.skipped).toEqual([]);
  expect(result.discovery.coverage).toEqual({ threads_attempted: 1, threads_read: 1, threads_skipped: 0, threads_failed: 0 });
  expect(result.discovery.threads).toMatchObject([{ thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname', read: true, message_count: 1, read_only_reason: 'THREAD_COMPOSER_ABSENT' }]);
  expect(result.discovery.threads[0].composer_surface).toMatchObject({ stage: 'facebook-inbox-directory-composer', candidate_count: 0, label_kind: 'ABSENT', label_length: 0, reachable: false, hit_target: false, role: 'none', contenteditable: false });
  expect(result.messages.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
  // The read-only observation is kept for review, and the sender avatar was still verified.
  expect(result.discovery.observed).toMatchObject([{ thread_id: '9988', reason: 'THREAD_COMPOSER_ABSENT', failure: { stage: 'facebook-inbox-directory-composer', code: 'THREAD_COMPOSER_ABSENT' } }]);
  expect(await page.locator('body').getAttribute('data-avatar-verified')).toBe('yes');
});

// The read-only path must not lower the identity bar: a message log that names somebody else than
// the verified header profile leaves the conversation unread and skipped.
test('refuses the read-only path when the message log names another person', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory() + (route.request().url().includes('/e2ee/') ? readOnlyThread('Someone Else') : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const failure = await readFacebookInboxDirectory(page, request, () => {}).then(() => null, error => error as { code?: string; discovery?: { skipped: { reason?: string; failure?: { code?: string; stage?: string } }[]; coverage?: unknown } });
  // The header was verified, but the read-only gate refused to attribute the log to that peer,
  // so the conversation is skipped rather than read.
  expect(failure?.code).toBe('INBOX_WINDOW_UNAVAILABLE');
  expect(failure?.discovery?.skipped[0]).toMatchObject({ reason: 'THREAD_WINDOW_UNAVAILABLE', failure: { stage: 'facebook-inbox-read-only', code: 'INBOX_SOURCE_MISMATCH' } });
  // The conversation was attempted and failed, so it is counted once, as a failure. This
  // previously asserted attempted=1 with skipped=1 and failed=1, an object the coverage contract
  // refuses: the assertion encoded the same overlapping count the adapter produced, which is why
  // the defect could not be caught by running the fixture suite.
  expect(failure?.discovery?.coverage).toEqual({ threads_attempted: 1, threads_read: 0, threads_skipped: 0, threads_failed: 1 });
});

// The adapter's own output, not a hand-written object, has to satisfy the page contract and the
// controller's arithmetic. A local failure in one conversation must never discard the messages
// that were read successfully from another.
test('a window with one successful and one failed conversation keeps its readable result', async ({ page }) => {
  const good = '9999';
  const bad = '8888';
  const directory = '<nav aria-label="对话列表"><div role="tab" aria-selected="true">全部</div><div role="grid" aria-label="聊天">' +
    '<div role="row"><a href="/messages/e2ee/t/' + good + '/">Facebook 用户</a><button aria-label="Facebook 用户的更多选项">更多</button></div>' +
    '<div role="row"><a href="/messages/e2ee/t/' + bad + '/">Facebook 用户</a><button aria-label="Facebook 用户的更多选项">更多</button></div>' +
    '</div></nav>';
  const thread = (id: string, peer: string) => '<main><div id="header"><a href="/' + peer + '/"><h3>Peer Fullname</h3></a></div>' +
    '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>' +
    '<div role="log" aria-label="与Peer Fullname的对话中的消息"><div role="article"><div data-message-id="incoming.' + id + '" aria-label="03:57，Peer Fullname：Original inquiry"><div dir="auto">Original inquiry</div>' +
    '<div role="button" aria-haspopup="dialog" style="width:30px;height:30px" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<a role=menuitem href=/' + peer + '/>查看个人主页</a>\');document.body.dataset.avatarVerified=\'yes\'"><span aria-hidden="true"><img alt="Peer Fullname" style="width:20px;height:20px"></span></div></div></div></main>' + composerKeyboard;
  await page.route('https://www.facebook.com/**', route => {
    const url = route.request().url();
    // The second conversation never resolves its header identity, so it fails locally.
    const body = url.includes('/t/' + good + '/') ? thread(good, '1122') : url.includes('/t/' + bad + '/') ? '<main><h3>Facebook 用户</h3></main>' : directory;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 2 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const result = await readFacebookInboxDirectory(page, request, () => {});
  // The readable conversation survives, and the failed one keeps its own reason.
  expect(result.discovery.threads.map(t => t.thread_id)).toEqual([good]);
  expect(result.messages.map(row => row.message_id)).toEqual(['incoming.' + good]);
  expect(result.discovery.skipped.map(s => s.thread_id)).toEqual([bad]);
  const coverage = result.discovery.coverage!;
  expect(coverage).toEqual({ threads_attempted: 2, threads_read: 1, threads_skipped: 0, threads_failed: 1 });
  // The arithmetic the controller checks, and the page contract the controller parses.
  expect(coverage.threads_attempted).toBe(coverage.threads_read + coverage.threads_failed);
  const parsed = browserInboxPage.parse({ monitor_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15eb', cursor: null, next_cursor: null, has_more: false, discovery: result.discovery, batch: { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: '9999', operating_identity_id: '9999', observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: result.messages } });
  expect(parsed.discovery?.coverage).toEqual(coverage);
});

// The caller and the inner reader must make the same acceptance decision about the same page.
// The caller accepts a label that names the resolved peer through any of the supported prefixes,
// so the inner reader has to accept it too instead of re-deriving its own stricter string rule.
for (const [name, label] of [
  ['the exact supported label', '发消息给Peer Fullname'],
  ['an alternate supported Chinese prefix', '发信息给Peer Fullname'],
  ['a supported English prefix', 'Message Peer Fullname'],
] as const) {
  test('the inner thread reader accepts ' + name + ' the caller already accepted', async ({ page }) => {
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerThread('<div role="textbox" aria-label="' + label + '" contenteditable="true"></div>') }));
    const request = { binding: { target: { thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname' }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
    const rows = await readFacebookInboxThread(page, request, () => {});
    expect(rows.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
  });
}

// The inner reader used to receive the peer id in the parameter that means "our own account", so a
// label naming the peer read as a label naming the operating account. A peer whose name carries
// digits must still be readable, and the two ids must stay independent.
test('keeps the operating account identity separate from a peer whose name carries digits', async ({ page }) => {
  const peerName = 'Alice 12345';
  const peerThread = '<main><div id="header"><a href="/1122/"><h3>' + peerName + '</h3></a></div>' +
    '<div role="textbox" aria-label="发消息给' + peerName + '" contenteditable="true"></div>' +
    '<div role="log" aria-label="与' + peerName + '的对话中的消息">' + composerMessage.replaceAll('Peer Fullname', peerName) + '</div></main>' + composerKeyboard;
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: peerThread }));
  const request = { binding: { target: { thread_id: '9988', peer_id: '1122', display_name: peerName }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const rows = await readFacebookInboxThread(page, request, () => {});
  expect(rows.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', peerName]]);
  // A label naming our own operating account is still refused, so the fix did not widen acceptance.
  await page.setContent('<main><div id="header"><a href="/1122/"><h3>' + peerName + '</h3></a></div>' +
    '<div role="textbox" aria-label="发消息给Our Own Account" contenteditable="true"></div>' +
    '<div role="log" aria-label="与' + peerName + '的对话中的消息">' + composerMessage.replaceAll('Peer Fullname', peerName) + '</div></main>');
  expect(await page.evaluate(inspectFacebookInboxComposerDom, { display_name: peerName, allow_other_name: false, operating_identity_id: '9999' })).toMatchObject({ composer: null, candidate_count: 1 });
});

// A fixed thread binding is read only through the composer: the directory row is not there to
// resolve a placeholder, so a placeholder target can never become a peer name on its own.
test('refuses a fixed target that only repeats the directory placeholder', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><div id="header"><a href="/1122/"><h3>Peer Fullname</h3></a></div>' + composerMessage.replace('<div role="article">', '<div role="log" aria-label="与Peer Fullname的对话中的消息"><div role="article">') + '</div></main>' }));
  const request = { binding: { target: { thread_id: '9988', peer_id: '1122', display_name: 'Facebook 用户' }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  await readFacebookInboxThread(page, request, () => {}).then(() => { throw new Error('Reader accepted a placeholder as a peer name'); }, error => { expect((error as { code?: string }).code).toBe('THREAD_IDENTITY_UNVERIFIED'); });
});

// A named label from another person is only usable while the directory still shows the
// placeholder; once the directory has a real name, a different name is refused.
test('a composer naming another person is refused when the directory already has a real name', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory('Peer Fullname') + (route.request().url().includes('/e2ee/') ? composerThread('<div role="textbox" aria-label="发消息给Someone Else" contenteditable="true"></div>') : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  await readFacebookInboxDirectory(page, request, () => {}).catch(error => expect((error as { code?: string }).code).toBe('INBOX_WINDOW_UNAVAILABLE'));
  // The directory carries a real name here, so only that exact name qualifies.
  expect(await page.evaluate(inspectFacebookInboxComposerDom, { display_name: 'Peer Fullname', allow_other_name: false, operating_identity_id: '9999' })).toMatchObject({ composer: null, candidate_count: 1, surface: { label_kind: 'NAMED_PREFIX' } });
});

// The read result itself must satisfy the window contract. A conversation read through the accepted
// composer has to carry that composer observation, and a conversation read read-only has to carry its
// reason; without either, the report is refused by its own schema and a real read is thrown away.
test('every read conversation carries the evidence its window contract requires', async ({ page }) => {
  for (const [label, composer, directoryLabel] of [
    ['an accepted composer', '<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>', 'Facebook 用户'],
    ['no composer at all', '', 'Facebook 用户'],
  ] as const) {
    await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory(directoryLabel) + (route.request().url().includes('/e2ee/') ? (composer ? composerThread(composer) : readOnlyThread()) : '') }));
    const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
    const result = await readFacebookInboxDirectory(page, request, () => {});
    expect(result.discovery.threads.map(thread => thread.thread_id), label).toEqual(['9988']);
    const page0 = browserInboxPage.parse({ monitor_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15eb', cursor: null, next_cursor: null, has_more: false, discovery: result.discovery, batch: { schema_version: 'kff.browser-inbox-batch.v1', login_account_id: '9999', operating_identity_id: '9999', observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: result.messages } });
    expect(page0.discovery?.threads[0].composer_surface, label).toBeDefined();
    expect(page0.batch.messages).toHaveLength(1);
  }
});

// A named label from another person is usable while the directory is still the
// placeholder: the header then supplies the real name and each avatar is rechecked.
test('a named composer label is used while the directory still shows the placeholder', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory() + (route.request().url().includes('/e2ee/') ? composerThread('<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>') : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const result = await readFacebookInboxDirectory(page, request, () => {});
  expect(result.discovery.threads).toMatchObject([{ thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname', read: true, message_count: 1 }]);
  expect(result.discovery.skipped).toEqual([]);
  expect(result.messages.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
});

// The inner reader must accept exactly what the caller accepted. This entry point is a
// fixed thread, so the log name is the real one, but the composer label may still be
// the placeholder that named the same person during directory hydration.
test('the inner thread reader accepts a composed label the caller already accepted', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><div id="header"><a href="/1122/"><h3>Peer Fullname</h3></a></div><div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div><div role="log" aria-label="与Peer Fullname的对话中的消息">' + composerMessage + '</div></main>' + composerKeyboard }));
  const request = { binding: { target: { thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname' }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const rows = await readFacebookInboxThread(page, request, () => {});
  expect(rows.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
});

test('the inner thread reader refuses a label that does not name the fixed target', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><div id="header"><a href="/1122/"><h3>Peer Fullname</h3></a></div><div role="textbox" aria-label="发消息给Someone Else" contenteditable="true"></div><div role="log" aria-label="与Peer Fullname的对话中的消息">' + composerMessage + '</div></main>' + composerKeyboard }));
  const request = { binding: { target: { thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname' }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  await readFacebookInboxThread(page, request, () => {}).then(() => { throw new Error('Reader accepted a foreign composer label'); }, error => { expect((error as { code?: string }).code).toBe('INBOX_SOURCE_MISMATCH'); });
});

// The exact-label path still opens the same thread when the composer hydrates first.
test('an early composer label does not block reading the accepted thread', async ({ page }) => {
  await page.route('https://www.facebook.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: composerDirectory() + (route.request().url().includes('/e2ee/') ? composerThread('<div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div>') : '') }));
  const request = { binding: { discovery: { strategy: 'RECENT_ACCEPTED', max_threads: 1 }, environment: { configuration: { operating_identity_id: '9999' } } }, template: 'facebook-inbox-dom-v1', cursor: null, limit: 5 } as Pick<BrowserInboxTask, 'binding' | 'template' | 'cursor' | 'limit'>;
  const result = await readFacebookInboxDirectory(page, request, () => {});
  expect(result.discovery.threads).toMatchObject([{ thread_id: '9988', peer_id: '1122', display_name: 'Peer Fullname', read: true, message_count: 1 }]);
  expect(result.discovery.skipped).toEqual([]);
  expect(result.messages.map(row => [row.message_id, row.peer_id, row.display_name])).toEqual([['incoming.1', '1122', 'Peer Fullname']]);
  expect(await page.locator('body').getAttribute('data-avatar-verified')).toBe('yes');
});
