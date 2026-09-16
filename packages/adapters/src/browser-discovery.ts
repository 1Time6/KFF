import { z } from 'zod';
import { collectionRecordSchema, type ActionReport, type AgentCommand, type CollectionRecord } from '@kff/contracts';
import { AppError, digest, requireCondition, validateTargetUrl } from '@kff/core';
import { normalizeCollectionPage } from './collection-fixture';
import { openManagedBrowser } from './browser-profile';
import { assertTemplateSnapshot } from './templates';
import type { ExecutorHooks } from './fixture';
import { inspectFacebookProfileIdentity } from './facebook-browser-identity';
import { readFacebookSearchPage } from './facebook-browser-discovery';
import { readFacebookCommentsPage } from './facebook-browser-comments';
import { readFacebookPagePage } from './facebook-browser-page';

/** Keep diagnostic categories useful without storing page text, URLs, cookies or error call logs. */
export function browserDiscoveryErrorCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof z.ZodError) return 'COLLECTION_INVALID_PAGE';
  if (!(error instanceof Error)) return 'EXECUTOR_ERROR';
  if (error.name === 'TimeoutError') return 'BROWSER_STEP_TIMEOUT';
  if (/Target page, context or browser has been closed|Target closed/.test(error.message)) return 'BROWSER_CONTEXT_CLOSED';
  if (/strict mode violation/.test(error.message)) return 'BROWSER_LOCATOR_AMBIGUOUS';
  if (/page\.evaluate:/.test(error.message)) return 'BROWSER_EVALUATION_FAILED';
  if (/net::ERR_/.test(error.message)) return 'BROWSER_NAVIGATION_FAILED';
  return 'EXECUTOR_ERROR';
}

export async function executeFacebookBrowserDiscovery(command: AgentCommand, root: string, hooks: ExecutorHooks): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  const snapshot = command.snapshot, request = snapshot.collection, environment = snapshot.browser_environment;
  requireCondition(!snapshot.is_synthetic && snapshot.mode === 'CONTROLLED_PILOT' && snapshot.capability_key === 'facebook.discovery.read.browser' && snapshot.adapter_version === 'facebook-search-browser-v1' && request && environment?.account_type === 'profile' && environment.platform === 'facebook' && ['facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1'].includes(request.snapshot.discovery?.browser?.template ?? '') && !snapshot.body && !snapshot.message && !snapshot.inbox && !snapshot.outreach, 'FORBIDDEN_SCOPE', '当前真实浏览器能力仅允许固定的公开内容读取');
  requireCondition(process.env.KFF_ENABLE_DISCOVERY === 'true', 'DISCOVERY_DISABLED', '真实采集尚未开启');
  requireCondition(digest(snapshot) === command.snapshot_hash && digest(request.snapshot) === request.snapshot_hash && digest(environment) === digest(request.snapshot.browser_environment), 'APPROVAL_STALE', '采集或环境快照不匹配');
  const assertControlled = () => { hooks.assertControlled(); requireCondition(request.expires_at && Date.parse(request.expires_at) > Date.now(), 'RETENTION_EXPIRED', '查询保留期已结束'); };
  assertTemplateSnapshot(snapshot); assertControlled();
  const managed = await openManagedBrowser(root, environment, false);
  const source = request.snapshot.discovery?.strategy === 'COMMENTS' ? 'facebook-comments' : request.snapshot.discovery?.strategy === 'PAGE' ? 'facebook-page' : 'facebook-search';
  let step = source + '-identity-before'; let resultCount = 0;
  try {
    hooks.onContext(managed.context);
    const page = await managed.context.newPage(); page.setDefaultTimeout(10000);
    await inspectFacebookProfileIdentity(page, snapshot.external_account_id, phase => { step = source + '-before-' + phase; }); assertControlled();
    step = source + '-read';
    const data = await (source === 'facebook-comments' ? readFacebookCommentsPage : source === 'facebook-page' ? readFacebookPagePage : readFacebookSearchPage)(page, request, assertControlled, phase => { step = source + '-read-' + phase; }), observed = new Date().toISOString();
    resultCount = data.rows.length; step = source + '-identity-after';
    await inspectFacebookProfileIdentity(page, snapshot.external_account_id, phase => { step = source + '-after-' + phase; }); assertControlled();
    step = source + '-normalize';
    const collectionPage = normalizeCollectionPage({ schema_version: 'kff.collection-page.v1', source_key: request.snapshot.source_key, source_version: request.snapshot.source_version, query_id: request.query_id, account_external_id: snapshot.external_account_id, cursor: request.cursor, next_cursor: data.next_cursor, observed_at: observed, reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY', rows: data.rows }, request);
    return { outcome: 'VERIFIED_SUCCEEDED', collection_page: collectionPage, receipt: { remote_id: 'collection:' + request.run_id + ':' + request.page_number, actual_account_id: snapshot.external_account_id, content_hash: digest(collectionPage), evidence_kind: 'browser_dom', observed_at: observed }, diagnostic: { step: source + '-visible', browser_version: managed.context.browser()?.version(), scene: { identity_count: 1, submit_controls: 0, result_count: data.rows.length, unparsed_visible_max: data.unparsedVisibleMax } } };
  } catch (error) {
    return { outcome: 'BLOCKED', error_code: browserDiscoveryErrorCode(error), diagnostic: { step, browser_version: managed.context.browser()?.version(), scene: { identity_count: step === source + '-identity-before' || step.startsWith(source + '-before-') ? 0 : 1, submit_controls: 0, result_count: resultCount } } };
  } finally { await managed.close(); hooks.onContext(null); }
}

export async function executeBrowserDiscovery(command: AgentCommand, root: string, hooks: ExecutorHooks, fixtureOrigin = 'http://127.0.0.1:4311'): Promise<Omit<ActionReport, 'event_id' | 'command_id'>> {
  const snapshot = command.snapshot, request = snapshot.collection, environment = snapshot.browser_environment;
  requireCondition(snapshot.capability_key === 'kff.fixture.discovery.read.browser' && snapshot.adapter_version === 'browser-discovery-v1' && snapshot.is_synthetic && snapshot.mode === 'TEST_ONLY' && request && environment && request.snapshot.discovery?.browser?.template === 'fixture-discovery-dom-v1', 'FORBIDDEN_SCOPE', '当前采集模板只支持本地合成评论');
  requireCondition(digest(snapshot) === command.snapshot_hash && digest(request.snapshot) === request.snapshot_hash && digest(environment) === digest(request.snapshot.browser_environment), 'APPROVAL_STALE', '采集快照或浏览器绑定不一致');
  const assertControlled = () => { hooks.assertControlled(); requireCondition(Date.parse(request.expires_at ?? command.expires_at) > Date.now(), 'RETENTION_EXPIRED', '查询保留期已结束'); };
  assertTemplateSnapshot(snapshot); assertControlled();
  const origin = new URL(fixtureOrigin);
  requireCondition(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'FORBIDDEN_SCOPE', '合成采集只允许本机固定来源');
  const managed = await openManagedBrowser(root, environment, true);
  try {
    hooks.onContext(managed.context);
    await managed.context.route('**/*', route => {
      try { validateTargetUrl(route.request().url(), [], origin.origin); requireCondition(route.request().method() === 'GET', 'FORBIDDEN_SCOPE', '采集不能提交数据'); return route.continue(); }
      catch { return route.abort('blockedbyclient'); }
    });
    const page = await managed.context.newPage(); page.setDefaultTimeout(10000);
    const url = new URL('/browser-discovery', origin);
    url.searchParams.set('request', JSON.stringify({ query_id: request.query_id, snapshot: request.snapshot, cursor: request.cursor, limit: request.limit }));
    assertControlled(); const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    requireCondition(response?.ok(), 'REMOTE_ERROR', '采集页面未正常返回');
    for (const [selector, expected] of [['login-identity', environment.configuration.login_account_id], ['account-identity', snapshot.external_account_id]] as const) {
      const locator = page.getByTestId(selector);
      requireCondition(await locator.count() === 1 && await locator.isVisible(), 'AUTH_EXPIRED', '页面缺少唯一可见账号身份');
      requireCondition((await locator.innerText()).trim() === expected, 'ACCOUNT_MISMATCH', '登录账号或操作身份与指定环境不一致');
    }
    const main = page.getByTestId('discovery-page');
    requireCondition(await main.count() === 1 && await main.isVisible(), 'COLLECTION_SOURCE_MISMATCH', '采集区域不唯一或不可见');
    requireCondition(await main.getAttribute('data-query-id') === request.query_id && await main.getAttribute('data-target') === request.snapshot.discovery.target && await main.getAttribute('data-cursor') === (request.cursor ?? ''), 'COLLECTION_SOURCE_MISMATCH', '当前页面目标或游标与任务不一致');
    const next = await main.getAttribute('data-next-cursor'); requireCondition(next !== null, 'COLLECTION_SOURCE_MISMATCH', '页面缺少下一页状态');
    const items = main.getByTestId('discovery-row'), count = await items.count();
    requireCondition(count <= request.limit, 'COLLECTION_LIMIT_EXCEEDED', '页面记录超过单页上限');
    const rows: CollectionRecord[] = [];
    for (const item of await items.all()) {
      assertControlled(); requireCondition(await item.isVisible(), 'COLLECTION_INVALID_PAGE', '记录不可见');
      const link = item.locator('a[data-source-url]'); requireCondition(await link.count() === 1 && await link.isVisible(), 'COLLECTION_SOURCE_MISMATCH', '记录来源链接不唯一');
      const fields: CollectionRecord['fields'] = {};
      requireCondition(await item.locator('[data-field]').count() === request.snapshot.fields.length, 'COLLECTION_FIELDS_MISMATCH', '记录字段集合不符');
      for (const field of request.snapshot.fields) {
        const node = item.locator('[data-field="' + field + '"]');
        requireCondition(await node.count() === 1 && await node.isVisible(), 'COLLECTION_FIELDS_MISMATCH', '字段缺失、重复或不可见');
        const kind = z.enum(['VALUE','NULL','NOT_RETURNED','HIDDEN']).parse(await node.getAttribute('data-kind'));
        if (kind !== 'VALUE') { fields[field] = { kind }; continue; }
        const text = await node.innerText(), type = await node.getAttribute('data-value-type');
        requireCondition(type === 'string' || type === 'number' && /^(0|[1-9][0-9]*)$/.test(text), 'COLLECTION_FIELDS_MISMATCH', '字段类型不明确');
        fields[field] = { kind, value: type === 'number' ? Number(text) : text };
      }
      rows.push(collectionRecordSchema.parse({ source_object_id: await item.getAttribute('data-object-id'), source_url: await link.getAttribute('href'), fields }));
    }
    assertControlled();
    const observed = new Date().toISOString();
    const collectionPage = normalizeCollectionPage({ schema_version: 'kff.collection-page.v1', source_key: request.snapshot.source_key, source_version: request.snapshot.source_version, query_id: request.query_id, account_external_id: snapshot.external_account_id, cursor: request.cursor, next_cursor: next || null, observed_at: observed, reported_total: null, coverage: 'SYNTHETIC_SAMPLE', rows }, request);
    return { outcome: 'VERIFIED_SUCCEEDED', collection_page: collectionPage, receipt: { remote_id: 'collection:' + request.run_id + ':' + request.page_number, actual_account_id: snapshot.external_account_id, content_hash: digest(collectionPage), evidence_kind: 'synthetic_dom', observed_at: observed }, diagnostic: { step: 'browser-collection-read', browser_version: managed.context.browser()?.version(), scene: { identity_count: 1, submit_controls: 0, result_count: rows.length } } };
  } finally { await managed.close(); hooks.onContext(null); }
}
