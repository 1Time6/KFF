import { z } from 'zod';

export const discoveryPlatform = z.enum(['facebook', 'instagram']);
export const discoveryStrategy = z.enum(['KEYWORD', 'COMMENTS', 'PAGE', 'HASHTAG']);
export const browserCommentOrder = z.enum(['NEWEST', 'VISIBLE_WINDOW']);
export const facebookPublicPostUrl = z.string().regex(/^https:\/\/www\.facebook\.com\/(?:[A-Za-z0-9.]+\/posts\/(?:pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})|reel\/[0-9]{1,80})\/$/);
export const browserCommentContext = z.object({
  source_url: facebookPublicPostUrl, comment_id: z.string().regex(/^[0-9]{1,80}$/),
  comment_url: z.string().max(500), source_body: z.string().min(1).max(5000),
  source_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  displayed_time: z.string().min(1).max(160), observed_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  comment_order: browserCommentOrder.optional(),
}).strict().refine(v => v.comment_url === v.source_url + '?comment_id=' + v.comment_id, '评论链接必须与固定帖子和评论 ID 一致');
export const discoveryConfig = z.object({
  platform: discoveryPlatform, strategy: discoveryStrategy,
  provider: z.enum(['LOCAL_FIXTURE', 'LOCAL_BROWSER', 'META_API', 'DATA_PROVIDER']),
  browser: z.object({ environment_id: z.string().uuid(), template: z.enum(['fixture-discovery-dom-v1','facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1']), comment_order: browserCommentOrder.optional() }).strict().refine(v=>!v.comment_order||v.template==='facebook-comments-dom-v1','评论顺序仅适用于真实公开评论读取').optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  exclusions: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  max_age_days: z.number().int().min(1).max(365).optional(),
  target: z.string().trim().max(300),
  processing_basis: z.string().trim().min(10).max(500),
  credential_ref: z.string().regex(/^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]{1,80}$/).optional(),
  graph_version: z.string().regex(/^v[0-9]{1,3}\.[0-9]+$/).optional(),
}).strict().refine(value => (value.provider === 'LOCAL_BROWSER') === Boolean(value.browser), '本地浏览器来源必须指定环境和固定采集模板').refine(value => value.browser?.template !== 'facebook-search-dom-v1' || value.platform === 'facebook' && value.strategy === 'KEYWORD' && value.keywords.length === 1 && !value.target && !value.credential_ref && !value.graph_version, '真实浏览器搜索仅支持单关键词，不使用 Graph 凭据').refine(value => value.browser?.template !== 'facebook-comments-dom-v1' || value.platform === 'facebook' && value.strategy === 'COMMENTS' && /^https:\/\/www\.facebook\.com\/(?:[A-Za-z0-9.]+\/posts\/(?:pfbid[A-Za-z0-9]{10,135}|[0-9]{1,80})|reel\/[0-9]{1,80})\/$/.test(value.target) && !value.credential_ref && !value.graph_version, '真实评论读取需固定的公开帖子或 Reel 链接，去除跟踪参数并保留结尾斜线').refine(value => value.browser?.template !== 'facebook-page-dom-v1' || value.platform === 'facebook' && value.strategy === 'PAGE' && /^https:\/\/www\.facebook\.com\/[0-9]{1,80}\/$/.test(value.target) && !value.credential_ref && !value.graph_version, '主页读取需要固定数字 ID 的公开主页链接，不使用 Graph 凭据');
export function discoveryIsSynthetic(value: DiscoveryConfig) { return value.provider === 'LOCAL_FIXTURE' || value.provider === 'LOCAL_BROWSER' && value.browser?.template === 'fixture-discovery-dom-v1'; }
export const commentContinuation = z.object({
  allowed_source_types: z.array(z.enum(['POST','REEL'])).min(1).max(2),
  max_sources_per_scan: z.number().int().min(1).max(5),
  max_sources_total: z.number().int().min(1).max(50),
  source_lifetime_hours: z.number().int().min(1).max(168),
  comment_order: browserCommentOrder,
}).strict().refine(v=>v.max_sources_per_scan<=v.max_sources_total,'每轮上限不能大于总上限');
export const monitorInput = z.object({
  request_id: z.string().uuid(), title: z.string().trim().min(1).max(120), account_id: z.string().uuid(),
  discovery: discoveryConfig, interval_minutes: z.number().int().min(5).max(10080),
  max_records: z.number().int().min(1).max(1000), max_pages: z.number().int().min(1).max(100),
  page_size: z.number().int().min(1).max(100).default(50),
  retention_days: z.number().int().min(1).max(30),
  comment_continuation: commentContinuation.optional(),
}).strict().refine(v=>v.discovery.browser?.comment_order!=='VISIBLE_WINDOW'||v.max_pages===1,'当前可见窗口只读取一页，不使用排序游标分页').refine(v=>!v.comment_continuation||v.discovery.provider==='LOCAL_BROWSER'&&['facebook-search-dom-v1','facebook-page-dom-v1'].includes(v.discovery.browser?.template??'')&&Boolean(v.discovery.max_age_days),'自动接续仅适用于有发布时间范围的 Facebook 搜索或主页读取');
export const monitorControl = z.object({request_id:z.string().uuid(),expected_version:z.number().int().positive(),action:z.enum(['START','PAUSE','SCAN']),reason:z.string().trim().min(5).max(300)}).strict();
export const outreachSnapshot = z.object({
  lead_id:z.string().uuid(), observation_id:z.string().uuid(), monitor_id:z.string().uuid(), monitor_version:z.number().int().positive(),
  platform:discoveryPlatform, action:z.enum(['COMMENT_REPLY','PRIVATE_REPLY']),
  source_object_id:z.string().max(160), parent_id:z.string().max(300),
  author_id:z.string().regex(/^[0-9]{1,128}$/), occurred_at:z.string().datetime().optional(),
  browser: browserCommentContext.optional(),
  lead_version:z.number().int().positive(), authorization_basis:z.string().min(10).max(500),
  stop_epochs:z.object({organization:z.number(),brand:z.number(),account:z.number(),agent:z.number()}).strict(),
}).strict().refine(v => v.browser ? v.platform === 'facebook' && v.action === 'COMMENT_REPLY' && v.source_object_id === 'facebook:comment:' + v.browser.comment_id && v.parent_id === v.browser.source_url && !v.occurred_at : /^[0-9_]{1,160}$/.test(v.source_object_id) && /^[0-9_]{1,160}$/.test(v.parent_id) && Boolean(v.occurred_at), '浏览器只允许固定公开评论回复；API 评论必须有原始发布时间');
export const outreachInput = z.object({request_id:z.string().uuid(),lead_id:z.string().uuid(),expected_version:z.number().int().positive(),environment_id:z.string().uuid(),action:z.enum(['COMMENT_REPLY','PRIVATE_REPLY']),body:z.string().trim().min(1).max(1000),authorization_basis:z.string().trim().min(10).max(500),delay_minutes:z.number().int().min(0).max(1440).default(0),expires_at:z.string().datetime().optional(),replaces_task_id:z.string().uuid().optional()}).strict();
export const leadControl = z.object({request_id:z.string().uuid(),expected_version:z.number().int().positive(),state:z.enum(['NEW','QUALIFIED','DISMISSED','OPTED_OUT']),reason:z.string().trim().min(5).max(500)}).strict();
export const automationInput = z.object({request_id:z.string().uuid(),monitor_id:z.string().uuid(),expected_version:z.number().int().positive(),enabled:z.boolean(),environment_id:z.string().uuid(),action:z.enum(['COMMENT_REPLY','PRIVATE_REPLY']),body:z.string().trim().min(1).max(1000),authorization_basis:z.string().trim().min(10).max(500),min_score:z.number().int().min(1).max(100),daily_limit:z.number().int().min(1).max(100),delay_minutes:z.number().int().min(0).max(1440)}).strict();
export type DiscoveryConfig = z.infer<typeof discoveryConfig>;
export type MonitorInput = z.infer<typeof monitorInput>;
