import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { discoveryConfig, discoveryIsSynthetic, monitorInput } from '../../packages/contracts/src/acquisition';
import { fixedPageManifest } from '../../packages/adapters/src/templates';
import { collectionSnapshotSchema, templateManifestSchema } from '@kff/contracts';
import { normalizeCollectionPage } from '../../packages/adapters/src/collection-fixture';
import { facebookSearchCursor, parseFacebookSearchCursor } from '../../packages/adapters/src/facebook-browser-discovery';
import { executionEnabled } from '@kff/core';
import { AppError } from '@kff/core';
import { z } from 'zod';
import { browserDiscoveryErrorCode } from '../../packages/adapters/src/browser-discovery';

export function request() {
  const accountId = randomUUID(), environmentId = randomUUID();
  const discovery = discoveryConfig.parse({ platform: 'facebook', strategy: 'KEYWORD', provider: 'LOCAL_BROWSER', browser: { environment_id: environmentId, template: 'facebook-search-dom-v1' }, keywords: ['八字测算'], target: '', processing_basis: '读取当前账号可见的公开帖子，保留来源供人工筛选。' });
  return { query_id: randomUUID(), cursor: null as string | null, limit: 2, snapshot: collectionSnapshotSchema.parse({ title: 'Local contract only', source_key: 'social.discovery', account_id: accountId, targets: ['1234'], fields: ['message','author_id','reaction_count','comment_count','created_time'], purpose: 'lead_discovery', mode: 'CONTROLLED_PILOT', incremental_rule: 'append_observations', max_records: 10, max_pages: 5, page_size: 2, display_timezone: 'UTC', retention_days: 1, scenario: 'normal', schema_version: 'kff.collection.v1', source_version: 'social-discovery-v1', source_type: 'SOCIAL_DISCOVERY', account_version: 1, external_account_id: '1234', allowed_purposes: ['lead_discovery'], discovery, browser_environment: { environment_id: environmentId, account_id: accountId, agent_id: randomUUID(), organization_id: randomUUID(), brand_id: randomUUID(), profile_key: randomUUID(), configuration_version: 1, platform: 'facebook', account_type: 'profile', is_synthetic: false, configuration: { driver: 'native', provider_profile_id: null, login_account_id: '1234', operating_identity_id: '1234', locale: 'en-US', timezone_id: 'UTC', proxy_ref: null } } }) };
}
it('allows canonical Reel comments without loosening source identity or tracking checks', () => {
  const read = request(), target = 'https://www.facebook.com/reel/2163157911082094/';
  const config = { ...read.snapshot.discovery!, strategy: 'COMMENTS', target, browser: { ...read.snapshot.discovery!.browser!, template: 'facebook-comments-dom-v1' } };
  read.snapshot.discovery = discoveryConfig.parse(config);
  for (const changed of [target + '?comment_id=12', target.replace('/reel/', '/watch/'), target.replace('www.facebook.com', 'facebook.com'), target.replace('2163157911082094', 'not-an-id')]) expect(discoveryConfig.safeParse({ ...config, target: changed }).success).toBe(false);
  const row = { source_object_id: 'facebook:comment:123', source_url: target + '?comment_id=123', fields: Object.fromEntries(read.snapshot.fields.map(field => [field, { kind: 'NOT_RETURNED' }])) };
  const page = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: read.query_id, account_external_id: '1234', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY', rows: [row] };
  expect(normalizeCollectionPage(page, read).rows).toHaveLength(1);
  expect(() => normalizeCollectionPage({ ...page, rows: [{ ...row, source_url: row.source_url.replace('2163157911082094', '999') }] }, read)).toThrowError(expect.objectContaining({ code: 'COLLECTION_SOURCE_MISMATCH' }));
});
it('pins Page reads to a numeric publisher and validates that publisher on every returned post', () => {
  const read = request(), publisher = '000123456';
  const config = { ...read.snapshot.discovery!, strategy: 'PAGE', target: 'https://www.facebook.com/' + publisher + '/', browser: { ...read.snapshot.discovery!.browser!, template: 'facebook-page-dom-v1' } };
  read.snapshot.discovery = discoveryConfig.parse(config);
  for (const change of [{ target: 'https://www.facebook.com/vanity/' }, { target: config.target + '?tracking=1' }, { target: config.target.replace('www.facebook.com', 'facebook.com') }, { strategy: 'COMMENTS' }, { platform: 'instagram' }, { credential_ref: 'FACEBOOK_TEST' }, { browser: { ...config.browser, comment_order: 'VISIBLE_WINDOW' } }]) expect(discoveryConfig.safeParse({ ...config, ...change }).success).toBe(false);
  const row = { source_object_id: 'facebook:post:pfbid0123456789abcdef', source_url: 'https://www.facebook.com/permalink.php?story_fbid=pfbid0123456789abcdef&id=' + publisher, fields: { ...Object.fromEntries(read.snapshot.fields.map(field => [field, { kind: 'NOT_RETURNED' }])), author_id: { kind: 'VALUE', value: publisher } } };
  const page = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: read.query_id, account_external_id: '1234', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY', rows: [row] };
  expect(normalizeCollectionPage(page, read).rows).toHaveLength(1);
  for (const changed of [{ source_url: row.source_url + '&tracking=1' }, { source_url: row.source_url.replace(publisher, '999') }, { source_object_id: 'facebook:post:123' }, { fields: { ...row.fields, author_id: { kind: 'NOT_RETURNED' } } }, { fields: { ...row.fields, author_id: { kind: 'VALUE', value: '999' } } }]) expect(() => normalizeCollectionPage({ ...page, rows: [{ ...row, ...changed }] }, read)).toThrowError(expect.objectContaining({ code: 'COLLECTION_SOURCE_MISMATCH' }));
  const reel = { ...row, source_object_id: 'facebook:reel:00123', source_url: 'https://www.facebook.com/reel/00123/' };
  expect(normalizeCollectionPage({ ...page, rows: [reel] }, read).rows).toHaveLength(1);
  const cursor = facebookSearchCursor(read, row.source_object_id);
  expect(parseFacebookSearchCursor({ ...read, cursor })).toBe(row.source_object_id);
  expect(() => parseFacebookSearchCursor({ ...read, cursor, snapshot: { ...read.snapshot, discovery: { ...read.snapshot.discovery!, target: 'https://www.facebook.com/999/' } } })).toThrowError(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
});
it('classifies browser failures without retaining private error text', () => {
  expect(browserDiscoveryErrorCode(new AppError('ACCOUNT_MISMATCH', 'private'))).toBe('ACCOUNT_MISMATCH');
  const timeout = new Error('private page call log'); timeout.name = 'TimeoutError';
  expect(browserDiscoveryErrorCode(timeout)).toBe('BROWSER_STEP_TIMEOUT');
  expect(browserDiscoveryErrorCode(new Error('locator: strict mode violation: private element'))).toBe('BROWSER_LOCATOR_AMBIGUOUS');
  expect(browserDiscoveryErrorCode(new Error('page.evaluate: ReferenceError: private value'))).toBe('BROWSER_EVALUATION_FAILED');
  expect(browserDiscoveryErrorCode(new Error('Target page, context or browser has been closed'))).toBe('BROWSER_CONTEXT_CLOSED');
  const parsed = z.string().safeParse(3);
  expect(browserDiscoveryErrorCode(parsed.error)).toBe('COLLECTION_INVALID_PAGE');
  expect(browserDiscoveryErrorCode(new Error('unknown private error'))).toBe('EXECUTOR_ERROR');
});
it('keeps explicitly unordered visible comment windows to one page with no cursor continuation',()=>{
  const read=request(),target='https://www.facebook.com/reel/2163157911082094/';
  const discovery=discoveryConfig.parse({...read.snapshot.discovery,strategy:'COMMENTS',target,browser:{...read.snapshot.discovery!.browser,template:'facebook-comments-dom-v1',comment_order:'VISIBLE_WINDOW'}});
  const snapshot={...read.snapshot,discovery,max_pages:1};read.snapshot=collectionSnapshotSchema.parse(snapshot);
  expect(collectionSnapshotSchema.safeParse({...snapshot,max_pages:2}).success).toBe(false);
  const monitor={request_id:randomUUID(),title:'Visible only',account_id:read.snapshot.account_id,discovery,interval_minutes:60,max_records:10,max_pages:1,page_size:2,retention_days:1};
  expect(monitorInput.safeParse(monitor).success).toBe(true);expect(monitorInput.safeParse({...monitor,max_pages:2}).success).toBe(false);
  expect(discoveryConfig.safeParse({...discovery,strategy:'KEYWORD',target:'',browser:{...discovery.browser,template:'facebook-search-dom-v1'}}).success).toBe(false);
  const page={schema_version:'kff.collection-page.v1',source_key:'social.discovery',source_version:'social-discovery-v1',query_id:read.query_id,account_external_id:read.snapshot.external_account_id,cursor:null,next_cursor:null,observed_at:new Date().toISOString(),reported_total:null,coverage:'BROWSER_VISIBLE_ONLY',rows:[]};
  expect(normalizeCollectionPage(page,read).next_cursor).toBeNull();
  expect(()=>normalizeCollectionPage({...page,next_cursor:'forged'},read)).toThrowError(expect.objectContaining({code:'COLLECTION_SOURCE_MISMATCH'}));
  expect(()=>normalizeCollectionPage({...page,cursor:'forged'},{...read,cursor:'forged'})).toThrowError(expect.objectContaining({code:'COLLECTION_SOURCE_MISMATCH'}));
});
it('limits the observed template to one explicit Facebook search term without API credentials', () => {
  const config = request().snapshot.discovery!;
  expect(discoveryIsSynthetic(config)).toBe(false);
  for (const change of [{ platform: 'instagram' }, { strategy: 'COMMENTS' }, { keywords: ['one','two'] }, { target: 'other' }, { credential_ref: 'FACEBOOK_TOKEN' }, { graph_version: 'v25.0' }]) expect(discoveryConfig.safeParse({ ...config, ...change }).success).toBe(false);
  const manifest = fixedPageManifest('facebook.discovery.read.browser');
  expect(manifest.adapter_version).toBe('facebook-search-browser-v1');
  expect(templateManifestSchema.safeParse({ ...manifest, steps: ['validate_input','verify_identity','submit_once'] }).success).toBe(false);
});
it('binds replay checkpoints to the query and full source snapshot', () => {
  const read = request(); read.cursor = facebookSearchCursor(read, 'facebook:reel:123');
  expect(parseFacebookSearchCursor(read)).toBe('facebook:reel:123');
  expect(parseFacebookSearchCursor({ ...read, cursor: facebookSearchCursor(read, 'facebook:post:pfbid0123456789abcdef') })).toBe('facebook:post:pfbid0123456789abcdef');
  expect(() => parseFacebookSearchCursor({ ...read, query_id: randomUUID() })).toThrowError(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
  expect(() => parseFacebookSearchCursor({ ...read, snapshot: { ...read.snapshot, title: 'changed' } })).toThrowError(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
  expect(() => parseFacebookSearchCursor({ ...read, cursor: 'not-json' })).toThrowError(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
});
it('checks browser coverage even for an empty page and rejects tracked or mismatched source URLs', () => {
  const read = request(), page = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: read.query_id, account_external_id: '1234', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY', rows: [] as unknown[] };
  expect(normalizeCollectionPage(page, read).coverage).toBe('BROWSER_VISIBLE_ONLY');
  expect(() => normalizeCollectionPage({ ...page, coverage: 'PROVIDER_RESULTS_ONLY' }, read)).toThrowError(expect.objectContaining({ code: 'COLLECTION_SOURCE_MISMATCH' }));
  const row = { source_object_id: 'facebook:reel:123', source_url: 'https://www.facebook.com/reel/123/', fields: Object.fromEntries(read.snapshot.fields.map(field => [field, { kind: 'NOT_RETURNED' }])) };
  expect(normalizeCollectionPage({ ...page, rows: [row] }, read).rows).toHaveLength(1);
  const timed = { ...row, fields: { ...row.fields, created_time: { kind: 'DISPLAYED_TIME', value: '2026年9月13日周日10:01' } } };
  expect(normalizeCollectionPage({ ...page, rows: [timed] }, read).rows[0].fields.created_time).toEqual(timed.fields.created_time);
  expect(normalizeCollectionPage({ ...page, rows: [{ ...row, source_object_id: 'facebook:post:pfbid0123456789abcdef', source_url: 'https://www.facebook.com/local.author/posts/pfbid0123456789abcdef/' }] }, read).rows).toHaveLength(1);
  for (const url of ['https://www.facebook.com/reel/123/?tracking=1','https://www.facebook.com/reel/456/','https://example.com/reel/123/']) expect(() => normalizeCollectionPage({ ...page, rows: [{ ...row, source_url: url }] }, read)).toThrowError(expect.objectContaining({ code: 'COLLECTION_SOURCE_MISMATCH' }));
});
it('keeps the browser discovery switch separate from publishing and messaging', () => {
  const original = { discovery: process.env.KFF_ENABLE_DISCOVERY, live: process.env.KFF_ENABLE_LIVE };
  try {
    process.env.KFF_ENABLE_DISCOVERY = 'true'; process.env.KFF_ENABLE_LIVE = 'false';
    expect(executionEnabled('facebook.discovery.read.browser')).toBe(true);
    expect(executionEnabled('facebook.messenger.reply.api')).toBe(false);
    expect(executionEnabled('facebook.page.publish.api')).toBe(false);
    process.env.KFF_ENABLE_DISCOVERY = 'false'; process.env.KFF_ENABLE_LIVE = 'true';
    expect(executionEnabled('facebook.discovery.read.browser')).toBe(false);
  } finally {
    if (original.discovery === undefined) delete process.env.KFF_ENABLE_DISCOVERY; else process.env.KFF_ENABLE_DISCOVERY = original.discovery;
    if (original.live === undefined) delete process.env.KFF_ENABLE_LIVE; else process.env.KFF_ENABLE_LIVE = original.live;
  }
});

it('pins real comments to one canonical post and keeps comment IDs distinct from post IDs', () => {
  const read = request();
  const target = 'https://www.facebook.com/local.author/posts/pfbid0123456789abcdef/';
  read.snapshot.discovery = discoveryConfig.parse({ ...read.snapshot.discovery, strategy: 'COMMENTS', browser: { ...read.snapshot.discovery!.browser, template: 'facebook-comments-dom-v1' }, target, keywords: ['测算','预约'] });
  expect(discoveryIsSynthetic(read.snapshot.discovery)).toBe(false);
  for (const url of [target + '?tracking=1', target.replace('www.facebook.com','example.com'), target.replace('/posts/','/groups/'), target.slice(0,-1)]) expect(discoveryConfig.safeParse({ ...read.snapshot.discovery, target: url }).success).toBe(false);
  for (const change of [{ strategy: 'KEYWORD' }, { credential_ref: 'FACEBOOK_TOKEN' }, { platform: 'instagram' }]) expect(discoveryConfig.safeParse({ ...read.snapshot.discovery, ...change }).success).toBe(false);
  const row = { source_object_id: 'facebook:comment:000123', source_url: target + '?comment_id=000123', fields: Object.fromEntries(read.snapshot.fields.map(field => [field, { kind: 'NOT_RETURNED' }])) };
  const page = { schema_version: 'kff.collection-page.v1', source_key: 'social.discovery', source_version: 'social-discovery-v1', query_id: read.query_id, account_external_id: '1234', cursor: null, next_cursor: null, observed_at: new Date().toISOString(), reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY', rows: [row] };
  expect(normalizeCollectionPage(page, read).rows).toHaveLength(1);
  const displayed={...row,fields:{...row.fields,created_time:{kind:'DISPLAYED_TIME',value:'2026年7月30日周四15:19'}}};
  expect(normalizeCollectionPage({...page,rows:[displayed]},read).rows[0].fields.created_time).toEqual(displayed.fields.created_time);
  const providerRead={...read,snapshot:{...read.snapshot,discovery:{...read.snapshot.discovery!,provider:'DATA_PROVIDER' as const,browser:undefined,target:'apify-run:rrrrrrrrrrrrrrrrr'},browser_environment:undefined}};
  expect(()=>normalizeCollectionPage({...page,coverage:'PROVIDER_RESULTS_ONLY',rows:[displayed]},providerRead)).toThrowError(expect.objectContaining({code:'COLLECTION_FIELDS_MISMATCH'}));
  for (const change of [{ source_url: row.source_url + '&tracking=1' },{ source_url: row.source_url.replace('local.author','other.author') },{ source_object_id: 'facebook:post:000123' }]) expect(() => normalizeCollectionPage({ ...page, rows: [{ ...row, ...change }] }, read)).toThrowError(expect.objectContaining({ code: 'COLLECTION_SOURCE_MISMATCH' }));
  read.cursor = facebookSearchCursor(read, row.source_object_id);
  expect(parseFacebookSearchCursor(read)).toBe(row.source_object_id);
  expect(() => parseFacebookSearchCursor({ ...read, snapshot: { ...read.snapshot, discovery: { ...read.snapshot.discovery!, target: target.replace('local.author','other.author') } } })).toThrowError(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
});
