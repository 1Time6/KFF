import { test, expect } from '@playwright/test';
import { composerLabelPerson, composerNamePattern, inspectFacebookInboxComposerDom } from '../../../packages/adapters/src/facebook-inbox-directory-dom';

// KFF-AUD-003. The reader accepts a composer label after normalising its whitespace; the reply has to
// find that same element. These cases pin both halves against one page state each.
// `probe` is the reader's own acceptance and `prefix` is the reply path's coarser prefix rule: the
// reply path may only run after the reader accepted the same peer, so a prefix it matches on a label
// the reader refused is never reached. What must never diverge is `found`.
const peer = 'Peer Fullname';
const cases = [
  ['the exact supported label', '发消息给' + peer, true, 'EXACT_NAME', 1],
  ['a single space after the prefix', '发消息给 ' + peer, true, 'EXACT_NAME', 1],
  ['a non-breaking space after the prefix', '发消息给\u00a0' + peer, true, 'EXACT_NAME', 1],
  ['a doubled inner space', '发消息给' + peer.replace(' ', '  '), true, 'EXACT_NAME', 1],
  // A prefix-other-than-发消息给 label is accepted only through the peer-name rule, which is what the
  // directory reader passes once it resolved the name from the conversation header.
  ['an alternate supported prefix naming the peer', '发信息给 ' + peer, true, 'NAMED_PREFIX', 1],
  ['an unrelated search box', '搜索', false, 'OTHER', 0],
  ['a label naming somebody else', '发消息给 Someone Else', false, 'NAMED_PREFIX', 0],
] as const;

for (const [name, label, accepted, prefix, found] of cases) {
  test('the reply locator finds what the reader accepted for ' + name, async ({ page }) => {
    await page.setContent('<main><div role="textbox" aria-label="' + label + '" contenteditable="true"></div></main>');
    const probe = await page.evaluate(inspectFacebookInboxComposerDom, { display_name: peer, allow_other_name: true, operating_identity_id: '9999', peer_name: peer });
    expect(Boolean(probe.composer), name).toBe(accepted);
    expect(composerLabelPerson(label, peer), name).toBe(prefix);
    const editor = page.locator('main').getByRole('textbox', { name: composerNamePattern(peer) });
    expect(await editor.count(), name).toBe(found);
    // Whenever the reader accepted the composer, the reply path must see exactly that one element.
    if (accepted) expect(await editor.count(), name).toBe(1);
  });
}

// The regression that produced KFF-AUD-003: the previous reply selector was the exact concatenation,
// which a page label carrying a space after the prefix does not match even though the reader accepted it.
test('the previous exact-concatenation selector cannot address an accepted spaced label', async ({ page }) => {
  await page.setContent('<main><div role="textbox" aria-label="发消息给 ' + peer + '" contenteditable="true"></div></main>');
  expect(await page.locator('main').getByRole('textbox', { name: '发消息给' + peer, exact: true }).count()).toBe(0);
  expect(await page.locator('main').getByRole('textbox', { name: composerNamePattern(peer) }).count()).toBe(1);
});

// Two inputs that both name the verified peer are an ambiguity the reply path must refuse rather than
// pick from: writing into the wrong box is worse than not replying at all.
test('two inputs naming the same peer keep the reply ambiguous', async ({ page }) => {
  await page.setContent('<main><div role="textbox" aria-label="发消息给 ' + peer + '" contenteditable="true"></div><div role="textbox" aria-label="发信息给' + peer + '" contenteditable="true"></div></main>');
  const editor = page.locator('main').getByRole('textbox', { name: composerNamePattern(peer) });
  expect(await editor.count()).toBe(2);
  expect(await page.evaluate(inspectFacebookInboxComposerDom, { display_name: peer, allow_other_name: false, operating_identity_id: '9999', peer_name: peer })).toMatchObject({ composer: null, candidate_count: 2 });
});

// The displayed name is page data, so a name carrying regex metacharacters must stay data.
test('a peer name with regex metacharacters is matched literally', async ({ page }) => {
  const odd = 'A.B (C)+';
  await page.setContent('<main><div role="textbox" aria-label="发消息给' + odd + '" contenteditable="true"></div></main>');
  expect(await page.locator('main').getByRole('textbox', { name: composerNamePattern(odd) }).count()).toBe(1);
  expect(await page.locator('main').getByRole('textbox', { name: composerNamePattern('AXB (C)+') }).count()).toBe(0);
});
