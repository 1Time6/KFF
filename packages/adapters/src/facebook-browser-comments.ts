import type { Page } from '@playwright/test';
import type { CollectionRecord } from '@kff/contracts';
import { AppError, requireCondition } from '@kff/core';
import type { CollectionRead } from './collection-fixture';
import { facebookSearchCursor, parseFacebookSearchCursor } from './facebook-browser-discovery';
import { inspectFacebookCommentsDom } from './facebook-comments-dom';

async function guard(page: Page, target: string) {
  const url = new URL(page.url());
  requireCondition(url.origin === 'https://www.facebook.com', 'COLLECTION_SOURCE_MISMATCH', '评论页面离开指定平台');
  requireCondition(!/checkpoint|challenge|two_step_verification/.test(url.pathname), 'LOGIN_CHALLENGE', '平台要求人工验证');
  requireCondition(!url.pathname.startsWith('/login') && !await page.locator('input[type="password"]:visible').count(), 'LOGIN_REQUIRED', '评论读取需要重新登录');
  requireCondition(url.pathname.replace(/\/$/,'') === new URL(target).pathname.replace(/\/$/,''), 'COLLECTION_SOURCE_MISMATCH', '当前帖子与固定来源不一致');
}

/** Newest-first replay, or one explicitly selected visible window without ordered pagination. */
export async function readFacebookCommentsPage(page: Page, request: CollectionRead, assertControlled: () => void, onStep?: (step: string) => void) {
  const config = request.snapshot.discovery;
  requireCondition(config?.platform === 'facebook' && config.provider === 'LOCAL_BROWSER' && config.strategy === 'COMMENTS' && config.browser?.template === 'facebook-comments-dom-v1', 'SOURCE_UNSUPPORTED', '当前评论模板仅支持固定 Facebook 公开帖子');
  const target = config.target, anchor = parseFacebookSearchCursor(request);
  const visibleWindow = config.browser.comment_order === 'VISIBLE_WINDOW';
  requireCondition(!visibleWindow || request.cursor === null && request.snapshot.max_pages === 1, 'SOURCE_UNSUPPORTED', '当前可见窗口不允许排序游标分页');
  requireCondition(!anchor || /^facebook:comment:[0-9]{1,80}$/.test(anchor), 'CURSOR_EXPIRED', '评论检查点类型不符');
  onStep?.('navigate');
  assertControlled(); await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }); await guard(page, target);
  onStep?.('wait-comments');
  const reel = /^\/reel\/[0-9]+\/$/.test(new URL(target).pathname);
  if (reel) {
    onStep?.('wait-comment-entry');
    // The observed Reel layout renders its action bar outside <main>, so a main-scoped lookup finds
    // nothing at all. The viewport check below is what rejects a neighbouring reel's button; the
    // main scope was never the safety property and its removal does not loosen that check.
    const buttons = page.getByRole('button', { name: /^(评论|Comments)$/, exact: true });
    await buttons.first().waitFor({ state: 'visible', timeout: 20000 });
    onStep?.('locate-comment-entry');
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const visible = [];
    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      if (box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height) visible.push(button);
    }
    requireCondition(visible.length === 1, 'COLLECTION_SOURCE_MISMATCH', '当前 Reel 的评论入口不唯一，不能选择相邻视频');
    onStep?.('click-comment-entry');
    assertControlled(); await visible[0].click({ timeout: 5000 }); await guard(page, target);
  }
  let dialog = reel ? page.getByRole('complementary') : page.getByRole('dialog').last();
  onStep?.(reel ? 'wait-sidebar' : 'wait-dialog');
  if(reel) {
    // Wait within the original bound for either the ARIA sidebar or the verified roleless panel.
    const deadline=Date.now()+20000;
    for(;;) {
      assertControlled();await guard(page,target);
      if(await dialog.isVisible())break;
      const scope=await page.evaluate(inspectFacebookCommentsDom,target);
      if(scope.container_path){dialog=page.locator(scope.container_path);break;}
      requireCondition(Date.now()<deadline,'SOURCE_WINDOW_ENDED','评论区域未在限定时间内显示可核实的公开来源');
      await page.waitForTimeout(250);
    }
  } else await dialog.waitFor({ state: 'visible', timeout: 20000 });
  const comments = dialog.getByRole('article', { name: /^(评论者：|Comment by )/ });
  const sort = dialog.getByRole('button', { name: /^(最相关|由新到旧|所有评论|Most relevant|Newest|All comments)$/ });
  const empty = dialog.getByRole('heading', { name: /^(还没有任何评论哦|No comments yet)$/ });
  onStep?.('wait-comment-controls');
  try { await (visibleWindow ? comments.first().or(empty) : sort.or(empty)).first().waitFor({ state: 'visible', timeout: 20000 }); }
  catch { await guard(page, target); if(!visibleWindow&&await comments.count())throw new AppError('SOURCE_SORT_UNAVAILABLE','页面未提供排序控件；需明确选择仅采集当前可见窗口'); throw new AppError('SOURCE_WINDOW_ENDED', '评论区域未及时加载，无法确认空结果'); }
  assertControlled();
  requireCondition((await page.evaluate(inspectFacebookCommentsDom, target)).publicPost, 'COLLECTION_SOURCE_MISMATCH', '未找到与来源匹配的公开帖子');
  if (await empty.isVisible() && !await comments.count()) {
    requireCondition(!anchor, 'CURSOR_EXPIRED', '原评论检查点已不可见');
    return { rows: [] as CollectionRecord[], next_cursor: null, unparsedVisibleMax: 0 };
  }
  if (!visibleWindow) {
    requireCondition(await sort.count() === 1, 'COLLECTION_SOURCE_MISMATCH', '评论排序入口不唯一');
    if (!/^(由新到旧|Newest)$/.test((await sort.innerText()).trim())) {
    onStep?.('open-sort-menu');
    // The small-window Reel layout places this control under the fixed composer.
    // Let Playwright scroll and verify the click target instead of forcing a covered point.
    await sort.click({ timeout: 10000 }); assertControlled();
    onStep?.('choose-newest');
    await page.getByRole('menuitem', { name: /^(由新到旧 显示所有评论，优先显示最新评论。|Newest\b)/ }).click({ timeout: 10000 });
    }
    onStep?.('wait-newest');
    await dialog.getByRole('button', { name: /^(由新到旧|Newest)$/, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  }
  onStep?.('wait-rows');
  await comments.first().waitFor({ state: 'visible', timeout: 20000 });
  const rows: CollectionRecord[] = [], seen = new Set<string>(); let found = anchor === null, unchanged = 0, previous = '', unparsedVisibleMax = 0;
  for (let pass = 0; pass < 15; pass++) {
    onStep?.('scope');
    assertControlled(); await guard(page, target);
    if(!visibleWindow)requireCondition(await dialog.getByRole('button', { name: /^(由新到旧|Newest)$/, exact: true }).isVisible(), 'COLLECTION_SOURCE_MISMATCH', '评论排序已变化');
    onStep?.('expand');
    for (const body of await comments.locator('span[dir="auto"][lang]').all()) {
      assertControlled(); const expand = body.getByRole('button', { name: /^(展开|See more)$/, exact: true });
      if (await expand.count() === 1 && await expand.isVisible()) { await expand.click({ force: true, timeout: 5000 }); await expand.waitFor({ state: 'hidden', timeout: 5000 }); }
    }
    onStep?.('parse-dom');
    const current = await page.evaluate(inspectFacebookCommentsDom, target);
    requireCondition(current.publicPost, 'COLLECTION_SOURCE_MISMATCH', '评论所属公开帖子已变化');
    unparsedVisibleMax = Math.max(unparsedVisibleMax, current.invalid);
    for (const row of current.rows) {
      if (!found) { seen.add(row.id); if (row.id === anchor) found = true; continue; }
      if (row.id === anchor || seen.has(row.id)) continue;
      if (!row.expanded) break;
      seen.add(row.id); const fields: CollectionRecord['fields'] = {};
      for (const field of request.snapshot.fields) fields[field] = field === 'message' ? { kind: 'VALUE', value: row.message } : field === 'author_id' && row.author_id ? { kind: 'VALUE', value: row.author_id } : field==='created_time'&&row.displayed_time?{kind:'DISPLAYED_TIME',value:row.displayed_time}:{ kind: 'NOT_RETURNED' };
      rows.push({ source_object_id: row.id, source_url: row.url, fields }); if (rows.length === request.limit) break;
    }
    if (rows.length === request.limit || visibleWindow) break;
    const signature = current.rows.map(row => row.id).join(','); unchanged = signature === previous ? unchanged + 1 : 0; previous = signature;
    if (unchanged >= 3) break;
    onStep?.('scroll');
    assertControlled(); await comments.last().scrollIntoViewIfNeeded({ timeout: 5000 });
    const box = await comments.last().boundingBox(); if (box) await page.mouse.move(box.x + Math.min(box.width / 2, 200), Math.max(1, box.y + Math.min(box.height / 2, 40)));
    await page.mouse.wheel(0, 800); await page.waitForTimeout(1000);
  }
  onStep?.('final-scope');
  assertControlled(); await guard(page, target);
  requireCondition(found, 'CURSOR_EXPIRED', '原评论检查点不可见，不能按数量猜测位置');
  requireCondition(rows.length, 'SOURCE_WINDOW_ENDED', '当前评论窗口无更多可核对记录，未声明所有评论已采完');
  return { rows, next_cursor: visibleWindow ? null : facebookSearchCursor(request, rows[rows.length - 1].source_object_id), unparsedVisibleMax };
}
