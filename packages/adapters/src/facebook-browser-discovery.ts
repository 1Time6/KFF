import { z } from 'zod';
import type { Page, Locator } from '@playwright/test';
import type { CollectionRecord } from '@kff/contracts';
import { AppError, digest, requireCondition } from '@kff/core';
import { inspectFacebookSearchDom, type FacebookSearchRow } from './facebook-search-dom';
import type { CollectionRead } from './collection-fixture';

const home = 'https://www.facebook.com';
const cursorSchema = z.object({ v: z.literal(1), query: z.string().uuid(), snapshot: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().regex(/^facebook:(?:(?:reel|comment):[0-9]{1,80}|post:(?:pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80}))$/) }).strict();
export function facebookSearchCursor(request: CollectionRead, after: string) {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ v: 1, query: request.query_id, snapshot: digest(request.snapshot), after }))).toString('base64url');
}
export function parseFacebookSearchCursor(request: CollectionRead) {
  if (request.cursor === null) return null;
  try {
    requireCondition(/^[A-Za-z0-9_-]{1,2048}$/.test(request.cursor), 'CURSOR_EXPIRED', '搜索检查点格式不符');
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')));
    requireCondition(cursor.query === request.query_id && cursor.snapshot === digest(request.snapshot), 'CURSOR_EXPIRED', '搜索检查点属于其他查询');
    return cursor.after;
  } catch { throw new AppError('CURSOR_EXPIRED', '搜索检查点无效或已不属于当前查询'); }
}

async function guard(page: Page, keyword: string, recent = false) {
  const url = new URL(page.url());
  requireCondition(url.origin === home, 'COLLECTION_SOURCE_MISMATCH', '搜索离开了指定平台');
  requireCondition(!/checkpoint|challenge|two_step_verification/.test(url.pathname), 'LOGIN_CHALLENGE', '平台要求人工登录验证');
  requireCondition(!url.pathname.startsWith('/login') && !(await page.locator('input[type="password"]:visible').count()), 'LOGIN_REQUIRED', '当前浏览器需要登录');
  requireCondition(/^\/search\/top\/?$/.test(url.pathname) && url.searchParams.get('q') === keyword, 'COLLECTION_SOURCE_MISMATCH', '搜索关键词或页面类型与查询不符');
  requireCondition(await page.getByRole('main').count() === 1, 'COLLECTION_SOURCE_MISMATCH', '搜索主区域不唯一');
  requireCondition(await page.getByRole('combobox', { name: /^(搜索 Facebook|Search Facebook)$/ }).inputValue() === keyword, 'COLLECTION_SOURCE_MISMATCH', '页面搜索框与固定关键词不符');
  if (recent) requireCondition(await page.getByRole('switch', { name: /^(近期帖子|Recent posts)$/ }).isChecked(), 'COLLECTION_SOURCE_MISMATCH', '近期帖子筛选已变化');
}

/** Hover only the unique source time link after any old tooltip disappears. Keep uncertain labels raw. */
export async function readFacebookSearchTime(page: Page, row: FacebookSearchRow, assertControlled: () => void) {
  if (!row.displayed_time || /^\d{4}年/.test(row.displayed_time)) return row.displayed_time;
  const sameSource = (link: Locator) => link.evaluate((node, target) => {
    try {
      const source = new URL((node as HTMLAnchorElement).href), expected = new URL(target);
      if (source.origin !== expected.origin || source.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '') || source.searchParams.has('comment_id') || source.searchParams.has('reply_comment_id')) return false;
      return expected.pathname !== '/permalink.php' || ['id','story_fbid'].every(key => source.searchParams.getAll(key).length === 1 && source.searchParams.get(key) === expected.searchParams.get(key));
    } catch { return false; }
  }, row.url);
  assertControlled();
  const candidates = [];
  for (const link of await page.getByRole('main').getByRole('link', { name: row.displayed_time, exact: true }).all()) {
    if (await link.isVisible() && await sameSource(link)) candidates.push(link);
  }
  if (candidates.length !== 1) return row.displayed_time;
  let displayed = row.displayed_time;
  try {
    await page.mouse.move(0, 0);
    const tooltip = page.getByRole('tooltip');
    await tooltip.first().waitFor({ state: 'hidden', timeout: 2000 });
    assertControlled();
    await candidates[0].hover({ timeout: 5000 });
    await tooltip.first().waitFor({ state: 'visible', timeout: 2000 });
    const value = await tooltip.count() === 1 ? (await tooltip.innerText()).trim() : '';
    if (/^\d{4}年\d{1,2}月\d{1,2}日(?:周[一二三四五六日天])?\s*\d{1,2}:\d{2}$/.test(value) && await sameSource(candidates[0]) && await candidates[0].getAttribute('aria-label') === row.displayed_time) displayed = value;
  } catch { /* A missing or changing tooltip cannot invent a publication time. */ }
  assertControlled();
  return displayed;
}

/** A bounded replay of visible search results. An absent anchor fails instead of guessing an offset. */
export async function readFacebookSearchPage(page: Page, request: CollectionRead, assertControlled: () => void, onStep?: (step: string) => void) {
  const config = request.snapshot.discovery;
  requireCondition(config?.platform === 'facebook' && config.provider === 'LOCAL_BROWSER' && config.strategy === 'KEYWORD' && config.keywords.length === 1 && config.browser?.template === 'facebook-search-dom-v1', 'SOURCE_UNSUPPORTED', '当前真实模板读取一个关键词的公开帖子和 Reels 搜索结果');
  const keyword = config.keywords[0], anchor = parseFacebookSearchCursor(request);
  const rows: CollectionRecord[] = [], seen = new Set<string>(); let found = anchor === null, unchanged = 0, previous = '', unparsedVisibleMax = 0;
  assertControlled();
  onStep?.('navigate');
  await page.goto(home + '/search/top?q=' + encodeURIComponent(keyword), { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The document title can arrive before Facebook hydrates its search shell.
  // Reuse the existing main-region wait before asserting its unique scope.
  onStep?.('wait-search-shell');
  await page.getByRole('main', { name: /^(搜索结果|Search results)$/ }).waitFor({ state: 'visible', timeout: 15000 });
  onStep?.('scope');
  await guard(page, keyword);
  const recent = config.max_age_days !== undefined;
  if (recent) {
    onStep?.('recent-filter');
    const filter = page.getByRole('switch', { name: /^(近期帖子|Recent posts)$/ });
    await filter.waitFor({ state: 'visible', timeout: 10000 });
    if (!await filter.isChecked()) { assertControlled(); await filter.click({ timeout: 5000 }); }
    await guard(page, keyword, true);
  }
  onStep?.('wait-content');
  try { await page.getByRole('main').locator('[data-ad-preview="message"]').first().waitFor({ state: 'visible', timeout: 20000 }); }
  catch { await guard(page, keyword); throw new AppError('SOURCE_WINDOW_ENDED', '搜索页面未及时显示可读取正文，不能判断来源已无结果'); }
  // The original Task/guardian still owns the browser and its deadline. Never keep a page across leases.
  for (let scroll = 0; scroll < 18; scroll++) {
    onStep?.('scope');
    assertControlled(); await guard(page, keyword, recent);
    onStep?.('expand');
    const bodies = page.getByRole('main').locator('[data-ad-preview="message"]');
    for (const body of await bodies.all()) {
      assertControlled();
      const expand = body.getByRole('button', { name: /^(展开|See more)$/, exact: true });
      if (await expand.count() === 1 && await expand.isVisible()) {
        await expand.click({ force: true, timeout: 5000 });
        await expand.waitFor({ state: 'hidden', timeout: 5000 });
      }
    }
    onStep?.('parse-dom');
    const current = await page.evaluate(inspectFacebookSearchDom);
    // Each row must have a unique public source and author heading. Mixed/unsupported cards are
    // omitted, never given a guessed identity; coverage remains a partial visible search window.
    unparsedVisibleMax = Math.max(unparsedVisibleMax, current.invalid);
    for (const row of current.rows) {
      if (!found) { seen.add(row.id); if (row.id === anchor) found = true; continue; }
      if (row.id === anchor || seen.has(row.id)) continue;
      // Expanding a post can append another result after the expansion pass. Do not advance the
      // checkpoint past its collapsed text; revisit it on the next bounded render pass.
      if (!row.expanded) break;
      seen.add(row.id);
      const fields: CollectionRecord['fields'] = {};
      onStep?.('publication-time');
      const displayedTime = request.snapshot.fields.includes('created_time') ? await readFacebookSearchTime(page, row, assertControlled) : null;
      for (const field of request.snapshot.fields) fields[field] = field === 'message' ? { kind: 'VALUE', value: row.message } : field === 'author_id' && row.author_id ? { kind: 'VALUE', value: row.author_id } : field === 'created_time' && displayedTime ? { kind: 'DISPLAYED_TIME', value: displayedTime } : { kind: 'NOT_RETURNED' };
      rows.push({ source_object_id: row.id, source_url: row.url, fields });
      if (rows.length === request.limit) break;
    }
    if (rows.length === request.limit) break;
    const signature = current.rows.map(row => row.id).join(',');
    unchanged = signature === previous ? unchanged + 1 : 0; previous = signature;
    // Changing the Recent filter briefly leaves old/group cards, then an empty feed, before
    // public results render. An empty parsed signature is not evidence that this load finished.
    if (unchanged >= 3 && current.rows.length > 0) break;
    onStep?.('scroll');
    assertControlled(); await page.mouse.wheel(0, 900);
    // Allow a bounded render interval, then inspect DOM again; never infer a total from scroll height.
    await page.waitForTimeout(1000);
  }
  onStep?.('final-scope');
  assertControlled(); await guard(page, keyword, recent);
  requireCondition(found, 'CURSOR_EXPIRED', '搜索排序已变化，未找到上页末条记录');
  requireCondition(rows.length, 'SOURCE_WINDOW_ENDED', '当前可见搜索窗口没有更多可验证记录；不代表全平台没有结果');
  return { rows, next_cursor: facebookSearchCursor(request, rows[rows.length - 1].source_object_id), unparsedVisibleMax };
}
