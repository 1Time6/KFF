import type { Locator } from '@playwright/test';
import type { ActionReport, AgentCommand } from '@kff/contracts';
import { collectionSnapshotSchema } from '@kff/contracts';
import { AppError, digest, requireCondition } from '@kff/core';
import type { ExecutorHooks } from './fixture';
import { openManagedBrowser } from './browser-profile';
import { assertTemplateSnapshot } from './templates';
import { inspectFacebookProfileIdentity } from './facebook-browser-identity';
import { readFacebookCommentsPage } from './facebook-browser-comments';
import { inspectFacebookCommentsDom } from './facebook-comments-dom';
import { inspectFacebookCommentRepliesDom } from './facebook-comment-reply-dom';

export function facebookCommentEditorName(author: string) {
  return new RegExp('^(回复 ?|Reply to )'+author.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(…|\\.\\.\\.)$');
}

/** One explicitly approved public reply. Public authors are never turned into Messenger recipients. */
export async function executeFacebookBrowserComment(command: AgentCommand, root: string, hooks: ExecutorHooks): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  const snapshot = command.snapshot, outreach = snapshot.outreach, source = outreach?.browser, environment = snapshot.browser_environment;
  requireCondition(snapshot.capability_key === 'facebook.comment.reply.browser' && !snapshot.is_synthetic && source && outreach && environment?.configuration.driver === 'adspower', 'SOURCE_UNSUPPORTED', '需要指定公开评论与 AdsPower 环境');
  requireCondition(process.env.KFF_ENABLE_LIVE === 'true', 'LIVE_DISABLED', '真实发送未启用');
  requireCondition(digest(snapshot) === command.snapshot_hash && digest(snapshot.body) === snapshot.content_hash && digest(source.source_body) === source.source_content_hash, 'APPROVAL_STALE', '已审核正文或来源快照变化');
  assertTemplateSnapshot(snapshot); hooks.assertControlled();
  const managed = await openManagedBrowser(root, environment, false);
  let intent = false, step = 'facebook-comment-identity', editor: Locator | undefined;
  try {
    hooks.onContext(managed.context); const page = await managed.context.newPage(); page.setDefaultTimeout(10000);
    await inspectFacebookProfileIdentity(page, snapshot.external_account_id); hooks.assertControlled();
    const request = { query_id: outreach.observation_id, cursor: null, limit: 100, snapshot: collectionSnapshotSchema.parse({ schema_version:'kff.collection.v1',title:'Verify the approved public comment',source_key:'social.discovery',source_version:'social-discovery-v1',source_type:'SOCIAL_DISCOVERY',account_id:snapshot.account_id,account_version:snapshot.account_version,external_account_id:snapshot.external_account_id,browser_environment:environment,targets:[snapshot.external_account_id],fields:['message','author_id','created_time'],purpose:'lead_discovery',allowed_purposes:['lead_discovery'],mode:'CONTROLLED_PILOT',incremental_rule:'append_observations',max_records:100,max_pages:1,page_size:100,display_timezone:'Asia/Shanghai',retention_days:1,scenario:'normal',discovery:{platform:'facebook',strategy:'COMMENTS',provider:'LOCAL_BROWSER',browser:{environment_id:environment.environment_id,template:'facebook-comments-dom-v1',comment_order:source.comment_order??'NEWEST'},keywords:['verification'],target:source.source_url,processing_basis:outreach.authorization_basis}}) };
    await readFacebookCommentsPage(page, request, hooks.assertControlled, value => { step = 'facebook-comment-read-' + value; });
    const verifySource = async () => {
      hooks.assertControlled(); requireCondition(Date.parse(source.expires_at) > Date.now(), 'CONTACT_WINDOW_CLOSED', '动作期限已过');
      const url = new URL(page.url()); requireCondition(url.origin === 'https://www.facebook.com' && url.pathname.replace(/\/$/, '') === new URL(source.source_url).pathname.replace(/\/$/, ''), 'COLLECTION_SOURCE_MISMATCH', '当前页面离开指定帖子');
      const current = await page.evaluate(inspectFacebookCommentsDom, source.source_url), matches = current.rows.filter(row => row.id === outreach.source_object_id);
      requireCondition(current.publicPost && matches.length === 1 && matches[0].expanded && matches[0].author_id === outreach.author_id && matches[0].url === source.comment_url && digest(matches[0].message) === source.source_content_hash && matches[0].displayed_time === source.displayed_time, 'OUTREACH_STALE', '原评论、作者、公开范围或内容已变化');
    };
    step = 'facebook-comment-source'; await verifySource();
    const parent = page.getByRole('article', { name: /^(评论者：|Comment by )/ }).filter({ has: page.locator('a[href*="comment_id=' + source.comment_id + '"]') });
    requireCondition(await parent.count() === 1, 'BROWSER_LOCATOR_AMBIGUOUS', '原评论容器不唯一');
    step = 'facebook-comment-author';
    const authorName = await parent.evaluate((el, author) => {
      const links = [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(link => !link.closest('[aria-hidden="true"]') && link.getBoundingClientRect().width > 0 && link.innerText.trim() && new URL(link.href).pathname === '/profile.php' && new URL(link.href).searchParams.get('id') === author);
      return links.length === 1 ? links[0].innerText.trim() : null;
    }, outreach.author_id);
    requireCondition(authorName, 'OUTREACH_STALE', '原评论作者显示名称不唯一');
    for (const input of await page.getByRole('textbox').all()) requireCondition(!(await input.innerText()).trim(), 'DRAFT_PRESENT', '页面已有草稿，请先人工处理');
    step = 'facebook-comment-existing-replies';
    const initial = await page.evaluate(inspectFacebookCommentRepliesDom, source);
    requireCondition(!initial.invalid, 'NEEDS_HUMAN', '已有回复存在无法核对的显示内容');
    step = 'facebook-comment-prepare';
    const reply = parent.getByRole('button', { name: /^(回复|Reply)$/, exact: true });
    requireCondition(await reply.count() === 1, 'BROWSER_LOCATOR_AMBIGUOUS', '原评论回复入口不唯一');
    await reply.click({ timeout: 10000 });
    const editorName = facebookCommentEditorName(authorName);
    editor = page.getByRole('textbox', { name: editorName });
    requireCondition(await editor.count() === 1, 'BROWSER_LOCATOR_AMBIGUOUS', '指定作者的回复输入框不唯一');
    const originalDraft = (await editor.innerText()).trim();
    requireCondition(!originalDraft || originalDraft === authorName, 'DRAFT_PRESENT', '回复框已有正文，请人工核对');
    // Observed Reel layouts put the composer one or two wrappers above the article.
    // Stop at that bound and require a single comment; never expand to the whole page.
    step = 'facebook-comment-prepare-scope';
    let scope = parent.locator('..');
    if (await scope.getByRole('textbox', { name: editorName }).count() === 0) scope = scope.locator('..');
    requireCondition(await scope.getByRole('textbox', { name: editorName }).count() === 1 && await scope.getByRole('article', { name: /^(评论者：|Comment by )/ }).count() === 1, 'OUTREACH_STALE', '回复输入框不属于唯一的原评论');
    const send = scope.getByRole('button', { name: /^(发布评论|Post comment)$/, exact: true });
    requireCondition(await send.count() === 1, 'BROWSER_LOCATOR_AMBIGUOUS', '原评论提交入口不唯一');
    await editor.fill(snapshot.body); step = 'facebook-comment-prepare-source'; await verifySource();
    step = 'facebook-comment-prepare-replies';
    const currentReplies = await page.evaluate(inspectFacebookCommentRepliesDom, source);
    requireCondition(digest(currentReplies) === digest(initial), 'OUTREACH_STALE', '准备期间评论回复已变化，请重新审核');
    requireCondition((await editor.innerText()).trim() === snapshot.body && await send.isEnabled(), 'APPROVAL_STALE', '回复正文或提交入口变化');
    await send.scrollIntoViewIfNeeded(); await send.click({ trial: true, timeout: 10000 });
    await hooks.beforeSubmit(); intent = true; step = 'facebook-comment-submit';
    await verifySource();
    requireCondition((await editor.innerText()).trim() === snapshot.body && digest(await page.evaluate(inspectFacebookCommentRepliesDom, source)) === digest(initial), 'SUBMISSION_UNCERTAIN', '提交许可后页面内容变化');
    await send.click({ timeout: 10000 }); step = 'facebook-comment-verify';
    let result;
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      hooks.assertControlled(); const current = await page.evaluate(inspectFacebookCommentRepliesDom, source);
      const matches = current.rows.filter(row => !initial.rows.some(old => old.id === row.id) && row.author_id === snapshot.external_account_id && digest(row.body) === snapshot.content_hash);
      if (!current.invalid && matches.length === 1) { result = matches[0]; break; }
      await page.waitForTimeout(250);
    }
    requireCondition(result, 'SUBMISSION_UNCERTAIN', '未取得唯一的新回复标识、作者和正文，不会重新提交');
    await inspectFacebookProfileIdentity(page, snapshot.external_account_id); hooks.assertControlled();
    return { outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:result.id,parent_id:source.comment_id,source_url:result.url,recipient_id:outreach.author_id,actual_account_id:snapshot.external_account_id,content_hash:snapshot.content_hash,evidence_kind:'browser_comment',observed_at:new Date().toISOString()},diagnostic:{step:'facebook-comment-verified',browser_version:managed.context.browser()?.version()} };
  } catch (error) {
    const code = error instanceof AppError ? error.code : error instanceof Error && error.name === 'TimeoutError' ? 'BROWSER_STEP_TIMEOUT' : 'EXECUTOR_ERROR';
    return {outcome:intent?'UNKNOWN_OUTCOME':code==='STOP_REQUESTED'?'CANCELED':code==='NEEDS_HUMAN'?'NEEDS_HUMAN':'BLOCKED',error_code:code,diagnostic:{step}};
  } finally {
    if (!intent && editor && (await editor.innerText().catch(() => '')).trim() === snapshot.body) await editor.fill('').catch(() => {});
    await managed.close(); hooks.onContext(null);
  }
}
