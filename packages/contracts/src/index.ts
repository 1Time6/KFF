import { z } from 'zod';
export * from './contact';
export * from './cost';
export * from './adjudication';

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
  platform: z.literal('facebook'),
  account_type: z.literal('page'),
  credential_ref: z.string().regex(/^FACEBOOK_[A-Z0-9_]{1,80}$/).optional(),
}).strict();
export const environmentInput = z.object({ name: z.string().trim().min(1).max(80), account_id: uuid, agent_id: uuid }).strict();
export const taskInput = z.object({
  title: z.string().trim().min(1).max(120),
  account_id: uuid,
  environment_id: uuid,
  capability_id: uuid,
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
  receipt: z.object({
    remote_id: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
    actual_account_id: externalId,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    evidence_kind: z.enum(['synthetic_dom', 'graph_object']),
    observed_at: z.string().datetime(),
  }).strict().optional(),
  diagnostic: z.object({
    step: z.string().regex(/^[a-z0-9_-]{1,60}$/),
    duration_ms: z.number().int().min(0).max(3600000).optional(),
    executor_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    browser_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    scene: z.object({ identity_count: z.number().int().min(0).max(100), submit_controls: z.number().int().min(0).max(100), result_count: z.number().int().min(0).max(100) }).strict().optional(),
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
  expected_evidence: z.enum(['page_identity', 'published_post_identity_author_content']),
  stop_rule: z.literal('stop_on_first_unknown_or_failure'),
  confirmation: z.literal('I_CONFIRM_THIS_EXACT_SCOPE'),
}).strict().refine(value => Date.parse(value.expires_at) > Date.parse(value.starts_at) && Date.parse(value.expires_at) - Date.parse(value.starts_at) <= 24 * 3600 * 1000, '试验窗口必须大于零且不超过 24 小时');
export const reconcileInput = z.object({ remote_id: z.string().regex(/^[0-9]+_[0-9]+$/).optional() }).strict();
export const taskSnapshotSchema = z.object({
  account_id: uuid, external_account_id: externalId, account_version: z.number().int().positive().optional(),
  credential_ref: z.string().regex(/^FACEBOOK_[A-Z0-9_]{1,80}$/).nullable().optional(),
  environment_id: uuid, profile_key: uuid, agent_id: uuid, capability_id: uuid,
  capability_key: z.enum(['kff.fixture.page.read.browser', 'kff.fixture.page.publish.browser', 'facebook.page.read.api', 'facebook.page.publish.api']),
  capability_revision: z.number().int().positive(), adapter_version: z.enum(['fixture-page-v1', 'facebook-graph-v1']),
  implementation_digest: hashSchema.nullable().optional(),
  platform_api_version: z.string().regex(/^v[0-9]{1,3}\.[0-9]+$/).nullable().optional(),
  body: z.string().max(5000), content_hash: hashSchema, mode: modeSchema,
  fixture_scenario: fixtureScenarioSchema, is_synthetic: z.boolean(),
}).strict();
export const agentCommandSchema = z.object({
  protocol_version: z.literal('kff.agent.v1'),
  id: uuid, action_id: uuid, attempt_id: uuid, run_id: uuid, organization_id: uuid, brand_id: uuid, agent_id: uuid,
  snapshot: taskSnapshotSchema, snapshot_hash: hashSchema,
  leases: z.array(z.object({ resource_type: z.enum(['account', 'environment']), resource_id: uuid, token: z.string().regex(/^[1-9][0-9]*$/) }).strict()).length(2),
  expires_at: z.string().datetime(),
}).strict();

export interface Scope { organization_id: string; brand_id: string; user_id: string; role: 'admin' | 'operator' | 'viewer' }
export interface Account { id: string; organization_id: string; brand_id: string; display_name: string; platform: string; account_type: string; external_id: string; credential_ref: string | null; state: string; outbound_paused: boolean; is_synthetic: boolean; version: number; created_at: string }
export interface Environment { id: string; account_id: string; agent_id: string; name: string; profile_key: string; state: string; created_at: string }
export interface Capability { id: string; account_id: string; capability_key: string; revision: number; adapter_version: string; implementation_digest?: string | null; evidence_state: EvidenceState; mode: ExecutionMode; is_synthetic: boolean; description: string; last_verified_at: string | null }
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export interface Task { id: string; title: string; account_id: string; environment_id: string; capability_id: string; status: string; snapshot: TaskSnapshot; snapshot_hash: string; created_at: string; updated_at: string }
export interface Run { id: string; task_id: string; title?: string; status: string; stop_requested: boolean; created_at: string; updated_at: string; action_id?: string; action_state?: ActionState; adjudication_version?: number; error_code?: string | null; receipt?: Record<string, unknown> | null }
export interface LeaseToken { resource_type: 'account' | 'environment'; resource_id: string; token: string }
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type ActionReport = z.infer<typeof resultInput>;
