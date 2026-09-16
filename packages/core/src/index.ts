import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { browserInboxDiscoverySummary } from '@kff/contracts';
import type { ActionState, Capability, ExecutionMode, TaskSnapshot } from '@kff/contracts';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
export function requireCondition(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
export function hashPassword(password: string): string { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
export function checkPassword(password: string, encoded: string): boolean {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || hash.length !== 128) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}

const transitions: Record<ActionState, readonly ActionState[]> = {
  QUEUED: ['PREPARING', 'CANCELED', 'BLOCKED'],
  PREPARING: ['SUBMITTING', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'CANCELED', 'BLOCKED', 'NEEDS_HUMAN'],
  SUBMITTING: ['SUBMITTED', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'UNKNOWN_OUTCOME'],
  SUBMITTED: ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'UNKNOWN_OUTCOME'],
  UNKNOWN_OUTCOME: ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'NEEDS_HUMAN'],
  VERIFIED_SUCCEEDED: [], VERIFIED_FAILED: [], CANCELED: [], BLOCKED: [], NEEDS_HUMAN: [],
};
export function assertTransition(from: ActionState, to: ActionState): void {
  requireCondition(from === to || transitions[from].includes(to), 'VERSION_CONFLICT', '当前动作状态不允许此变更', 409);
}
export function canExecute(capability: Capability, mode: ExecutionMode, liveEnabled: boolean, validPilot = false): { allowed: boolean; reason_code: string } {
  if (mode === 'DISABLED' || capability.mode === 'DISABLED') return { allowed: false, reason_code: 'CAPABILITY_BLOCKED' };
  if (['BLOCKED', 'DEPRECATED', 'UNASSESSED'].includes(capability.evidence_state)) return { allowed: false, reason_code: 'CAPABILITY_UNASSESSED' };
  if (mode === 'TEST_ONLY') return { allowed: capability.is_synthetic && capability.mode === 'TEST_ONLY', reason_code: capability.is_synthetic ? 'TEST_SCOPE' : 'PILOT_PERMIT_REQUIRED' };
  if (!liveEnabled) return { allowed: false, reason_code: 'LIVE_DISABLED' };
  if (capability.is_synthetic) return { allowed: false, reason_code: 'FORBIDDEN_SCOPE' };
  if (mode === 'PRODUCTION') return { allowed: capability.mode === mode && capability.evidence_state === 'VERIFIED_REAL', reason_code: 'CAPABILITY_UNASSESSED' };
  return { allowed: validPilot && capability.mode === 'CONTROLLED_PILOT' && ['IMPLEMENTED_TEST_ONLY', 'VERIFIED_REAL'].includes(capability.evidence_state), reason_code: validPilot ? 'CAPABILITY_UNASSESSED' : 'PILOT_PERMIT_REQUIRED' };
}
export function executionEnabled(key: string) { return process.env[key === 'facebook.inbox.read.browser' ? 'KFF_ENABLE_BROWSER_INBOX' : key === 'facebook.discovery.read.browser' ? 'KFF_ENABLE_DISCOVERY' : 'KFF_ENABLE_LIVE'] === 'true'; }
export function isWrite(snapshot: TaskSnapshot): boolean { return snapshot.capability_key.includes('.publish.')||snapshot.capability_key.includes('.reply.'); }
export function validateTargetUrl(value: string, allowedHosts: readonly string[], fixtureOrigin?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('INVALID_INPUT', '无效的目标地址'); }
  requireCondition(!url.username && !url.password && !url.hash, 'INVALID_INPUT', '地址不能包含凭据或片段');
  const fixture = fixtureOrigin !== undefined && url.origin === fixtureOrigin;
  requireCondition(fixture || (url.protocol === 'https:' && !url.port && allowedHosts.includes(url.hostname)), 'FORBIDDEN_SCOPE', '目标不在允许的地址范围内', 403);
  requireCondition(!/%2f|%5c|\.\./i.test(url.pathname), 'INVALID_INPUT', '目标路径不符合要求');
  return url;
}
export function profilePath(root: string, profileKey: string): string {
  requireCondition(/^[a-f0-9-]{36}$/.test(profileKey), 'INVALID_INPUT', '环境目录标识无效');
  const base = path.resolve(root);
  const resolved = path.resolve(base, profileKey);
  requireCondition(path.dirname(resolved) === base, 'FORBIDDEN_SCOPE', '环境路径越界', 403);
  return resolved;
}
export function redactUrl(value: string): string {
  try { const url = new URL(value); return url.origin + '/[redacted]'; } catch { return '[redacted]'; }
}
export function redactError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof AppError) return { code: error.code, message: error.message, status: error.status };
  return { code: 'INTERNAL_ERROR', message: '操作未完成，请查看运行记录或稍后重试', status: 500 };
}
export function buildDiagnostic(report: { step: string; scene?: Record<string, number>; duration_ms?: number; executor_version?: string; browser_version?: string; error_kind?: string; error_message?: string; inbox_discovery?: unknown }, errorCode: string | undefined, scope: { organization_id: string; brand_id: string }, actionId: string, execution?: { adapter_version: string; attempt_id: string; outcome: ActionState }) {
  const scene = report.scene ? Object.fromEntries(Object.entries(report.scene).filter(([key, value]) => ['identity_count', 'submit_controls', 'result_count'].includes(key) && Number.isSafeInteger(value) && value >= 0 && value <= 100)) : null;
  // A blocked action has to keep its reason. The executor already reports only a fact-only kind and a
  // bounded, page-content-free message, so they are carried through the allowlist unchanged.
  const errorKind = report.error_kind && /^[A-Za-z0-9_]{1,80}$/.test(report.error_kind) ? report.error_kind : null;
  const errorMessage = report.error_message ? report.error_message.slice(0, 200) : null;
  // A window that failed closed returns the per-conversation reasons it collected. They are re-parsed
  // here rather than trusted: only the bounded summary survives, so page text, message bodies and raw
  // provider output cannot reach the bundle even if an executor tried to send them.
  const discovery = browserInboxDiscoverySummary.safeParse(report.inbox_discovery);
  const files = [
    ...(scene ? [{ name: 'semantic-counts.json' as const, sha256: digest(scene), content: scene }] : []),
    ...(discovery.success ? [{ name: 'inbox-discovery.json' as const, sha256: digest(discovery.data), content: discovery.data }] : []),
  ];
  return {
    schema_version: 'kff.diagnostic.v2', organization_id: scope.organization_id, brand_id: scope.brand_id, action_id: actionId,
    protocol_version: 'kff.agent.v1', adapter_version: execution?.adapter_version ?? null, attempt_id: execution?.attempt_id ?? null, outcome: execution?.outcome ?? null,
    duration_ms: report.duration_ms ?? null, executor_version: report.executor_version ?? null, browser_version: report.browser_version ?? null,
    level: files.length ? 'D1' : 'D0', step: report.step, error_code: errorCode ?? null, error_kind: errorKind, error_message: errorMessage,
    created_at: new Date().toISOString(), redaction_version: 'allowlist-v1',
    files,
    omitted: ['raw_dom', 'screenshots', 'trace', 'cookies', 'message_body', 'network_bodies'],
    downgrade_reason: files.length ? null : '本驱动未取得可安全导出的现场，保留 D0',
  };
}
