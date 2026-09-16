import { z } from 'zod';
export * from './imports';
import { templateSnapshotSchema } from './template';
import {outreachSnapshot} from './acquisition';
import {messageSnapshot} from './lead';
import { browserEnvironmentSnapshot } from './environment';
import { browserCollectionTaskSchema } from './browser-collection';
import { browserInboxTask, browserInboxPage } from './browser-inbox';
import { collectionPageSchema } from './collection';
export * from './contact';
export * from './cost';
export * from './adjudication';
export * from './template';
export * from './collection';

export const uuid = z.string().uuid();
export const externalId = z.string().regex(/^[0-9]{1,128}$/, '平台 ID 必须使用数字字符串');
export const modeSchema = z.enum(['DISABLED', 'TEST_ONLY', 'CONTROLLED_PILOT', 'PRODUCTION']);
export const evidenceStateSchema = z.enum(['UNASSESSED', 'FEASIBLE', 'IMPLEMENTED_TEST_ONLY', 'VERIFIED_REAL', 'BLOCKED', 'DEPRECATED']);
export const actionStateSchema = z.enum(['QUEUED', 'PREPARING', 'SUBMITTING', 'SUBMITTED', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'UNKNOWN_OUTCOME', 'CANCELED', 'BLOCKED', 'NEEDS_HUMAN']);
export type ActionState = z.infer<typeof actionStateSchema>;
export type ExecutionMode = z.infer<typeof modeSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export const fixtureScenarioSchema = z.enum(['normal', 'login_expired', 'wrong_account', 'duplicate_control', 'lost_after_submit', 'slow', 'delayed_receipt']);
export const accountInput = z.object({
  display_name: z.string().trim().min(1).max(80),
  external_id: externalId,
  platform: z.enum(['facebook','instagram']),
  account_type: z.enum(['page','professional','profile']),
  credential_ref: z.string().regex(/^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]{1,80}$/).optional(),
}).strict().refine(value => value.platform === 'instagram' ? value.account_type === 'professional' : ['page', 'profile'].includes(value.account_type), '账号类型与平台不匹配')
  .refine(value => value.account_type !== 'profile' || value.credential_ref === undefined, '个人账号使用本地浏览器登录，不登记主页 API 凭据');
export const environmentInput = z.object({ name: z.string().trim().min(1).max(80), account_id: uuid, agent_id: uuid }).strict();
export const taskInput = z.object({
  title: z.string().trim().min(1).max(120),
  account_id: uuid,
  environment_id: uuid,
  capability_id: uuid,
  template_version_id: uuid.optional(),
  body: z.string().trim().max(5000).default(''),
  mode: modeSchema,
  fixture_scenario: fixtureScenarioSchema.default('normal'),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
}).strict();
export const approvalInput = z.object({ snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['APPROVED', 'REJECTED']) }).strict();
export const stopInput = z.object({ reason: z.string().trim().min(1).max(300) }).strict();
export const pauseInput = z.object({ paused: z.boolean(), reason: z.string().trim().min(1).max(300) }).strict();
export const agentInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const agentControlInput = z.object({ action: z.enum(['DRAIN','RESUME','REVOKE']), reason: z.string().trim().min(1).max(300) }).strict();
export const heartbeatInput = z.object({ command_id: uuid.optional(), protocol_version: z.literal('kff.agent.v1') }).strict();
export const resultInput = z.object({
  event_id: uuid,
  command_id: uuid,
  outcome: z.enum(['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'UNKNOWN_OUTCOME', 'CANCELED', 'BLOCKED', 'NEEDS_HUMAN']),
  error_code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
  collection_page: collectionPageSchema.optional(),
  inbox_page: browserInboxPage.optional(),
  receipt: z.object({
    parent_id: z.string().regex(/^[0-9]{1,80}$/).optional(),
    source_url: z.string().max(500).optional(),
    thread_id: z.string().regex(/^[A-Za-z0-9_:+.@-]{1,160}$/).optional(),
    remote_id: z.string().regex(/^[A-Za-z0-9_:.=@$+/-]{1,200}$/),
    actual_account_id: externalId,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    evidence_kind: z.enum(['browser_dom', 'synthetic_dom', 'graph_object','synthetic_message','browser_message','browser_comment','graph_message']),
    recipient_id: externalId.optional(),
    observed_at: z.string().datetime(),
  }).strict().refine(value=>(value.evidence_kind==='browser_message'?/^[A-Za-z0-9_:+.@-]{1,160}$/:/^[A-Za-z0-9_:.=$+/-]{1,200}$/).test(value.remote_id),'远端消息标识与证据渠道不匹配').optional(),
  diagnostic: z.object({
    step: z.string().regex(/^[a-z0-9_-]{1,60}$/),
    duration_ms: z.number().int().min(0).max(3600000).optional(),
    executor_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    browser_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    // A blocked read must carry its reason: the report diagnostic is the only place it survives.
    error_kind: z.string().regex(/^[A-Za-z0-9_]{1,80}$/).optional(),
    error_message: z.string().min(1).max(200).optional(),
    scene: z.object({ identity_count: z.number().int().min(0).max(100), submit_controls: z.number().int().min(0).max(100), result_count: z.number().int().min(0).max(100), unparsed_visible_max: z.number().int().min(0).max(1000).optional() }).strict().optional(),
  }).strict(),
}).strict();
export const loginInput = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const quiescenceInput = z.object({
  protocol_version: z.literal('kff.guardian-closure.v1'), command_id: uuid, action_id: uuid,
  closed_at: z.string().datetime(), proof_sha256: hashSchema,
}).strict();
export const permitInput = z.object({
  task_id: uuid,
  max_actions: z.number().int().min(1).max(10),
  starts_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  max_cost_minor: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  per_action_max_minor: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  cost_basis: z.string().trim().min(10).max(500),
  authorization_evidence: z.string().trim().min(10).max(1000),
  platform_conditions: z.string().trim().min(10).max(1000),
  expected_evidence: z.enum(['inbox_page','collection_page','page_identity', 'published_post_identity_author_content','message_acceptance']),
  stop_rule: z.literal('stop_on_first_unknown_or_failure'),
  confirmation: z.literal('I_CONFIRM_THIS_EXACT_SCOPE'),
}).strict().refine(value => Date.parse(value.expires_at) > Date.parse(value.starts_at) && Date.parse(value.expires_at) - Date.parse(value.starts_at) <= 24 * 3600 * 1000, '试验窗口必须大于零且不超过 24 小时');
export const reconcileInput = z.object({ remote_id: z.string().regex(/^[0-9]+_[0-9]+$/).optional() }).strict();
export const taskSnapshotSchema = z.object({
  account_id: uuid, external_account_id: externalId, account_version: z.number().int().positive().optional(),
  credential_ref: z.string().regex(/^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]{1,80}$/).nullable().optional(),
  environment_id: uuid, profile_key: uuid, agent_id: uuid, capability_id: uuid,
  environment_version: z.number().int().positive().optional(),
  browser_environment: browserEnvironmentSnapshot.optional(),
  capability_key: z.enum(['facebook.comment.reply.browser','facebook.messenger.reply.browser','facebook.inbox.read.browser','facebook.discovery.read.browser','kff.fixture.messenger.reply.browser','kff.fixture.inbox.read.browser', 'kff.fixture.discovery.read.browser', 'kff.fixture.page.read.browser', 'kff.fixture.page.publish.browser', 'facebook.page.read.api', 'facebook.page.publish.api','kff.fixture.messenger.reply.api','facebook.messenger.reply.api','kff.fixture.social.reply.api','social.comment.reply.api','instagram.account.read.api']),
  capability_revision: z.number().int().positive(), adapter_version: z.enum(['facebook-browser-comment-v1','facebook-browser-messenger-v1','facebook-inbox-browser-v1','facebook-search-browser-v1','fixture-browser-messenger-v1','browser-inbox-v1', 'browser-discovery-v1', 'fixture-page-v1', 'facebook-graph-v1','fixture-messenger-v1','facebook-messenger-v1','social-outreach-v1','instagram-graph-v1']),
  implementation_digest: hashSchema.nullable().optional(),
  platform_api_version: z.string().regex(/^v[0-9]{1,3}\.[0-9]+$/).nullable().optional(),
  body: z.string().max(5000), content_hash: hashSchema, mode: modeSchema,
  not_before: z.iso.datetime().optional(),
  template: templateSnapshotSchema.optional(),
  message: messageSnapshot.optional(),
  outreach: outreachSnapshot.optional(),
  collection: browserCollectionTaskSchema.optional(),
  inbox: browserInboxTask.optional(),
  fixture_scenario: fixtureScenarioSchema, is_synthetic: z.boolean(),
}).strict().refine(value => (value.capability_key === 'facebook.comment.reply.browser') === Boolean(value.outreach?.browser) && (!value.outreach?.browser || !value.is_synthetic && value.mode === 'CONTROLLED_PILOT' && value.adapter_version === 'facebook-browser-comment-v1' && value.browser_environment?.configuration.driver === 'adspower' && value.browser_environment.account_type === 'profile' && value.browser_environment.platform === 'facebook' && !value.credential_ref && !value.platform_api_version && value.fixture_scenario === 'normal' && !value.message && !value.inbox && !value.collection), '公开评论回复需要独立的来源快照和 AdsPower 账号环境').refine(value => (['kff.fixture.messenger.reply.browser','facebook.messenger.reply.browser'].includes(value.capability_key)) === Boolean(value.message?.browser) && (!value.message?.browser || (value.capability_key === 'facebook.messenger.reply.browser' ? !value.is_synthetic && value.mode === 'CONTROLLED_PILOT' && value.adapter_version === 'facebook-browser-messenger-v1' && value.browser_environment?.configuration.driver === 'adspower' && value.browser_environment.account_type === 'profile' && value.browser_environment.platform === 'facebook' && value.message.actor_kind === 'HUMAN' && Boolean(value.message.browser.display_name) && Boolean(value.message.browser.trigger_content_hash) && !value.credential_ref && !value.platform_api_version && value.fixture_scenario === 'normal' : value.is_synthetic && value.mode === 'TEST_ONLY' && value.browser_environment?.configuration.driver === 'native') && value.message.contact.channel === 'facebook_browser_messenger' && value.message.contact.remote_id === value.message.browser.thread_id), '浏览器回复须包含同一会话和环境快照').refine(value => (['kff.fixture.inbox.read.browser','facebook.inbox.read.browser'].includes(value.capability_key)) === Boolean(value.inbox) && (!value.inbox || (value.capability_key === 'kff.fixture.inbox.read.browser' ? value.is_synthetic && value.mode === 'TEST_ONLY' && value.inbox.template === 'fixture-inbox-dom-v1' && !value.inbox.binding.target && !value.inbox.binding.discovery : !value.is_synthetic && value.mode === 'CONTROLLED_PILOT' && value.adapter_version === 'facebook-inbox-browser-v1' && value.inbox.template === 'facebook-inbox-dom-v1' && Boolean(value.inbox.binding.target || value.inbox.binding.discovery) && value.browser_environment?.account_type === 'profile' && value.browser_environment.platform === 'facebook' && !value.credential_ref && !value.platform_api_version && !value.body && value.inbox.cursor === null) && value.inbox.binding.account_version === value.account_version && JSON.stringify(value.inbox.binding.environment) === JSON.stringify(value.browser_environment) && !value.collection && !value.message && !value.outreach), '收件任务需要匹配的只读快照').refine(value => (['kff.fixture.discovery.read.browser','facebook.discovery.read.browser'].includes(value.capability_key)) === Boolean(value.collection) && (!value.collection || Boolean(value.browser_environment) && (value.capability_key === 'kff.fixture.discovery.read.browser' ? value.is_synthetic && value.mode === 'TEST_ONLY' && value.collection.snapshot.discovery?.browser?.template === 'fixture-discovery-dom-v1' : !value.is_synthetic && value.mode === 'CONTROLLED_PILOT' && value.browser_environment?.platform === 'facebook' && value.browser_environment.account_type === 'profile' && ['facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1'].includes(value.collection.snapshot.discovery?.browser?.template ?? '') && !value.credential_ref && !value.platform_api_version && !value.body && !value.message && !value.inbox && !value.outreach) && value.collection.snapshot.account_id === value.account_id && value.collection.snapshot.external_account_id === value.external_account_id && value.collection.snapshot.account_version === value.account_version && value.collection.snapshot.browser_environment?.environment_id === value.environment_id), '采集任务必须包含匹配的只读分页快照').refine(value => !value.browser_environment || value.capability_key.endsWith('.browser') && value.browser_environment.environment_id === value.environment_id && value.browser_environment.account_id === value.account_id && value.browser_environment.agent_id === value.agent_id && value.browser_environment.profile_key === value.profile_key && value.browser_environment.configuration_version === value.environment_version && value.browser_environment.is_synthetic === value.is_synthetic && value.browser_environment.configuration.operating_identity_id === value.external_account_id, '受管浏览器绑定必须与任务一致').refine(value=>value.capability_key.includes('.social.')||['social.comment.reply.api','facebook.comment.reply.browser'].includes(value.capability_key)?Boolean(value.outreach)&&!value.message:!value.outreach,'互动动作必须包含目标快照').refine(value=>value.capability_key.includes('.messenger.')===Boolean(value.message),'消息能力必须包含会话快照，其他能力不能携带消息');
export const agentCommandSchema = z.object({
  protocol_version: z.literal('kff.agent.v1'),
  id: uuid, action_id: uuid, attempt_id: uuid, run_id: uuid, organization_id: uuid, brand_id: uuid, agent_id: uuid,
  snapshot: taskSnapshotSchema, snapshot_hash: hashSchema,
  leases: z.array(z.object({ resource_type: z.enum(['account', 'environment']), resource_id: uuid, token: z.string().regex(/^[1-9][0-9]*$/) }).strict()).length(2),
  expires_at: z.string().datetime(),
}).strict();

export interface Scope { organization_id: string; brand_id: string; user_id: string; role: 'admin' | 'operator' | 'viewer' }
export interface Account { id: string; organization_id: string; brand_id: string; display_name: string; platform: string; account_type: string; external_id: string; credential_ref: string | null; state: string; outbound_paused: boolean; is_synthetic: boolean; version: number; created_at: string }
export interface Environment { browser_configuration?: import('./environment').BrowserConfiguration | null; configuration_version?: number; id: string; account_id: string; agent_id: string; name: string; profile_key: string; state: string; created_at: string }
export interface Capability { id: string; account_id: string; capability_key: string; revision: number; adapter_version: string; implementation_digest?: string | null; evidence_state: EvidenceState; mode: ExecutionMode; is_synthetic: boolean; description: string; last_verified_at: string | null }
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export interface Task { id: string; title: string; account_id: string; environment_id: string; capability_id: string; status: string; snapshot: TaskSnapshot; snapshot_hash: string; created_at: string; updated_at: string }
export interface Run { id: string; task_id: string; title?: string; status: string; stop_requested: boolean; created_at: string; updated_at: string; action_id?: string; action_state?: ActionState; adjudication_version?: number; error_code?: string | null; receipt?: Record<string, unknown> | null }
export interface LeaseToken { resource_type: 'account' | 'environment'; resource_id: string; token: string }
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type ActionReport = z.infer<typeof resultInput>;
