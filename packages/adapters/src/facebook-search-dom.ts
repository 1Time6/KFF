export interface FacebookSearchRow {
  id: string; url: string; author_id: string | null; message: string; expanded: boolean; displayed_time: string | null;
}

/** Runs in the rendered document. No cookies, application state, or network payloads are read. */
export function inspectFacebookSearchDom(pageSource?: { publisher_id: string } | void): { rows: FacebookSearchRow[]; invalid: number } {
  const helpers = {
    visible(node: Element) { return !node.closest('[hidden],[aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none'; },
    own(node: Element, article: Element) { return node.closest('article,[role="article"]') === article; },
    canonical(href: string) {
    try {
      const url = new URL(href, 'https://www.facebook.com/');
      if (url.origin !== 'https://www.facebook.com' || url.username || url.password || url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;
      const reel = /^\/reel\/([0-9]{1,80})\/?$/.exec(url.pathname);
      if (reel) return { id: 'facebook:reel:' + reel[1], url: 'https://www.facebook.com/reel/' + reel[1] + '/' };
      if (pageSource && url.pathname === '/permalink.php' && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === pageSource.publisher_id && url.searchParams.getAll('story_fbid').length === 1) {
        const id = url.searchParams.get('story_fbid') ?? '';
        if (/^(pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})$/.test(id)) return { id: 'facebook:post:' + id, url: 'https://www.facebook.com/permalink.php?story_fbid=' + id + '&id=' + pageSource.publisher_id };
      }
      const post = /^\/([A-Za-z0-9.]+)\/posts\/(pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})\/?$/.exec(url.pathname);
      return post && (!pageSource || post[1] === pageSource.publisher_id) ? { id: 'facebook:post:' + post[2], url: 'https://www.facebook.com/' + post[1] + '/posts/' + post[2] + '/' } : null;
    } catch { return null; }
    },
  };
  const rows: FacebookSearchRow[] = []; let invalid = 0;
  const main = [...document.querySelectorAll('main,[role="main"]')].filter(helpers.visible);
  if (main.length !== 1) return { rows, invalid: 1 };
  for (const article of main[0].querySelectorAll('article,[role="article"]')) {
    if (!helpers.visible(article) || article.parentElement?.closest('article,[role="article"]')) continue;
    const messages = [...article.querySelectorAll<HTMLElement>('[data-ad-preview="message"]')].filter(node => helpers.visible(node) && helpers.own(node, article));
    if (!messages.length) continue; // Group/Page cards and unloaded placeholders have no post body.
    const headings = [...article.querySelectorAll(pageSource ? 'h2,[role="heading"][aria-level="2"]' : 'h3,[role="heading"][aria-level="3"]')].filter(node => helpers.visible(node) && helpers.own(node, article));
    const publicIcon = [...article.querySelectorAll('[role="img"]')].some(node => helpers.visible(node) && helpers.own(node, article) && /^(分享对象：\s*公开|Shared with Public|Public)$/.test(node.getAttribute('aria-label') ?? node.getAttribute('title') ?? ''));
    if (!publicIcon) continue;
    if (messages.length !== 1 || headings.length !== 1) { invalid++; continue; }
    const authors = [...headings[0].querySelectorAll<HTMLAnchorElement>('a[href]')].filter(helpers.visible);
    const links = new Map<string, { id: string; url: string }>();
    const labels = new Set<string>();
    for (const link of article.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!helpers.visible(link) || !helpers.own(link, article) || messages[0].contains(link)) continue;
      const source = helpers.canonical(link.href); if (source) links.set(source.id, source);
      if (source) { const label = (link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText).trim(); if (label) labels.add(label); }
    }
    if (authors.length !== 1 || links.size !== 1) { invalid++; continue; }
    let authorId: string | null = null;
    try {
      const author = new URL(authors[0].href);
      if (author.origin !== 'https://www.facebook.com') { invalid++; continue; }
      if (author.pathname === '/profile.php' && author.searchParams.getAll('id').length === 1 && /^[0-9]{1,128}$/.test(author.searchParams.get('id') ?? '')) authorId = author.searchParams.get('id');
      else if (/^\/[0-9]{1,128}\/?$/.test(author.pathname)) authorId = author.pathname.replaceAll('/', '');
    } catch { invalid++; continue; }
    if (pageSource && authorId !== pageSource.publisher_id) { invalid++; continue; }
    let message = messages[0].innerText.trim();
    const collapse = [...messages[0].querySelectorAll<HTMLElement>('button,[role="button"]')].filter(node => helpers.visible(node) && /^(收起|See less)$/.test(node.innerText.trim()));
    if (collapse.length === 1 && message.endsWith(collapse[0].innerText.trim())) message = message.slice(0, -collapse[0].innerText.trim().length).trim();
    const expanded = ![...messages[0].querySelectorAll<HTMLElement>('button,[role="button"]')].some(node => helpers.visible(node) && /^(展开|See more)$/.test(node.innerText.trim()));
    if (!message || message.length > 5000) { invalid++; continue; }
    const displayed_time = labels.size === 1 && [...labels][0].length <= 160 ? [...labels][0] : null;
    rows.push({ ...links.values().next().value!, author_id: authorId, message, expanded, displayed_time });
  }
  return { rows, invalid };
}
