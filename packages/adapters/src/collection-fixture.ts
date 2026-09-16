import { z } from 'zod';
import { discoveryIsSynthetic } from '../../contracts/src/acquisition';
import { collectionPageSchema, collectionRecordSchema, type CollectionPage, type CollectionRecord, type CollectionSnapshot } from '@kff/contracts';
import { AppError, requireCondition, validateTargetUrl } from '@kff/core';

export interface CollectionRead { query_id: string; snapshot: CollectionSnapshot; cursor: string | null; limit: number }
export interface CollectionAdapter { readPage(request: CollectionRead): Promise<unknown> }

// This source is authored in this repository; it is not captured platform data.
export function syntheticCollectionPage(request: CollectionRead): CollectionPage {
  const { snapshot, cursor, query_id, limit } = request;
  requireCondition(cursor === null || /^offset:(0|[1-9][0-9]{0,3})$/.test(cursor), 'CURSOR_EXPIRED', '合成游标已失效', 409);
  const offset = cursor === null ? 0 : Number(cursor.slice(7));
  if (cursor && snapshot.scenario === 'cursor_expired') throw new AppError('CURSOR_EXPIRED', '合成来源模拟游标失效', 409);
  if (cursor && snapshot.scenario === 'fail_second_page') throw new AppError('REMOTE_ERROR', '合成来源模拟后续页读取失败', 502);
  const values: CollectionRecord['fields'][] = [
    { message: { kind: 'VALUE', value: '同名合成记录' }, author_id: { kind: 'VALUE', value: snapshot.external_account_id }, reaction_count: { kind: 'VALUE', value: 0 }, comment_count: { kind: 'NOT_RETURNED' }, created_time: { kind: 'VALUE', value: '2026-09-01T00:00:00Z' } },
    { message: { kind: 'NULL' }, author_id: { kind: 'HIDDEN' }, reaction_count: { kind: 'NOT_RETURNED' }, comment_count: { kind: 'VALUE', value: 0 }, created_time: { kind: 'VALUE', value: '2026-09-01T00:01:00Z' } },
    { message: { kind: 'VALUE', value: '同名合成记录' }, author_id: { kind: 'VALUE', value: '000123456789012345678901234567890' }, reaction_count: { kind: 'VALUE', value: 2 }, comment_count: { kind: 'VALUE', value: 1 }, created_time: { kind: 'NOT_RETURNED' } },
    { message: { kind: 'VALUE', value: '第一条记录的新观察' }, author_id: { kind: 'VALUE', value: snapshot.external_account_id }, reaction_count: { kind: 'VALUE', value: 3 }, comment_count: { kind: 'VALUE', value: 1 }, created_time: { kind: 'VALUE', value: '2026-09-01T00:00:00Z' } },
    { message: { kind: 'VALUE', value: '' }, author_id: { kind: 'NULL' }, reaction_count: { kind: 'NULL' }, comment_count: { kind: 'HIDDEN' }, created_time: { kind: 'NOT_RETURNED' } },
  ];
  const ids = ['000123456789012345678901234567890', '9007199254740993123456789', '9007199254740993123456790', '000123456789012345678901234567890', '00000'];
  const source = snapshot.scenario === 'empty' ? [] : values.map((fields, index) => collectionRecordSchema.parse({ source_object_id: ids[index], source_url: 'http://127.0.0.1:4311/collection-object/' + ids[index], fields: Object.fromEntries(snapshot.fields.map(field => [field, fields[field]])) }));
  const rows = snapshot.scenario === 'empty_first_page' && cursor === null ? [] : source.slice(offset, offset + limit);
  const next = snapshot.scenario === 'empty_first_page' && cursor === null ? 'offset:0' : offset + rows.length < source.length ? 'offset:' + (offset + rows.length) : null;
  return { schema_version: 'kff.collection-page.v1', source_key: snapshot.source_key, source_version: snapshot.source_version, query_id, account_external_id: snapshot.external_account_id, cursor, next_cursor: snapshot.scenario === 'cursor_loop' && cursor ? cursor : next, observed_at: new Date().toISOString(), reported_total: null, coverage: 'SYNTHETIC_SAMPLE', rows };
}

export function normalizeCollectionPage(value: unknown, request: CollectionRead) {
  const page = collectionPageSchema.parse(value); const snapshot = request.snapshot;
  requireCondition(page.query_id === request.query_id && page.account_external_id === snapshot.external_account_id && page.source_key === snapshot.source_key && page.source_version === snapshot.source_version && page.cursor === request.cursor, 'COLLECTION_SOURCE_MISMATCH', '分页来源、账号或游标与查询不一致', 409);
  requireCondition(page.rows.length <= request.limit, 'COLLECTION_LIMIT_EXCEEDED', '来源返回量超过当前允许上限', 409);
  requireCondition(Date.parse(page.observed_at) <= Date.now() + 60000, 'COLLECTION_SOURCE_MISMATCH', '观察时间超出允许范围', 409);
  const expectedCoverage = !snapshot.discovery || discoveryIsSynthetic(snapshot.discovery) ? 'SYNTHETIC_SAMPLE' : snapshot.discovery.provider === 'LOCAL_BROWSER' ? 'BROWSER_VISIBLE_ONLY' : snapshot.discovery.provider === 'META_API' ? 'API_VISIBLE_ONLY' : 'PROVIDER_RESULTS_ONLY';
  requireCondition(page.coverage === expectedCoverage, 'COLLECTION_SOURCE_MISMATCH', '分页覆盖范围与来源不符', 409);
  if(snapshot.discovery?.browser?.comment_order==='VISIBLE_WINDOW')requireCondition(snapshot.max_pages===1&&request.cursor===null&&page.next_cursor===null,'COLLECTION_SOURCE_MISMATCH','当前可见评论窗口不能使用排序游标或继续分页',409);
  for (const row of page.rows) {
    if (!snapshot.discovery || discoveryIsSynthetic(snapshot.discovery)) {
      const url = validateTargetUrl(row.source_url, [], 'http://127.0.0.1:4311');
      requireCondition(url.origin === 'http://127.0.0.1:4311' && url.pathname === '/collection-object/' + row.source_object_id && !url.search && !url.hash && page.coverage==='SYNTHETIC_SAMPLE', 'COLLECTION_SOURCE_MISMATCH', '合成来源链接不匹配', 409);
    } else {
      const url=new URL(row.source_url),hosts=snapshot.discovery.platform==='facebook'?['www.facebook.com','facebook.com']:['www.instagram.com','instagram.com'];
      requireCondition(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&hosts.includes(url.hostname),'COLLECTION_SOURCE_MISMATCH','来源链接或覆盖范围与平台不符',409);
      if (snapshot.discovery.browser?.template === 'facebook-comments-dom-v1') {
        requireCondition(/^facebook:comment:[0-9]{1,80}$/.test(row.source_object_id) && row.source_url === snapshot.discovery.target + '?comment_id=' + row.source_object_id.slice('facebook:comment:'.length), 'COLLECTION_SOURCE_MISMATCH', '评论链接、标识或所属帖子不匹配');
      }
      if (snapshot.discovery.browser?.template === 'facebook-search-dom-v1') {
        const post = /^\/([A-Za-z0-9.]+)\/posts\/(pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})\/$/.exec(url.pathname);
        const reel = /^facebook:reel:[0-9]{1,80}$/.test(row.source_object_id) && row.source_url === 'https://www.facebook.com/reel/' + row.source_object_id.slice('facebook:reel:'.length) + '/';
        requireCondition(reel || post && row.source_object_id === 'facebook:post:' + post[2] && url.origin === 'https://www.facebook.com' && !url.search && !url.hash, 'COLLECTION_SOURCE_MISMATCH', '浏览器来源必须是去除跟踪参数的原帖子链接', 409);
      }
      if (snapshot.discovery.browser?.template === 'facebook-page-dom-v1') {
        const publisher = new URL(snapshot.discovery.target).pathname.replaceAll('/', '');
        const post = /^facebook:post:(pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})$/.exec(row.source_object_id);
        const reel = /^facebook:reel:([0-9]{1,80})$/.exec(row.source_object_id);
        const expectedPost = post && (row.source_url === 'https://www.facebook.com/' + publisher + '/posts/' + post[1] + '/' || row.source_url === 'https://www.facebook.com/permalink.php?story_fbid=' + post[1] + '&id=' + publisher);
        requireCondition(Boolean(expectedPost || reel && row.source_url === 'https://www.facebook.com/reel/' + reel[1] + '/') && row.fields.author_id?.kind === 'VALUE' && row.fields.author_id.value === publisher, 'COLLECTION_SOURCE_MISMATCH', '主页帖子必须来自固定发布者，链接与原帖子标识必须一致', 409);
      }
    }
    requireCondition(JSON.stringify(Object.keys(row.fields).sort()) === JSON.stringify(snapshot.fields), 'COLLECTION_FIELDS_MISMATCH', '返回字段必须与已固定的允许字段一致', 409);
    for(const [field,datum] of Object.entries(row.fields))if(datum?.kind==='DISPLAYED_TIME')requireCondition(field==='created_time'&&snapshot.discovery?.provider==='LOCAL_BROWSER','COLLECTION_FIELDS_MISMATCH','页面时间标签仅用于本地浏览器来源，不能冒充精确发布时间',409);
    for (const [field, datum] of Object.entries(row.fields)) if (datum?.kind === 'VALUE') {
      if (field === 'reaction_count' || field === 'comment_count') requireCondition(typeof datum.value === 'number' && Number.isSafeInteger(datum.value) && datum.value >= 0, 'COLLECTION_FIELDS_MISMATCH', '计数必须为明确的非负安全整数', 409);
      else requireCondition(typeof datum.value === 'string', 'COLLECTION_FIELDS_MISMATCH', '文本与平台标识必须保留为字符串', 409);
      if (field === 'author_id') requireCondition(typeof datum.value === 'string' && /^[0-9]{1,128}$/.test(datum.value), 'COLLECTION_FIELDS_MISMATCH', '作者标识无效', 409);
      if (field === 'created_time') requireCondition(z.string().datetime().safeParse(datum.value).success, 'COLLECTION_FIELDS_MISMATCH', '来源时间格式无效', 409);
    }
  }
  return page;
}
export const fixtureCollectionAdapter: CollectionAdapter = {
  async readPage(request) {
    const url = new URL('http://127.0.0.1:4311/collection-pages');
    url.searchParams.set('request', JSON.stringify({ query_id: request.query_id, snapshot: request.snapshot, cursor: request.cursor, limit: request.limit }));
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const reader = response.body?.getReader(); requireCondition(reader, 'REMOTE_ERROR', '合成来源没有响应内容', 502);
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024 * 1024) { await reader.cancel(); throw new AppError('REMOTE_ERROR', '分页响应超出读取上限', 502); } chunks.push(value); }
    let data: unknown; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('REMOTE_ERROR', '合成来源响应无法读取', 502); }
    if (!response.ok) { const error = z.object({ code: z.enum(['CURSOR_EXPIRED', 'REMOTE_ERROR']) }).safeParse(data); throw new AppError(error.success ? error.data.code : 'REMOTE_ERROR', '合成来源当前无法继续读取', 502); }
    return data;
  },
};
