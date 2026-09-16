import { z } from 'zod';
import { collectionSnapshotSchema, collectionRecordSchema, type CollectionRecord } from '@kff/contracts';
import { requireCondition } from '@kff/core';
import { localDiscoveryPage } from './discovery';

export const browserDiscoveryReadSchema = z.object({
  query_id: z.string().uuid(), snapshot: collectionSnapshotSchema,
  cursor: z.string().min(1).max(2048).nullable(), limit: z.number().int().min(1).max(100),
}).strict();
export type BrowserDiscoveryRead = z.infer<typeof browserDiscoveryReadSchema>;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Repository-authored HTML, with visible fields; never captured or represented as platform data. */
export function renderBrowserDiscoveryFixture(raw: BrowserDiscoveryRead, records?: CollectionRecord[]) {
  const request = browserDiscoveryReadSchema.parse(raw), snapshot = request.snapshot;
  requireCondition(snapshot.discovery?.browser?.template === 'fixture-discovery-dom-v1' && snapshot.browser_environment?.is_synthetic, 'FORBIDDEN_SCOPE', '此页面仅用于本地合成采集');
  const source = localDiscoveryPage({ ...request, cursor: null, limit: 100, snapshot: { ...snapshot, discovery: { ...snapshot.discovery, provider: 'LOCAL_FIXTURE', browser: undefined } } });
  // The synthesised publication time is relative to the observation, exactly as the non-browser
  // synthetic page reports it. A fixed date made this fixture decay: once it fell outside the
  // monitor's `max_age_days` window every record was scored 0 and the collector correctly produced no
  // leads, so a passing suite turned into a failing one with no code change at all.
  const rows = records?.map(row => collectionRecordSchema.parse(row)) ?? source.rows.map(row => ({ ...row, fields: { ...row.fields, ...(snapshot.fields.includes('created_time') ? { created_time: { kind: 'VALUE' as const, value: new Date().toISOString() } } : {}) } }));
  requireCondition(request.cursor === null || /^offset:(0|[1-9][0-9]{0,3})$/.test(request.cursor), 'CURSOR_EXPIRED', '合成页面游标失效');
  const offset = request.cursor ? Number(request.cursor.slice(7)) : 0;
  requireCondition(offset <= rows.length, 'CURSOR_EXPIRED', '合成页面游标超过来源范围');
  const page = rows.slice(offset, offset + request.limit), next = offset + page.length < rows.length ? 'offset:' + (offset + page.length) : '';
  const items = page.map(row => '<article data-testid="discovery-row" data-object-id="' + escape(row.source_object_id) + '"><a data-source-url href="' + escape(row.source_url) + '">来源</a>' + Object.entries(row.fields).map(([field, datum]) => '<p><b>' + escape(field) + '</b> <span data-field="' + escape(field) + '" data-kind="' + datum!.kind + '" data-value-type="' + (datum!.kind === 'VALUE' ? typeof datum!.value : '') + '">' + escape(datum!.kind === 'VALUE' ? datum!.value : datum!.kind) + '</span></p>').join('') + '</article>').join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>KFF 浏览器采集合成页</title><body><h1>KFF 浏览器采集合成页</h1><p>本项目编写的测试评论，不是 Facebook 数据。</p><p data-testid="login-identity">' + escape(snapshot.browser_environment.configuration.login_account_id) + '</p><p data-testid="account-identity">' + escape(snapshot.external_account_id) + '</p><main data-testid="discovery-page" data-query-id="' + escape(request.query_id) + '" data-target="' + escape(snapshot.discovery.target) + '" data-cursor="' + escape(request.cursor ?? '') + '" data-next-cursor="' + escape(next) + '">' + items + '</main></body></html>';
}
