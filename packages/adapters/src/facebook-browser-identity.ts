import type { Page } from '@playwright/test';
import { AppError, requireCondition } from '@kff/core';
import { browserIdentityObservation, type BrowserIdentityObservation } from '../../contracts/src/environment';

const home = 'https://www.facebook.com/';
const labels = {
  editor: /^(编辑个人主页|Edit profile)$/,
  friends: /^(好友|Friends)$/,
};
function profileId(href: string | null) {
  if (!href) return null;
  const url = new URL(href, home);
  return url.origin === new URL(home).origin && url.pathname === '/profile.php' && /^[0-9]{1,128}$/.test(url.searchParams.get('id') ?? '') ? url.searchParams.get('id') : null;
}
async function guard(page: Page) {
  const url = new URL(page.url());
  requireCondition(url.origin === new URL(home).origin, 'IDENTITY_UNVERIFIED', '无法从 Facebook 页面核实身份');
  requireCondition(!/checkpoint|challenge|two_step_verification/.test(url.pathname), 'LOGIN_CHALLENGE', '请在本机完成 Facebook 登录验证');
  const password = page.locator('input[type="password"]:visible');
  requireCondition(!url.pathname.startsWith('/login') && !(await password.count()), 'LOGIN_REQUIRED', '请在当前环境完成 Facebook 登录');
}

/** Follow the visible account menu's /me/ destination; inspect its resolved URL and own-profile controls. */
export async function inspectFacebookProfileIdentity(page: Page, expectedId: string, onStep?: (step: 'navigate' | 'resolve' | 'own-controls' | 'heading' | 'profile-type' | 'final-guard') => void): Promise<BrowserIdentityObservation> {
  requireCondition(/^[0-9]{1,128}$/.test(expectedId), 'INVALID_INPUT', '预期身份 ID 无效');
  onStep?.('navigate');
  try { await page.goto(home + 'me/', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (error) { throw new AppError(error instanceof Error && error.name === 'TimeoutError' ? 'IDENTITY_NAVIGATION_TIMEOUT' : 'IDENTITY_NAVIGATION_FAILED', 'Facebook 身份页导航未完成，请检查当前浏览器连接后重新核验'); }
  await guard(page);
  onStep?.('resolve');
  try { await page.waitForURL(url => Boolean(profileId(url.href)) || /login|checkpoint|challenge|two_step_verification/.test(url.pathname), { timeout: 15000, waitUntil: 'domcontentloaded' }); }
  catch { await guard(page); throw new AppError('IDENTITY_UNVERIFIED', '个人主页身份地址尚未加载完成'); }
  await guard(page);
  const observedId = profileId(page.url());
  requireCondition(observedId, 'IDENTITY_UNVERIFIED', '当前个人主页没有可核对的数字 ID');
  requireCondition(observedId === expectedId, 'ACCOUNT_MISMATCH', '当前 Facebook 操作身份与绑定账号不一致');
  const sourceUrl = home + 'profile.php?id=' + observedId;
  const main = page.getByRole('main');
  const editorLink = main.locator('[data-pagelet="ProfileActions"]').getByRole('link', { name: labels.editor, exact: true });
  const editor = main.getByRole('button', { name: labels.editor, exact: true }).or(editorLink);
  onStep?.('own-controls');
  try { await editor.first().waitFor({ state: 'visible', timeout: 30000 }); }
  catch { await guard(page); throw new AppError('IDENTITY_UNVERIFIED', '未找到自有个人账号的编辑入口'); }
  requireCondition(await editor.count() === 1, 'IDENTITY_UNVERIFIED', '自有个人主页编辑入口不唯一');
  const linkedEditor = await editorLink.count() === 1;
  if (linkedEditor) {
    let verified = false;
    try {
      const href = await editorLink.getAttribute('href');
      const url = new URL(href!, home);
      const entry = JSON.parse(url.searchParams.get('fb_profile_edit_entry_point') ?? 'null');
      verified = profileId(href) === observedId && url.searchParams.get('sk') === 'about' && entry?.feature === 'profile_header' && entry?.click_point === 'edit_profile_button';
    } catch { /* An unrelated or malformed edit link is not ownership evidence. */ }
    requireCondition(verified, 'IDENTITY_UNVERIFIED', '个人主页编辑链接与当前身份不符');
  }
  const heading = main.getByRole('heading', { level: 1 });
  const timeline = main.getByRole('link', { name: /^.+的时间线$/, exact: true });
  onStep?.('heading');
  try { await (linkedEditor ? heading.or(timeline) : heading).first().waitFor({ state: 'visible', timeout: 15000 }); }
  catch { await guard(page); throw new AppError('IDENTITY_UNVERIFIED', '个人主页名称尚未加载完成'); }
  let name = heading;
  let displayName: string;
  if (await heading.count() === 0 && linkedEditor) {
    // The new header has a name button instead of h1. Its name must independently
    // match the visible timeline link for this exact numeric profile, before ProfileActions.
    requireCondition(await timeline.count() === 1 && profileId(await timeline.getAttribute('href')) === observedId, 'IDENTITY_UNVERIFIED', '时间线名称或身份不唯一');
    const timelineLabel = await timeline.getAttribute('aria-label');
    requireCondition(typeof timelineLabel === 'string' && timelineLabel.endsWith('的时间线'), 'IDENTITY_UNVERIFIED', '缺少可核对的时间线名称');
    displayName = timelineLabel.slice(0, -4).trim();
    name = main.getByRole('button', { name: displayName, exact: true });
    requireCondition(displayName.length > 0 && await name.count() === 1 && await name.isVisible(), 'IDENTITY_UNVERIFIED', '个人主页标题与时间线名称不符');
    requireCondition(await name.evaluate(element => {
      const actions = element.closest('main,[role="main"]')?.querySelector('[data-pagelet="ProfileActions"]');
      return Boolean(actions && element.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'IDENTITY_UNVERIFIED', '名称不在自有个人主页标题区域');
  } else {
    requireCondition(await heading.count() === 1, 'IDENTITY_UNVERIFIED', '自有个人主页名称不唯一');
    displayName = (await heading.innerText()).trim();
  }
  onStep?.('profile-type');
  // Facebook defers the profile tabs until the title enters a small viewport.
  await name.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const friendsTab = main.getByRole('tab', { name: labels.friends, exact: true });
  const friendsCount = main.getByRole('link', { name: /^[0-9][0-9,]* 位好友$/, exact: true });
  try { await friendsTab.or(friendsCount).first().waitFor({ state: 'visible', timeout: 15000 }); }
  catch { await guard(page); throw new AppError('IDENTITY_UNVERIFIED', '个人账号页面类型未核实'); }
  if (await friendsTab.count()) {
    requireCondition(await friendsTab.count() === 1 && await friendsTab.isVisible(), 'IDENTITY_UNVERIFIED', '个人账号好友标签不唯一或不可见');
  } else {
    requireCondition(await friendsCount.count() === 1 && await friendsCount.isVisible(), 'IDENTITY_UNVERIFIED', '个人账号好友数量入口不唯一');
    const href = await friendsCount.getAttribute('href');
    // Observed headers use friends_all with the linked editor, and friends with
    // the original h1/button editor. Both still require this exact profile and
    // the count link between its unique name and own ProfileActions below.
    requireCondition(profileId(href) === observedId && new URL(href!, home).searchParams.get('sk') === (linkedEditor ? 'friends_all' : 'friends'), 'IDENTITY_UNVERIFIED', '好友数量入口与当前身份不符');
    requireCondition(await friendsCount.evaluate((element, displayName) => {
      const main = element.closest('main,[role="main"]');
      const actions = main?.querySelector('[data-pagelet="ProfileActions"]');
      const names = [...(main?.querySelectorAll('h1,[role="heading"][aria-level="1"],[role="button"]') ?? [])].filter(node => (node.textContent ?? '').trim() === displayName);
      return Boolean(!element.closest('article,[role="article"]') && actions && names.length === 1 && names[0].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING && element.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, displayName), 'IDENTITY_UNVERIFIED', '好友数量入口不在本人主页标题区域');
  }
  onStep?.('final-guard');
  requireCondition(profileId(page.url()) === observedId, 'ACCOUNT_MISMATCH', '核验过程中个人主页身份发生变化');
  await guard(page);
  return browserIdentityObservation.parse({ method: 'facebook-profile-dom-v1', authenticated: true, operating_identity_id: observedId, account_type: 'profile', display_name: displayName, observed_at: new Date().toISOString(), source_url: sourceUrl });
}
