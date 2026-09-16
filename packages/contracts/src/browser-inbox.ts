import { z } from 'zod';
import { browserEnvironmentSnapshot } from './environment';

const remote = z.string().regex(/^[0-9]{1,128}$/);
const stable = z.string().regex(/^[A-Za-z0-9_:+.@-]{1,160}$/);
export const browserInboxMessage = z.object({
  message_id: stable, thread_id: stable, peer_id: remote, thread_kind: z.enum(['DIRECT', 'UNVERIFIED']),
  direction: z.enum(['INBOUND', 'OUTBOUND']), body: z.string().min(1).max(5000).refine(value => value.trim().length > 0),
  display_name: z.string().max(80).nullable(), occurred_at: z.string().datetime().nullable(), has_attachment: z.boolean(),
  displayed_time: z.string().min(1).max(160).optional(),
  source_url: z.string().url().max(1000).refine(value => {
    try { const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'www.facebook.com' && !url.port && !url.username && !url.password && /^\/messages\/(?:e2ee\/)?(?:requests\/)?t\/[A-Za-z0-9_:+.@-]+\/?$/.test(url.pathname) && !url.search && !url.hash;
    } catch { return false; }
  }, '仅接受明确的 Facebook 一对一会话链接'),
}).strict().refine(value => { try { return new URL(value.source_url).pathname.replace(/\/$/, '').split('/').at(-1) === value.thread_id; } catch { return false; } }, '来源链接必须对应观察到的会话标识')
  .refine(value => value.occurred_at !== null || Boolean(value.displayed_time), '无法确认完整发送时间时必须保留页面原始时间');
export const browserInboxBatch = z.object({
  schema_version: z.literal('kff.browser-inbox-batch.v1'), login_account_id: remote, operating_identity_id: remote,
  observed_at: z.string().datetime(), coverage: z.literal('VISIBLE_MESSAGES_ONLY'),
  messages: z.array(browserInboxMessage).max(50),
}).strict().refine(value => value.messages.every(message => message.peer_id !== value.operating_identity_id && (message.occurred_at === null || Date.parse(message.occurred_at) <= Date.parse(value.observed_at))), '消息时间或对方身份与当前观察不符');
// Composer observations stay fact-only: no peer name, message text or free-form page content.
// `placeholder` records that the observed label only repeats the directory placeholder, which
// names nobody and therefore never counts as a foreign chat target.
export const browserInboxComposerSurface = z.object({
  stage:z.enum(['facebook-inbox-directory-composer','facebook-inbox-composer-surface']),
  candidate_count:z.number().int().min(0).max(100),
  label_kind:z.enum(['ABSENT','EXACT_NAME','NAMED_PREFIX','BARE_PREFIX','OTHER']),
  label_length:z.number().int().min(0).max(120),
  placeholder:z.boolean().optional(),
  reachable:z.boolean(), hit_target:z.boolean(), role:z.enum(['textbox','combobox','none']), contenteditable:z.boolean(),
}).strict();
/**
 * A read conversation keeps the source of its evidence: an accepted-chat composer or a read-only
 * thread. `read`/`message_count` stay optional on input, because the window summary and the message
 * batch arrive as one payload; `requireDiscoveryMessageCount` checks them against the batch that is
 * actually stored and fills the defaults in, so a skipped conversation can never claim a read.
 */
export const browserInboxThreadTarget = z.object({
  thread_id: remote, peer_id: remote, display_name: z.string().trim().min(1).max(80),
  read: z.boolean().optional(), message_count: z.number().int().min(0).max(50).optional(),
  // Reading without an input box is allowed only for the exact reason recorded here.
  read_only_reason: z.enum(['THREAD_COMPOSER_ABSENT','THREAD_COMPOSER_UNVERIFIED','THREAD_INPUT_UNUSABLE','THREAD_INPUT_FOREIGN']).optional(),
  composer_surface: browserInboxComposerSurface.optional(),
}).strict().refine(v=>v.read!==true||Boolean(v.read_only_reason||v.composer_surface),'读到的会话必须保留输入框或只读原因证据')
  .refine(v=>!v.read_only_reason||v.read!==false,'只有已读取的会话可以标记只读路径');
export const browserInboxTarget = browserInboxThreadTarget;
export const browserInboxDiscovery = z.object({ strategy: z.literal('RECENT_ACCEPTED'), max_threads: z.number().int().min(1).max(3) }).strict();
export const browserInboxThreadFailure = z.object({
  stage:z.enum(['facebook-inbox-directory-thread','facebook-inbox-directory-identity','facebook-inbox-directory-composer','facebook-inbox-composer-surface','facebook-inbox-read-only','facebook-inbox-load','facebook-inbox-wait-content','facebook-inbox-parse','facebook-inbox-peer','facebook-inbox-peer-hit-target','facebook-inbox-peer-menu','facebook-inbox-recheck']),
  // THREAD_NOT_ACCEPTED stays for historical records only. A missing, unusable or foreign
  // input box is reported as its own observation and never as a Facebook business reason.
  code:z.enum(['TIMEOUT','THREAD_NOT_ACCEPTED','THREAD_COMPOSER_ABSENT','THREAD_COMPOSER_UNVERIFIED','THREAD_INPUT_UNUSABLE','THREAD_INPUT_FOREIGN','THREAD_IDENTITY_UNVERIFIED','INBOX_SOURCE_MISMATCH','ACCOUNT_MISMATCH']),
}).strict();
// A conversation the window did not read. A missing composer is its own reason: it is not
// by itself proof that the chat was never accepted, and it must not be reported as a timeout.
export const browserInboxSkippedThread = z.object({
  thread_id: remote,
  reason: z.enum(['THREAD_NOT_ACCEPTED','THREAD_COMPOSER_ABSENT','THREAD_COMPOSER_UNVERIFIED','THREAD_INPUT_UNUSABLE','THREAD_INPUT_FOREIGN','THREAD_IDENTITY_UNVERIFIED','THREAD_WINDOW_UNAVAILABLE','MESSAGE_LIMIT']),
  failure:browserInboxThreadFailure.optional(), composer_surface:browserInboxComposerSurface.optional(),
}).strict().refine(v=>!v.failure||v.reason!=='MESSAGE_LIMIT','达到消息上限不是会话读取失败')
  .refine(v=>!v.composer_surface||Boolean(v.failure),'输入框观测必须属于一次会话读取失败');
/**
 * The window must report readable, skipped and failed conversations separately. A skipped
 * conversation is never counted as a successful read, so it can be retried by a later cycle.
 */
export const browserInboxDiscoveryCoverage = z.object({
  threads_attempted: z.number().int().min(0).max(3),
  threads_read: z.number().int().min(0).max(3),
  threads_skipped: z.number().int().min(0).max(3),
  threads_failed: z.number().int().min(0).max(3),
}).strict().refine(v=>v.threads_attempted===v.threads_read+v.threads_skipped+v.threads_failed,'会话覆盖计数必须与已处理会话一致');
export const browserInboxDiscoverySummary = z.object({
  strategy: z.literal('RECENT_ACCEPTED'), visible_threads: z.number().int().min(0).max(1000), unparsed_rows: z.number().int().min(0).max(1000),
  threads: z.array(browserInboxThreadTarget).max(3),
  skipped: z.array(browserInboxSkippedThread).max(3),
  // A conversation that was read without a verified input box keeps its observation here.
  observed: z.array(browserInboxSkippedThread).max(3).optional(),
  coverage: browserInboxDiscoveryCoverage.optional(),
  window_limited: z.boolean(), empty_list: z.boolean(),
}).strict().refine(v => !v.coverage||v.coverage.threads_read===v.threads.filter(t=>t.read!==false).length,'覆盖计数必须与实际读取数量一致')
  .refine(v => !v.coverage||v.coverage.threads_skipped===v.skipped.length&&v.coverage.threads_failed<=v.skipped.length,'覆盖计数必须与实际跳过数量一致')
  .refine(v => (v.observed??[]).every(o=>v.threads.some(t=>t.thread_id===o.thread_id&&t.read!==false)),'只读观测只能属于一次已读取的会话')
  .refine(v => { const ids=[...v.threads,...v.skipped].map(t=>t.thread_id);return new Set(ids).size===ids.length&&ids.length<=v.visible_threads&&(!v.empty_list||v.visible_threads===0&&v.unparsed_rows===0&&!v.window_limited); }, '会话窗口摘要必须保持唯一身份及真实空列表边界');
export const browserInboxBinding = z.object({ environment: browserEnvironmentSnapshot, account_version: z.number().int().positive(), target: browserInboxTarget.optional(), discovery: browserInboxDiscovery.optional() }).strict().refine(v=>!(v.target&&v.discovery),'指定会话和发现会话不可同时启用');
export type BrowserInboxDiscoverySummary = z.infer<typeof browserInboxDiscoverySummary>;
export type BrowserInboxBatch = z.infer<typeof browserInboxBatch>;
export type BrowserInboxBinding = z.infer<typeof browserInboxBinding>;

const cursor = z.string().min(1).max(2048).nullable();
// Only the monitor scheduler may assemble this extension; generic task input has no inbox field.
export const browserInboxTask = z.object({
  monitor_id: z.string().uuid(), monitor_version: z.number().int().positive(),
  token: z.string().regex(/^[1-9][0-9]*$/), cycle_id: z.string().uuid(),
  cursor, limit: z.number().int().min(1).max(50), expires_at: z.string().datetime(),
  binding: browserInboxBinding, template: z.enum(['fixture-inbox-dom-v1', 'facebook-inbox-dom-v1']),
}).strict();
export const browserInboxPage = z.object({
  monitor_id: z.string().uuid(), cursor, next_cursor: cursor, has_more: z.boolean(), batch: browserInboxBatch,
  discovery: browserInboxDiscoverySummary.optional(),
}).strict().refine(value => value.has_more === (value.next_cursor !== null), '下一页状态必须明确')
  // The per-thread counts are checked against the batch itself, so a skipped conversation can
  // never be reported as read and a read conversation never hides its messages. The batch-level
  // check lives in the controller, which owns both sides of the observation.
  .refine(v=>!v.discovery||v.cursor===null&&v.next_cursor===null&&!v.has_more,'发现会话只读取本次可见窗口')
  .refine(v=>!v.discovery||v.batch.messages.every(m=>v.discovery!.threads.some(t=>t.thread_id===m.thread_id&&t.peer_id===m.peer_id&&(m.direction==='OUTBOUND'||m.display_name===t.display_name))&&m.thread_kind==='UNVERIFIED'&&m.occurred_at===null)&&v.discovery.threads.every(t=>v.batch.messages.some(m=>m.thread_id===t.thread_id&&m.direction==='INBOUND')),'发现会话的消息必须逐条属于已核实发送者');
export const browserInboxMonitorInput = z.object({
  request_id: z.string().uuid(), environment_id: z.string().uuid(), expected_version: z.number().int().nonnegative(),
  interval_seconds: z.number().int().min(10).max(3600).default(60), page_size: z.number().int().min(1).max(50).default(25),
  raw_retention_hours: z.number().int().min(1).max(24).default(1),
  target: browserInboxTarget.optional(),
  discovery: browserInboxDiscovery.optional(),
}).strict().refine(v=>!(v.target&&v.discovery),'指定会话和发现会话不可同时启用');
export const browserInboxControl = z.object({
  request_id: z.string().uuid(), expected_version: z.number().int().positive(), action: z.enum(['SCAN', 'START', 'PAUSE']),
}).strict();
export type BrowserInboxTask = z.infer<typeof browserInboxTask>;

export const browserMessageContext = z.object({
  thread_id: stable, peer_id: remote, trigger_remote_message_id: stable, last_seen_message_id: stable,
  display_name: z.string().trim().min(1).max(80).optional(),
  trigger_content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  source_url: browserInboxMessage.shape.source_url,
}).strict().refine(value => { try { return new URL(value.source_url).pathname.replace(/\/$/, '').split('/').at(-1) === value.thread_id; } catch { return false; } }, '回复会话链接与会话标识不一致');
