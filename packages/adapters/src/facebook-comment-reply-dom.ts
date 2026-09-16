export interface FacebookCommentReplyRow { id: string; author_id: string; body: string; url: string }

/** Visible reply permalinks, authors and text only; serialized into the controlled page. */
export function inspectFacebookCommentRepliesDom(input: { source_url: string; comment_id: string }) {
  const rows: FacebookCommentReplyRow[] = []; let invalid = 0;
  // Object methods remain self-contained when TSX serializes this function for page.evaluate.
  const helper = { visible(el: Element) { return !el.closest('[hidden],[aria-hidden="true"]') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden'; } };
  const target = new URL(input.source_url);
  if (location.origin !== target.origin || location.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) return { rows, invalid: 1 };
  for (const article of document.querySelectorAll<HTMLElement>('article[aria-label],[role="article"][aria-label]')) {
    if (!helper.visible(article)) continue;
    const links = [...article.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(el => helper.visible(el) && el.closest('article,[role="article"]') === article);
    const sources = links.flatMap(el => {
      try { const url = new URL(el.href); return url.origin === target.origin && url.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') && url.searchParams.get('comment_id') === input.comment_id && url.searchParams.has('reply_comment_id') ? [url] : []; } catch { return []; }
    });
    if (!sources.length) continue;
    const ids = [...new Set(sources.map(url => url.searchParams.get('reply_comment_id')!))];
    const authors = links.flatMap(el => {
      try { const url = new URL(el.href), id = url.searchParams.get('id'); return el.innerText.trim() && url.origin === target.origin && url.pathname === '/profile.php' && id && /^[0-9]{1,128}$/.test(id) ? [id] : []; } catch { return []; }
    });
    const bodies = [...article.querySelectorAll<HTMLElement>('span[dir="auto"][lang]')].filter(el => helper.visible(el) && el.closest('article,[role="article"]') === article && !el.closest('a,button,[role="button"],[role="textbox"]'));
    const body = bodies.length === 1 ? bodies[0].innerText.replace(/(?:\n?)(收起|See less)\s*$/, '').trim() : '';
    const pending = /正在发布|正在發佈|待审核|待審核|无法发布|無法發佈|Posting\.{0,3}|Pending approval|Couldn.t post/i.test(article.innerText);
    if (ids.length !== 1 || !/^[0-9]{1,80}$/.test(ids[0]) || ids[0] === input.comment_id || authors.length !== 1 || !body || body.length > 5000 || pending || bodies[0]?.querySelector('button,[role="button"]')) { invalid++; continue; }
    rows.push({ id: ids[0], author_id: authors[0], body, url: input.source_url + '?comment_id=' + input.comment_id + '&reply_comment_id=' + ids[0] });
  }
  return { rows, invalid };
}
