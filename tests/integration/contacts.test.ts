import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { contactPolicy, contactPermissionInput, type Scope } from '../../packages/contracts/src/index';
import { createContactTarget, grantContactPermission, exitContact, reviewContactBasis, assertContactBasisAtSubmission, revokeContactPermission, listContactRecords } from '../../packages/core/src/contacts';
import { setAccountPause } from '../../packages/core/src/controls';
import { createAccount } from '../../packages/core/src/service';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
function policy(overrides: Partial<z.infer<typeof contactPolicy>> = {}): z.infer<typeof contactPolicy> {
  return { basis_type: 'explicit_consent', purpose: 'marketing', source_type: 'manual_record', source_ref: 'synthetic/' + randomUUID(), source_observed_at: new Date(Date.now()-1000).toISOString(), source_use_status: 'CONFIRMED', starts_at: new Date(Date.now()-1000).toISOString(), expires_at: new Date(Date.now()+60000).toISOString(), policy_ref: 'synthetic-policy-v1', window_rule: 'NOT_REQUIRED', window_expires_at: null, evidence_note: 'Synthetic rule fixture only; no real contact authorization', ...overrides };
}
async function target() { return createContactTarget(scope, { account_id: localIds.account, channel: 'synthetic', remote_id: '0012345678901234567890_' + randomUUID() }); }
async function permitted(overrides: Partial<z.infer<typeof contactPolicy>> = {}) {
  const contact = await target(); const permission = await grantContactPermission(scope, { target_id: contact.id, request_id: randomUUID(), resume_opt_out: false, policy: policy(overrides) });
  return { contact, permission, review: { target_id: contact.id, permission_id: permission.id, purpose: permission.purpose } };
}
beforeAll(async () => {
  const name = (await query('SELECT current_database() AS name'))[0].name;
  if (name !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(name)) throw new Error('Isolated database required');
  await migrate(); await seed();
});
beforeEach(async () => {
  await query('TRUNCATE kff.contact_targets,kff.content_versions,kff.audit_events CASCADE');
  await query('UPDATE kff.organizations SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); await query('UPDATE kff.accounts SET outbound_paused=false');
});
afterAll(closePool);

it('preserves opaque identities and deduplicates one target without changing its identity', async () => {
  const contact = await target(); const repeated = await createContactTarget(scope, { account_id: localIds.account, channel: 'synthetic', remote_id: contact.remote_id });
  expect(repeated.id).toBe(contact.id); expect(repeated.remote_id).toMatch(/^0012345678901234567890_/);
  await expect(query("UPDATE kff.contact_targets SET remote_id='different' WHERE id=$1", [contact.id])).rejects.toThrow('IMMUTABLE_CONTACT_IDENTITY');
});
it('records one immutable permission under concurrent identical requests', async () => {
  const contact = await target(); const input = { target_id: contact.id, request_id: randomUUID(), resume_opt_out: false, policy: policy() };
  const rows = await Promise.all(Array.from({ length: 8 }, () => grantContactPermission(scope, input))); expect(new Set(rows.map(row => row.id)).size).toBe(1);
  await expect(grantContactPermission(scope, { ...input, policy: policy() })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(query("UPDATE kff.contact_permissions SET policy='{}' WHERE id=$1", [rows[0].id])).rejects.toThrow('IMMUTABLE_CONTACT_PERMISSION');
});
it.each(['UNKNOWN','DENIED'] as const)('blocks %s source permission regardless of any marketing ranking', async source => {
  const value = await permitted({ source_use_status: source }); const review = await reviewContactBasis(scope, value.review);
  expect(review.basis_eligible).toBe(false); expect(review.reason_codes).toContain('CONTACT_SOURCE_' + source);
  expect(contactPermissionInput.safeParse({ target_id: value.contact.id, request_id: randomUUID(), policy: policy(), high_intent: true }).success).toBe(false);
});
it('keeps contact basis separate from platform or execution authorization and rejects another purpose', async () => {
  const value = await permitted(); const review = await reviewContactBasis(scope, value.review);
  expect(review.basis_eligible).toBe(true); expect(review.execution_authorized).toBe(false);
  expect((await reviewContactBasis(scope, { ...value.review, purpose: 'customer_service' })).reason_codes).toContain('CONTACT_PURPOSE_MISMATCH');
});
it.each([
  [{ expires_at: new Date(Date.now()-100).toISOString(), starts_at: new Date(Date.now()-10000).toISOString() }, 'CONTACT_BASIS_EXPIRED'],
  [{ window_rule: 'UNKNOWN' }, 'CONTACT_WINDOW_UNKNOWN'],
  [{ window_rule: 'EXPLICIT_END', window_expires_at: new Date(Date.now()-100).toISOString() }, 'CONTACT_WINDOW_EXPIRED'],
] as const)('distinguishes expired basis and unknown or expired contact windows %#', async (override, reason) => {
  const value = await permitted(override); const review = await reviewContactBasis(scope, value.review); expect(review.basis_eligible).toBe(false); expect(review.reason_codes).toContain(reason);
});
it('requires an explicit service window for an inbound inquiry and never expands it to marketing', () => {
  expect(contactPolicy.safeParse(policy({ basis_type: 'inbound_inquiry' })).success).toBe(false);
  expect(contactPolicy.safeParse(policy({ basis_type: 'inbound_inquiry', purpose: 'customer_service', window_rule: 'EXPLICIT_END', window_expires_at: new Date(Date.now()+60000).toISOString() })).success).toBe(true);
});
it('blocks a queued selection immediately after opt-out and replays the exit without another state change', async () => {
  const value = await permitted(); const selection = (await reviewContactBasis(scope, value.review)).selection;
  const exit = { request_id: randomUUID(), expected_version: value.contact.version, reason: 'Synthetic opt-out request' };
  await exitContact(scope, value.contact.id, exit); await exitContact(scope, value.contact.id, exit);
  expect((await query('SELECT version FROM kff.contact_targets WHERE id=$1', [value.contact.id]))[0].version).toBe(2);
  await expect(scoped(scope, client => assertContactBasisAtSubmission(client, selection))).rejects.toMatchObject({ code: 'CONTACT_OPTED_OUT' });
});
it('requires fresh explicit consent to resume and keeps every older permission invalid', async () => {
  const value = await permitted(); await exitContact(scope, value.contact.id, { request_id: randomUUID(), expected_version: 1, reason: 'Synthetic exit' });
  await expect(grantContactPermission(scope, { target_id: value.contact.id, request_id: randomUUID(), resume_opt_out: true, policy: policy() })).rejects.toMatchObject({ code: 'CONTACT_NEW_CONSENT_REQUIRED' });
  await delay(5);
  const permission = await grantContactPermission(scope, { target_id: value.contact.id, request_id: randomUUID(), resume_opt_out: true, policy: policy({ source_observed_at: new Date().toISOString() }) });
  expect((await reviewContactBasis(scope, value.review)).reason_codes).toContain('CONTACT_BASIS_STALE');
  expect((await reviewContactBasis(scope, { ...value.review, permission_id: permission.id })).basis_eligible).toBe(true);
});
it('serializes final basis checking with opt-out and then refuses the old selection', async () => {
  const value = await permitted(); const selection = (await reviewContactBasis(scope, value.review)).selection;
  let checked!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { checked = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const submit = scoped(scope, async client => { await assertContactBasisAtSubmission(client, selection); checked(); await gate; });
  await ready; let exitComplete = false;
  const exiting = exitContact(scope, value.contact.id, { request_id: randomUUID(), expected_version: 1, reason: 'Concurrent synthetic exit' }).then(() => { exitComplete = true; });
  try { await delay(100); expect(exitComplete).toBe(false); } finally { release(); }
  await Promise.all([submit, exiting]);
  await expect(scoped(scope, client => assertContactBasisAtSubmission(client, selection))).rejects.toMatchObject({ code: 'CONTACT_OPTED_OUT' });
});
it('blocks revoked permission and paused account at final checking', async () => {
  const value = await permitted(); const selection = (await reviewContactBasis(scope, value.review)).selection;
  await setAccountPause(scope, localIds.account, true, 'Synthetic account pause'); await expect(scoped(scope, client => assertContactBasisAtSubmission(client, selection))).rejects.toMatchObject({ code: 'STOP_REQUESTED' });
  await setAccountPause(scope, localIds.account, false, 'End synthetic pause'); await revokeContactPermission(scope, value.permission.id, 'Synthetic basis revocation');
  await expect(scoped(scope, client => assertContactBasisAtSubmission(client, selection))).rejects.toMatchObject({ code: 'CONTACT_BASIS_REVOKED' });
});
it('applies brand isolation and refuses viewer changes', async () => {
  const value = await permitted(); const foreign = { ...scope, brand_id: randomUUID() };
  expect((await listContactRecords(foreign)).targets).toHaveLength(0);
  await expect(reviewContactBasis(foreign, value.review)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(exitContact({ ...scope, role: 'viewer' }, value.contact.id, { request_id: randomUUID(), expected_version: 1, reason: 'Not authorized' })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
});
// The brand-wide list is truncated to 200 rows before the page filters by account, so an account
// whose records are older than 200 newer rows from other accounts appears empty even though its
// records exist. The account filter has to run in SQL, before LIMIT, with a stable cursor.
it('returns an older account\'s contact records that a brand-wide truncation would hide', async () => {
  const other = await createAccount(scope, { display_name: 'Filter probe account', external_id: '7' + String(Date.now()).slice(-12), platform: 'facebook', account_type: 'page' });
  // 201 rows for the other account at the current time.
  for (let index = 0; index < 201; index++) {
    await query("INSERT INTO kff.contact_targets(organization_id,brand_id,account_id,channel,remote_id) VALUES($1,$2,$3,'synthetic',$4)", [scope.organization_id, scope.brand_id, other.id, 'probe-' + index + '-' + randomUUID()]);
  }
  // The record under test belongs to the seed account and is older than all 201 of them. The
  // timestamp is set on insert because a contact identity is immutable once written.
  const mineId = randomUUID(), olderAt = new Date(Date.now() - 7200000).toISOString();
  await query("INSERT INTO kff.contact_targets(id,organization_id,brand_id,account_id,channel,remote_id,created_at) VALUES($1,$2,$3,$4,'synthetic',$5,$6)", [mineId, scope.organization_id, scope.brand_id, localIds.account, 'older-' + randomUUID(), olderAt]);
  const mine = { id: mineId };

  // The brand-wide page cannot see the older account's record: this is the truncation, not a loss.
  const brandWide = await listContactRecords(scope);
  expect(brandWide.targets).toHaveLength(200);
  expect(brandWide.targets.some(row => (row as { id: string }).id === mine.id)).toBe(false);

  // Filtering by account in SQL returns it, and the page is honestly bounded.
  const scopedList = await listContactRecords(scope, { account_id: localIds.account });
  expect(scopedList.targets.map(row => (row as unknown as { id: string }).id)).toContain(mine.id);
  expect(scopedList.targets.every(row => (row as unknown as { account_id: string }).account_id === localIds.account)).toBe(true);
  expect(scopedList.has_more.targets).toBe(false);
  expect(scopedList.next_targets_cursor).toBeNull();

  // The other account pages through all 201 rows without dropping or repeating any.
  const seen: string[] = []; let cursor: string | null | undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await listContactRecords(scope, { account_id: other.id, targets_cursor: cursor ?? undefined });
    expect(listed.targets.every(row => (row as unknown as { account_id: string }).account_id === other.id)).toBe(true);
    seen.push(...listed.targets.map(row => (row as unknown as { id: string }).id));
    cursor = listed.next_targets_cursor;
    if (!cursor) break;
  }
  expect(seen).toHaveLength(201);
  expect(new Set(seen).size).toBe(201);

  // An account from another brand is never reachable, even when its id is valid.
  const foreign = { ...scope, brand_id: randomUUID() };
  expect((await listContactRecords(foreign, { account_id: localIds.account })).targets).toHaveLength(0);
  // A malformed cursor is refused rather than silently restarting from the newest row.
  await expect(listContactRecords(scope, { targets_cursor: 'not-a-cursor' })).rejects.toThrow();
});
