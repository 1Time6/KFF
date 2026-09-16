import type { Page } from '@playwright/test';
import type { CollectionRecord } from '@kff/contracts';
import { AppError, requireCondition } from '@kff/core';
import type { CollectionRead } from './collection-fixture';
import { inspectFacebookSearchDom } from './facebook-search-dom';
import { facebookSearchCursor, parseFacebookSearchCursor, readFacebookSearchTime } from './facebook-browser-discovery';

const home = 'https://www.facebook.com';
async function assertFacebookPageLocation(page: Page, publisher: string) {
  const url = new URL(page.url());
  requireCondition(url.origin === home, 'COLLECTION_SOURCE_MISMATCH', '主页离开了指定平台');
  requireCondition(!/checkpoint|challenge|two_step_verification/.test(url.pathname), 'LOGIN_CHALLENGE', '平台要求人工登录验证');
  requireCondition(!url.pathname.startsWith('/login') && !(await page.locator('input[type="password"]:visible').count()), 'LOGIN_REQUIRED', '当前浏览器需要登录');
  const numeric = url.pathname === '/' + publisher + '/' && !url.search;
  const profile = url.pathname === '/profile.php' && url.search === '?id=' + publisher;
  requireCondition((numeric || profile) && !url.hash && await page.getByRole('main').count() === 1, 'COLLECTION_SOURCE_MISMATCH', '主页 ID 或页面区域与固定来源不符');
}

export async function assertFacebookPageSource(page: Page, publisher: string, onStep?: (step: string) => void) {
  onStep?.('source-address');
  await assertFacebookPageLocation(page, publisher);
  const main = page.getByRole('main'), headings = await main.getByRole('heading', { level: 1 }).count();
  if (headings === 1 && await main.getByRole('button', { name: /^(公共主页|Page)\s*·/ }).count() === 1) return;
  // Observed Chinese Page header: no h1. Keep a deliberately bounded fallback:
  // Page cover, header name, product/service category, native review tile and
  // publisher-bound tabs must agree. Feed text alone cannot establish Page type.
  const modern = headings === 0 && await main.evaluate((element, id) => {
    const actions = element.querySelectorAll('[data-pagelet="ProfileActions"]');
    const tabs = element.querySelectorAll('[data-pagelet="ProfileTabs"]');
    if (actions.length !== 1 || tabs.length !== 1 || !(actions[0].compareDocumentPosition(tabs[0]) & Node.DOCUMENT_POSITION_FOLLOWING)) return 'actions';
    const buttons = [...element.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(e => e.getClientRects().length && !e.closest('[hidden],[aria-hidden="true"],article,[role="article"]'));
    const names = buttons.filter(e => Boolean(e.compareDocumentPosition(actions[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (names.length !== 1 || !names[0].innerText.trim()) return 'header-name';
    const covers = [...element.querySelectorAll('a[aria-label="查看主页封面照片"]')].filter(e => e.getClientRects().length && Boolean(e.compareDocumentPosition(names[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    const categories = buttons.filter(e => e.innerText.trim() === '产品/服务' && Boolean(actions[0].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(e.compareDocumentPosition(tabs[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    const reviews = element.querySelectorAll('[data-pagelet="ProfileTilesFeed_0"]');
    if (covers.length !== 1 || categories.length !== 1 || reviews.length !== 1 || !reviews[0].getClientRects().length || reviews[0].closest('article,[role="article"]')) return 'cover-category-review-tile';
    const reviewButtons = [...reviews[0].querySelectorAll<HTMLElement>('button,[role="button"]')].filter(e => e.getClientRects().length && /^尚无评分（0 次点评）$/.test(e.innerText.trim()));
    const followers = [...tabs[0].querySelectorAll<HTMLAnchorElement>('a[role="tab"]')].filter(e => e.getClientRects().length && e.innerText.trim() === '粉丝');
    const all = [...tabs[0].querySelectorAll<HTMLAnchorElement>('a[role="tab"]')].filter(e => e.getClientRects().length && e.innerText.trim() === '全部');
    if (reviewButtons.length !== 1) return 'review-button';
    if (followers.length > 1) return 'followers-tab-ambiguous';
    // The compact header may omit the tab. Its visible follower-count link
    // binds the same publisher without opening a menu or changing the viewport.
    const headerFollowers = [...element.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(e => e.getClientRects().length && !e.closest('[hidden],[aria-hidden="true"],article,[role="article"]') && /^\d[\d,.]* 位粉丝$/.test(e.innerText.trim()) && Boolean(names[0].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(e.compareDocumentPosition(actions[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (followers.length === 0 && headerFollowers.length !== 1) return 'followers-tab';
    if (all.length > 1) return 'all-tab-ambiguous';
    if (all.length === 0 && headerFollowers.length !== 1) return 'all-tab';
    return (followers[0] ?? headerFollowers[0]).href === 'https://www.facebook.com/profile.php?id=' + id + '&sk=followers' && (all.length === 1 ? all[0].href === 'https://www.facebook.com/profile.php?id=' + id : headerFollowers[0].href === 'https://www.facebook.com/profile.php?id=' + id + '&sk=followers') ? 'verified' : 'publisher-tabs';
  }, publisher);
  onStep?.('source-modern-' + (modern || 'legacy-heading'));
  requireCondition(modern === 'verified', 'SOURCE_UNSUPPORTED', '当前页面未明确显示唯一公共主页身份');
}

/** Reads a bounded window of this publisher's public posts. Feed order is not a publication-time guarantee. */
export async function readFacebookPagePage(page: Page, request: CollectionRead, assertControlled: () => void, onStep?: (step: string) => void) {
  const config = request.snapshot.discovery;
  requireCondition(config?.platform === 'facebook' && config.provider === 'LOCAL_BROWSER' && config.strategy === 'PAGE' && config.browser?.template === 'facebook-page-dom-v1' && /^https:\/\/www\.facebook\.com\/[0-9]{1,80}\/$/.test(config.target), 'SOURCE_UNSUPPORTED', '主页读取需要固定数字 ID 的公共主页链接');
  const publisher = new URL(config.target).pathname.replaceAll('/', ''), anchor = parseFacebookSearchCursor(request);
  const rows: CollectionRecord[] = [], seen = new Set<string>();
  let found = anchor === null, previous = '', unchanged = 0, unparsedVisibleMax = 0;
  assertControlled(); onStep?.('navigate');
  await page.goto(config.target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  onStep?.('scope');
  const main = page.getByRole('main');
  await main.getByRole('heading', { level: 1 }).or(main.locator('[data-pagelet="ProfileActions"]')).first().waitFor({ state: 'visible', timeout: 15000 });
  onStep?.('page-type-ready');
  // React renders native Page markers independently. Poll the complete guard
  // within one navigation; never retry a command, reload, or relax identity.
  const sourceReadyUntil = Date.now() + 15000;
  for (;;) {
    assertControlled();
    try { await assertFacebookPageSource(page, publisher, onStep); break; }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SOURCE_UNSUPPORTED' || Date.now() >= sourceReadyUntil) throw error;
    }
    await page.waitForTimeout(250);
  }
  onStep?.('posts-heading');
  const posts = page.getByRole('main').getByRole('heading', { name: /^(帖子|Posts)$/, exact: true, level: 2 });
  requireCondition(await posts.count() === 1, 'SOURCE_UNSUPPORTED', '未找到唯一主页帖子列表');
  onStep?.('wait-content'); assertControlled(); await posts.scrollIntoViewIfNeeded(); await page.mouse.wheel(0, 650);
  const bodies = page.getByRole('main').locator('article [data-ad-preview="message"],[role="article"] [data-ad-preview="message"]');
  try { await bodies.first().waitFor({ state: 'visible', timeout: 20000 }); }
  catch { onStep?.('content-location'); await assertFacebookPageLocation(page, publisher); throw new AppError('SOURCE_WINDOW_ENDED', '主页帖子尚未显示可核实正文，不能判断没有新内容'); }
  for (let scroll = 0; scroll < 12; scroll++) {
    // The native header was verified before scrolling. Facebook may collapse it;
    // pin the document address here and verify each post's own public author below.
    onStep?.('scope-location'); assertControlled(); await assertFacebookPageLocation(page, publisher);
    onStep?.('expand');
    for (const body of await bodies.all()) {
      assertControlled(); const expand = body.getByRole('button', { name: /^(展开|See more)$/, exact: true });
      if (await expand.count() === 1 && await expand.isVisible()) { await expand.click({ timeout: 5000 }); await expand.waitFor({ state: 'hidden', timeout: 5000 }); }
    }
    onStep?.('parse-dom'); const current = await page.evaluate(inspectFacebookSearchDom, { publisher_id: publisher });
    unparsedVisibleMax = Math.max(unparsedVisibleMax, current.invalid);
    for (const row of current.rows) {
      if (!found) { seen.add(row.id); if (row.id === anchor) found = true; continue; }
      if (row.id === anchor || seen.has(row.id)) continue;
      if (!row.expanded) break;
      seen.add(row.id); const fields: CollectionRecord['fields'] = {};
      onStep?.('publication-time');
      const displayedTime = request.snapshot.fields.includes('created_time') ? await readFacebookSearchTime(page, row, assertControlled) : null;
      for (const field of request.snapshot.fields) fields[field] = field === 'message' ? { kind: 'VALUE', value: row.message } : field === 'author_id' ? { kind: 'VALUE', value: publisher } : field === 'created_time' && displayedTime ? { kind: 'DISPLAYED_TIME', value: displayedTime } : { kind: 'NOT_RETURNED' };
      rows.push({ source_object_id: row.id, source_url: row.url, fields });
      if (rows.length === request.limit) break;
    }
    if (rows.length === request.limit) break;
    const signature = current.rows.map(row => row.id).join(','); unchanged = signature === previous ? unchanged + 1 : 0; previous = signature;
    if (unchanged >= 3 && current.rows.length > 0) break;
    onStep?.('scroll'); assertControlled(); await page.mouse.wheel(0, 900); await page.waitForTimeout(1000);
  }
  onStep?.('final-location'); assertControlled(); await assertFacebookPageLocation(page, publisher);
  requireCondition(found, 'CURSOR_EXPIRED', '主页排序已变化，未找到上次检查点');
  requireCondition(rows.length, 'SOURCE_WINDOW_ENDED', '当前主页窗口没有更多可核实帖子；不代表整个主页没有新内容');
  return { rows, next_cursor: facebookSearchCursor(request, rows[rows.length - 1].source_object_id), unparsedVisibleMax };
}
