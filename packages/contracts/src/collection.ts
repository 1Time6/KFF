import { z } from 'zod';
import type { ManualImportSnapshot } from './imports';
import { discoveryConfig } from './acquisition';
import { browserEnvironmentSnapshot } from './environment';

export const collectionField = z.enum(['message', 'author_id', 'reaction_count', 'comment_count', 'created_time']);
export const collectionFieldValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('VALUE'), value: z.union([z.string().max(5000), z.number().finite().safe(), z.boolean()]) }).strict(),
  z.object({ kind: z.literal('DISPLAYED_TIME'), value: z.string().trim().min(1).max(160) }).strict(),
  z.object({ kind: z.enum(['NULL', 'NOT_RETURNED', 'HIDDEN']) }).strict(),
]);
export const collectionScenario = z.enum(['normal', 'empty', 'empty_first_page', 'cursor_loop', 'cursor_expired', 'fail_second_page']);
export const collectionInput = z.object({
  request_id: z.string().uuid(), title: z.string().trim().min(1).max(120),
  source_key: z.enum(['kff.fixture.page.posts','social.discovery']), account_id: z.string().uuid(),
  discovery: discoveryConfig.optional(),
  targets: z.array(z.string().regex(/^[0-9]{1,128}$/)).length(1),
  fields: z.array(collectionField).min(1).max(5).refine(values => new Set(values).size === values.length, '字段不能重复').transform(values => [...values].sort()),
  purpose: z.enum(['software_verification','lead_discovery']), mode: z.enum(['TEST_ONLY','CONTROLLED_PILOT']), incremental_rule: z.literal('append_observations'),
  max_records: z.number().int().min(1).max(1000), max_pages: z.number().int().min(1).max(100), page_size: z.number().int().min(1).max(100),
  display_timezone: z.string().min(1).max(80).refine(value => { if (!/^(UTC|[A-Za-z_]+\/[A-Za-z0-9_+/-]+)$/.test(value)) return false; try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } }, '需使用有效 IANA 时区'),
  retention_days: z.number().int().min(1).max(30), scenario: collectionScenario,
}).strict();
export const collectionSnapshotSchema = collectionInput.omit({ request_id: true }).extend({
  schema_version: z.literal('kff.collection.v1'), source_version: z.enum(['fixture-page-posts-v1','social-discovery-v1']), source_type: z.enum(['OWNED_FIXTURE','SOCIAL_DISCOVERY']),
  account_version: z.number().int().positive(), external_account_id: z.string().regex(/^[0-9]{1,128}$/),
  browser_environment: browserEnvironmentSnapshot.optional(),
  allowed_purposes: z.array(z.enum(['software_verification','lead_discovery'])).min(1).max(2),
}).strict().refine(value => (value.discovery?.provider === 'LOCAL_BROWSER') === Boolean(value.browser_environment) && (!value.browser_environment || value.browser_environment.environment_id === value.discovery?.browser?.environment_id && value.browser_environment.account_id === value.account_id && value.browser_environment.configuration.operating_identity_id === value.external_account_id), '浏览器采集快照必须与查询账号和环境一致').refine(v=>v.discovery?.browser?.comment_order!=='VISIBLE_WINDOW'||v.max_pages===1,'可见窗口读取不支持多页');
export const collectionRecordSchema = z.object({
  source_object_id: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
  source_url: z.string().url().max(1000),
  fields: z.partialRecord(collectionField, collectionFieldValue),
}).strict().refine(row=>Object.entries(row.fields).every(([field,value])=>value?.kind!=='DISPLAYED_TIME'||field==='created_time'),'页面时间标签只能用于来源时间');
export const collectionPageSchema = z.object({
  schema_version: z.literal('kff.collection-page.v1'), source_key: z.enum(['kff.fixture.page.posts','social.discovery']), source_version: z.enum(['fixture-page-posts-v1','social-discovery-v1']),
  query_id: z.string().uuid(), account_external_id: z.string().regex(/^[0-9]{1,128}$/),
  cursor: z.string().min(1).max(2048).nullable(), next_cursor: z.string().min(1).max(2048).nullable(),
  observed_at: z.string().datetime(), reported_total: z.number().int().min(0).max(1000000000).nullable(),
  coverage: z.enum(['SYNTHETIC_SAMPLE','API_VISIBLE_ONLY','PROVIDER_RESULTS_ONLY','BROWSER_VISIBLE_ONLY']), rows: z.array(collectionRecordSchema).max(100),
}).strict();
export const collectionResumeInput = z.object({ request_id: z.string().uuid(), expected_version: z.number().int().min(0), reason: z.string().trim().min(5).max(300) }).strict();
export type CollectionSnapshot = z.infer<typeof collectionSnapshotSchema>;
export type CollectionPage = z.infer<typeof collectionPageSchema>;
export type CollectionRecord = z.infer<typeof collectionRecordSchema>;
export type CollectionQueryInput = z.input<typeof collectionInput>;
export interface CollectionRun {
  id: string; query_id: string; state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELED';
  version: number; committed_pages: number; returned_count: number; unique_count: number; reported_total: number | null;
  stop_reason: string | null; error_code: string | null; started_at: string | null; finished_at: string | null; created_at: string;
}
export interface CollectionQuery { id: string; title: string; snapshot: CollectionSnapshot | ManualImportSnapshot; snapshot_hash: string; created_at: string; expires_at: string }
export interface CollectionResult { id: string; source_object_id: string; observation_id: string; observed_at: string; source_url: string; fields: CollectionRecord['fields']; evidence_hash: string; allowed_purposes: string[]; expires_at: string; object_version: number; result_order: string }
