import { z } from 'zod';
import type { PoolClient } from 'pg';
import { scoped } from '@kff/database';
import { contactTargetInput, contactPermissionInput, contactPolicy, contactExitInput, contactReviewInput, contactSelectionSchema, type ContactSelection, type Scope } from '@kff/contracts';
import { digest, requireCondition } from './index';
import { requireAdmin, requireWrite, audit } from './service';

export async function createContactTarget(scope: Scope, input: z.infer<typeof contactTargetInput>) {
  requireWrite(scope); const value = contactTargetInput.parse(input);
  return scoped(scope, async client => {
    const account = (await client.query('SELECT platform,is_synthetic FROM kff.accounts WHERE id=$1', [value.account_id])).rows[0];
    requireCondition(account, 'NOT_FOUND', '账号不存在', 404);
    requireCondition((value.channel === 'synthetic' && account.is_synthetic) || (value.channel === 'facebook_messenger' && account.platform === 'facebook' && /^[0-9]{1,128}$/.test(value.remote_id)) || (value.channel === 'site_chat' && account.platform === 'site'), 'FORBIDDEN_SCOPE', '目标标识或渠道与账号不匹配', 403);
    const row = (await client.query('INSERT INTO kff.contact_targets(organization_id,brand_id,account_id,channel,remote_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(brand_id,account_id,channel,remote_id) DO UPDATE SET remote_id=EXCLUDED.remote_id RETURNING *', [scope.organization_id, scope.brand_id, value.account_id, value.channel, value.remote_id])).rows[0];
    await audit(client, scope, 'contact.target_registered', row.id, { account_id: value.account_id, channel: value.channel }); return row;
  });
}
export async function grantContactPermission(scope: Scope, input: z.infer<typeof contactPermissionInput>) {
  requireAdmin(scope); const value = contactPermissionInput.parse(input); const requestHash = digest(value);
  return scoped(scope, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['contact-permission/' + scope.brand_id + '/' + value.request_id]);
    const previous = (await client.query('SELECT * FROM kff.contact_permissions WHERE request_id=$1', [value.request_id])).rows[0];
    if (previous) { requireCondition(previous.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', '同一请求已登记不同依据', 409); return previous; }
    const target = (await client.query('SELECT * FROM kff.contact_targets WHERE id=$1 FOR UPDATE', [value.target_id])).rows[0];
    requireCondition(target, 'NOT_FOUND', '联系目标不存在', 404);
    if (value.resume_opt_out) {
      requireCondition(target.opted_out && value.policy.basis_type === 'explicit_consent' && value.policy.source_use_status === 'CONFIRMED' && value.policy.window_rule !== 'UNKNOWN' && Date.parse(value.policy.source_observed_at) > new Date(target.opted_out_at).getTime(), 'CONTACT_NEW_CONSENT_REQUIRED', '恢复联系需要退出之后新的明确同意及已知规则', 409);
      const time = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      requireCondition(Date.parse(value.policy.source_observed_at) <= time.getTime() && Date.parse(value.policy.starts_at) <= time.getTime() && Date.parse(value.policy.expires_at) > time.getTime() && (value.policy.window_expires_at === null || Date.parse(value.policy.window_expires_at) > time.getTime()), 'CONTACT_BASIS_EXPIRED', '新的同意依据或窗口尚未生效或已过期', 409);
      target.version++;
      await client.query('UPDATE kff.contact_targets SET opted_out=false,version=$1 WHERE id=$2', [target.version, target.id]);
    }
    const row = (await client.query('INSERT INTO kff.contact_permissions(organization_id,brand_id,target_id,target_version,purpose,policy,policy_hash,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [scope.organization_id, scope.brand_id, target.id, target.version, value.policy.purpose, value.policy, digest(value.policy), value.request_id, requestHash])).rows[0];
    await audit(client, scope, value.resume_opt_out ? 'contact.resubscribed' : 'contact.permission_recorded', target.id, { permission_id: row.id, policy_hash: row.policy_hash, target_version: target.version, source_type: value.policy.source_type }); return row;
  });
}
export async function exitContact(scope: Scope, targetId: string, input: z.infer<typeof contactExitInput>) {
  requireWrite(scope); const value = contactExitInput.parse(input);
  return scoped(scope, async client => {
    const target = (await client.query('SELECT * FROM kff.contact_targets WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
    requireCondition(target, 'NOT_FOUND', '联系目标不存在', 404);
    const previous = (await client.query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='contact.opted_out' AND details->>'request_id'=$2", [target.id, value.request_id])).rows[0];
    if (previous) { requireCondition(previous.details.request_hash === digest(value), 'IDEMPOTENCY_CONFLICT', '退出请求内容已变化', 409); return previous.details.result; }
    requireCondition(target.version === value.expected_version, 'VERSION_CONFLICT', '联系状态已变化，请刷新后重试', 409);
    const row = (await client.query('UPDATE kff.contact_targets SET opted_out=true,opted_out_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING id,version,opted_out,opted_out_at', [target.id])).rows[0];
    await audit(client, scope, 'contact.opted_out', target.id, { request_id: value.request_id, request_hash: digest(value), reason: value.reason, result: row }); return row;
  });
}
export async function revokeContactPermission(scope: Scope, permissionId: string, reason: string) {
  requireAdmin(scope); z.string().trim().min(1).max(300).parse(reason);
  return scoped(scope, async client => {
    const row = (await client.query('UPDATE kff.contact_permissions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING id,target_id,revoked_at', [permissionId])).rows[0];
    requireCondition(row, 'NOT_FOUND', '联系依据不存在', 404); await audit(client, scope, 'contact.permission_revoked', row.target_id, { permission_id: row.id, reason }); return row;
  });
}
async function evaluateBasis(client: PoolClient, value: z.infer<typeof contactReviewInput>, selection?: ContactSelection) {
  // These shared locks live until the caller's submission transaction ends. Exit takes the same target's update lock.
  const targetAccount = (await client.query('SELECT account_id FROM kff.contact_targets WHERE id=$1', [value.target_id])).rows[0];
  requireCondition(targetAccount, 'NOT_FOUND', '联系目标不存在', 404);
  // Organization control is read-only to kff_app; the common execution gate owns its organization lock.
  const account = (await client.query('SELECT a.*,b.outbound_paused AS brand_paused,o.outbound_paused AS organization_paused FROM kff.accounts a JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE a.id=$1 FOR SHARE OF a,b', [targetAccount.account_id])).rows[0];
  const target = (await client.query('SELECT * FROM kff.contact_targets WHERE id=$1 FOR SHARE', [value.target_id])).rows[0];
  const permission = (await client.query('SELECT * FROM kff.contact_permissions WHERE id=$1 AND target_id=$2 FOR SHARE', [value.permission_id, target.id])).rows[0];
  requireCondition(permission, 'NOT_FOUND', '目标没有这条联系依据', 404);
  const policy = contactPolicy.parse(permission.policy);
  const now = ((await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const reasons: string[] = [];
  if (target.opted_out) reasons.push('CONTACT_OPTED_OUT');
  if (account.state !== 'ACTIVE') reasons.push('ACCOUNT_UNAVAILABLE');
  if (account.outbound_paused || account.brand_paused || account.organization_paused) reasons.push('STOP_REQUESTED');
  if (permission.revoked_at) reasons.push('CONTACT_BASIS_REVOKED');
  if (permission.target_version !== target.version) reasons.push('CONTACT_BASIS_STALE');
  if (permission.purpose !== value.purpose || policy.purpose !== value.purpose) reasons.push('CONTACT_PURPOSE_MISMATCH');
  if (policy.source_use_status !== 'CONFIRMED') reasons.push('CONTACT_SOURCE_' + policy.source_use_status);
  if (Date.parse(policy.starts_at) > now || Date.parse(policy.expires_at) <= now || Date.parse(policy.source_observed_at) > now) reasons.push('CONTACT_BASIS_EXPIRED');
  if (policy.window_rule === 'UNKNOWN') reasons.push('CONTACT_WINDOW_UNKNOWN');
  if (policy.window_rule === 'EXPLICIT_END' && Date.parse(policy.window_expires_at!) <= now) reasons.push('CONTACT_WINDOW_EXPIRED');
  const current: ContactSelection = { target_id: target.id, permission_id: permission.id, purpose: value.purpose, account_id: target.account_id, channel: target.channel, remote_id: target.remote_id, target_version: target.version, policy_hash: permission.policy_hash };
  requireCondition(digest(policy) === permission.policy_hash, 'CONTACT_BASIS_STALE', '联系依据摘要不匹配', 409);
  if (selection && digest(current) !== digest(selection)) reasons.push('CONTACT_SELECTION_STALE');
  return { basis_eligible: reasons.length === 0, reason_codes: reasons, selection: current, execution_authorized: false as const };
}
export async function reviewContactBasis(scope: Scope, input: z.infer<typeof contactReviewInput>) {
  const value = contactReviewInput.parse(input); return scoped(scope, client => evaluateBasis(client, value));
}
export async function assertContactBasisAtSubmission(client: PoolClient, selection: ContactSelection) {
  const value = contactSelectionSchema.parse(selection); const result = await evaluateBasis(client, value, value);
  requireCondition(result.basis_eligible, result.reason_codes[0], '联系依据已不满足本次用途，停止新提交', 409); return result.selection;
}
/** Stable position cursor for the contact lists, which are ordered by `created_at DESC, id DESC`. */
export function contactCursor(row:{id:string;created_at:string}){return new Date(row.created_at).toISOString()+'|'+row.id;}
export function parseContactCursor(value:string|undefined):{created_at:string;id:string}|null{
  if(!value)return null;
  const separator=value.lastIndexOf('|');
  requireCondition(separator>0,'INVALID_INPUT','联系记录游标无效');
  return {created_at:z.string().datetime().parse(value.slice(0,separator)),id:z.string().uuid().parse(value.slice(separator+1))};
}
/**
 * List contact targets and permissions.
 *
 * The account filter is applied in SQL, before LIMIT. The previous version took the newest 200 rows
 * for the whole brand and let the page filter by account afterwards, so an account whose records
 * were older than 200 newer rows from other accounts looked empty even though its records existed.
 * Each list pages independently with a `(created_at, id)` cursor, and `has_more` distinguishes
 * "this account has no records" from "this page has no more records".
 */
export async function listContactRecords(scope: Scope, options:{account_id?:string;targets_cursor?:string;permissions_cursor?:string}={}) {
  return scoped(scope, async client => {
    const accountId = options.account_id ?? null;
    requireCondition(!accountId || z.string().uuid().safeParse(accountId).success, 'INVALID_INPUT', '账号标识无效');
    // One prepared shape for both lists: account filter first, then the position cursor.
    const clause = 'WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 201';
    // A permission has no account of its own; it belongs to the account through its target, so the
    // filter is applied on the joined target before LIMIT. Cursor columns are qualified for the join.
    const permissionClause = 'WHERE ($1::uuid IS NULL OR t.account_id=$1) AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2::timestamptz,$3::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 201';
    const targetCursor = parseContactCursor(options.targets_cursor), permissionCursor = parseContactCursor(options.permissions_cursor);
    const targets = (await client.query('SELECT * FROM kff.contact_targets ' + clause, [accountId, targetCursor?.created_at ?? null, targetCursor?.id ?? null])).rows;
    const permissions = (await client.query('SELECT p.* FROM kff.contact_permissions p JOIN kff.contact_targets t ON t.id=p.target_id AND t.organization_id=p.organization_id AND t.brand_id=p.brand_id ' + permissionClause, [accountId, permissionCursor?.created_at ?? null, permissionCursor?.id ?? null])).rows;
    // One extra row is fetched only to answer "is there another page"; it is never returned.
    const slice = (rows: { id: string; created_at: string }[]) => ({ rows: rows.slice(0, 200), next: rows.length > 200 ? contactCursor(rows[199]) : null });
    const targetPage = slice(targets), permissionPage = slice(permissions);
    return {
      targets: targetPage.rows, permissions: permissionPage.rows, account_id: accountId,
      next_targets_cursor: targetPage.next, next_permissions_cursor: permissionPage.next,
      has_more: { targets: targetPage.next !== null, permissions: permissionPage.next !== null },
      execution_authorized: false as const,
    };
  });
}
