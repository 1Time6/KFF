export interface FacebookCommentRow { id: string; url: string; author_id: string | null; message: string; expanded: boolean; displayed_time: string | null }

/** Rendered comment content only. This function is serialized into the controlled browser. */
export function inspectFacebookCommentsDom(target: string): { rows: FacebookCommentRow[]; invalid: number; publicPost: boolean; container_path?: string } {
  const helper = {
    visible(node: Element) { return !node.closest('[hidden],[aria-hidden="true"]') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden'; },
    url(anchor: HTMLAnchorElement) { try { const u = new URL(anchor.href); return u.origin === 'https://www.facebook.com' && !u.username && !u.password ? u : null; } catch { return null; } },
    own(node: Element, post: Element) { return node.closest('article,[role="article"]') === (post.matches('article,[role="article"]') ? post : null); },
    path(node: Element) { const parts: string[] = []; for(let current: Element|null=node;current;current=current.parentElement) { const index=current.parentElement?[...current.parentElement.children].indexOf(current)+1:1;parts.unshift(current.tagName.toLowerCase()+':nth-child('+index+')'); }return parts.join(' > '); },
  };
  const rows: FacebookCommentRow[] = []; let invalid = 0;
  const targetUrl = new URL(target), reel = /^\/reel\/[0-9]{1,80}\/$/.test(targetUrl.pathname);
  const containers = [...document.querySelectorAll(reel ? 'aside,[role="complementary"]' : '[role="dialog"]')].filter(node => helper.visible(node) && (reel || !node.querySelector('[role="dialog"]')));
  let containerPath: string | undefined;
  // Some Reel layouts render the same owner/public/comments panel without an ARIA role.
  // Choose its smallest common ancestor, never the page body or the neighboring video feed.
  if(reel && containers.length===0) {
    const headings=[...document.querySelectorAll('h2,[role="heading"][aria-level="2"]')].filter(node=>helper.visible(node)&&/^(评论|Comments)$/.test(node.textContent?.trim()??''));
    if(headings.length===1) for(let node=headings[0].parentElement,depth=0;node&&depth<16;node=node.parentElement,depth++) {
      if(node.matches('body,html,main,[role="main"],article,[role="article"]')||node.querySelector('main,[role="main"]'))break;
      const owners=[...node.querySelectorAll<HTMLAnchorElement>('h2 a[href],[role="heading"][aria-level="2"] a[href]')].filter(link=>helper.own(link,node!)&&helper.visible(link)&&helper.url(link));
      const publicAudience=[...node.querySelectorAll('[role="img"],[role="button"],button')].some(el=>helper.own(el,node!)&&helper.visible(el)&&/^(分享对象：\s*公开|Shared with Public|Public)$/.test(el.getAttribute('aria-label')||el.getAttribute('title')||''));
      if(owners.length===1&&publicAudience){containers.push(node);containerPath=helper.path(node);break;}
    }
  }
  if (containers.length !== 1) return { rows, invalid, publicPost: false };
  const container = containers[0];
  const posts = reel ? [container] : [...container.querySelectorAll('article,[role="article"]')].filter(node => helper.visible(node) && !node.parentElement?.closest('article,[role="article"]'));
  if (posts.length !== 1) return { rows, invalid, publicPost: false };
  const post = posts[0];
  // Reels use a comments sidebar, with a public-audience button in the owner heading.
  // The caller opens that sidebar from the unique on-screen Reel and checks the URL again.
  const sameReel = reel && location.origin === targetUrl.origin && location.pathname.replace(/\/$/, '') === targetUrl.pathname.replace(/\/$/, '') &&
    [...post.querySelectorAll('h2,[role="heading"][aria-level="2"]')].filter(node => helper.own(node, post) && helper.visible(node) && /^(评论|Comments)$/.test(node.textContent?.trim() ?? '')).length === 1 &&
    [...post.querySelectorAll<HTMLAnchorElement>('h2 a[href],[role="heading"][aria-level="2"] a[href]')].filter(node => helper.own(node, post) && helper.visible(node) && helper.url(node)).length === 1;
  const publicPost = [...post.querySelectorAll(reel ? '[role="img"],[role="button"],button' : '[role="img"]')].some(node => helper.own(node, post) && helper.visible(node) && /^(分享对象：\s*公开|Shared with Public|Public)$/.test(node.getAttribute('aria-label') || node.getAttribute('title') || '')) && (sameReel || !reel && [...post.querySelectorAll<HTMLAnchorElement>('a[href]')].some(node => {
    const u = helper.url(node); return helper.own(node, post) && helper.visible(node) && u && u.pathname.replace(/\/$/, '') === targetUrl.pathname.replace(/\/$/, '') && !u.searchParams.has('comment_id');
  }));
  if (!publicPost) return { rows, invalid, publicPost };
  for (const comment of post.querySelectorAll('article[aria-label],[role="article"][aria-label]')) {
    if (!helper.visible(comment) || !/^(评论者：|Comment by )/.test(comment.getAttribute('aria-label') || '') || comment.parentElement?.closest('article,[role="article"]') !== (reel ? null : post)) continue;
    const bodies = [...comment.querySelectorAll<HTMLElement>('span[dir="auto"][lang]')].filter(node => helper.visible(node) && node.closest('article,[role="article"]') === comment && !node.closest('a,button,[role="button"],[role="textbox"]'));
    if (bodies.length !== 1) { invalid++; continue; }
    const body = bodies[0];
    const links = [...comment.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(node => helper.visible(node) && node.closest('article,[role="article"]') === comment && !body.contains(node));
    const sourceLinks = links.filter(node=>{const u=helper.url(node);return u && u.pathname.replace(/\/$/, '') === targetUrl.pathname.replace(/\/$/, '') && /^[0-9]{1,80}$/.test(u.searchParams.get('comment_id') || '') && !u.searchParams.has('reply_comment_id');});
    const sources=sourceLinks.map(node=>helper.url(node)!);
    const ids = [...new Set(sources.map(u => u.searchParams.get('comment_id')!))];
    const authors = links.filter(node => {
      const u = helper.url(node); return u && node.innerText.trim() && (u.pathname === '/profile.php' && /^[0-9]{1,128}$/.test(u.searchParams.get('id') || '') || /^\/[A-Za-z0-9.]+\/?$/.test(u.pathname) && !/^\/(?:profile\.php|photo|reel|stories|login|messages|search)\/?$/.test(u.pathname));
    });
    const message = body.innerText.replace(/(?:\n?)(收起|See less)\s*$/, '').trim();
    if (ids.length !== 1 || authors.length !== 1 || !message || message.length > 5000) { invalid++; continue; }
    const author = helper.url(authors[0])!;
    const times=[...new Set(sourceLinks.map(node=>(node.getAttribute('aria-label')||node.getAttribute('title')||node.innerText).trim()).filter(Boolean))];
    const displayed_time=times.length===1&&times[0].length<=160?times[0]:null;
    rows.push({ id: 'facebook:comment:' + ids[0], url: target + '?comment_id=' + ids[0], author_id: author.pathname === '/profile.php' ? author.searchParams.get('id') : null, message, displayed_time, expanded: ![...body.querySelectorAll('button,[role="button"]')].some(node => helper.visible(node) && /^(展开|See more)$/.test((node.textContent || '').trim())) });
  }
  return { rows, invalid, publicPost, ...(containerPath?{container_path:containerPath}:{}) };
}
