import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, scoped, closePool } from '../../packages/database/src/index';
import { ensureBundledTemplates, createTemplateVersion, previewTemplate, setTemplatePolicy, templateWorkspace } from '../../packages/core/src/templates';
import { createTask, approveTask, enqueueTask, runDetail, workspace } from '../../packages/core/src/service';
import { dispatchOne, claimCommand, beginSubmission, acceptReport } from '../../packages/core/src/execution';
import { reconcileSynthetic, recordQuiescence, releaseQuarantine } from '../../packages/core/src/reconciliation';
import type { Scope, TemplateVersion } from '../../packages/contracts/src/index';

const scope: Scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' };
const agent = { id: localIds.agent, organization_id: scope.organization_id, brand_id: scope.brand_id, status: 'ONLINE' };
const taskInput = (versionId?: string, body = 'Synthetic template input') => ({ title: 'Isolated template task', account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.publish, template_version_id: versionId, body, mode: 'TEST_ONLY' as const, fixture_scenario: 'normal' as const, idempotency_key: randomUUID() });
const previewInput = (body = 'Synthetic template input') => ({ request_id: randomUUID(), account_id: localIds.account, environment_id: localIds.environment, capability_id: localIds.publish, body });
const policy = (version: TemplateVersion, action: 'ALLOW' | 'DISABLE' | 'DEPRECATE') => setTemplatePolicy(scope, version.id, { request_id: randomUUID(), expected_policy_version: version.policy_version, action, reason: 'Isolated template policy verification' });
async function base() { return (await templateWorkspace(scope)).versions.find(version => version.capability_key === 'kff.fixture.page.publish.browser' && version.version_number === 1)!; }
async function derived(max = 100) { return createTemplateVersion(scope, { request_id: randomUUID(), based_on_version_id: (await base()).id, name: 'Synthetic derived version', version_label: 'v2', max_body_length: max, reason: 'Isolated input bound change' }); }
async function enabled(max = 100) { const version = await derived(max); await previewTemplate(scope, version.id, previewInput('OK')); return policy(version, 'ALLOW'); }
async function queued(versionId?: string) { const task = await createTask(scope, taskInput(versionId)); await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' }); return { task, run: await enqueueTask(scope, task.id) }; }
async function claimed(versionId?: string) { const value = await queued(versionId); expect(await dispatchOne()).toBe(true); const command = (await claimCommand(agent))!; return { ...value, command }; }
async function reset() {
  const database = (await query('SELECT current_database() AS name'))[0].name;
  if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Isolated database required');
  await query('TRUNCATE kff.content_versions,kff.template_versions,kff.audit_events,kff.cost_budgets CASCADE');
  await scoped(scope, client => ensureBundledTemplates(client, scope));
  await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=now() WHERE id=$1", [agent.id]);
  await query("UPDATE kff.environments SET state='IDLE'");
  await query('UPDATE kff.organizations SET outbound_paused=false'); await query('UPDATE kff.brands SET outbound_paused=false'); await query('UPDATE kff.accounts SET outbound_paused=false');
}
beforeAll(async () => { if (!process.env.KFF_TEST_DATABASE?.startsWith('kff_test_')) throw new Error('Isolated database required'); await migrate(); await seed(); });
beforeEach(reset);
afterAll(async () => { await reset(); await closePool(); });

// The ALLOW button used to decide from the version state and the page's newest preview, so it was
// offered for a version the server refuses with TEMPLATE_PREVIEW_REQUIRED, and a qualifying preview
// older than the returned preview window was invisible to it.
it('reports enable readiness from every preview, not from the page window', async () => {
  const version = await derived();
  const readiness = async () => (await templateWorkspace(scope)).versions.find(row => row.id === version.id)!;
  // A new version has no preview at all.
  expect((await readiness()).enable_ready).toBe(false);
  await expect(policy(version, 'ALLOW')).rejects.toMatchObject({ code: 'TEMPLATE_PREVIEW_REQUIRED' });
  // One qualifying preview is enough.
  await previewTemplate(scope, version.id, previewInput('OK'));
  expect((await readiness()).enable_ready).toBe(true);
  // 201 newer previews for the same version push the qualifying one outside the returned window.
  for (let index = 0; index < 201; index++) {
    await scoped(scope, client => client.query("INSERT INTO kff.template_previews(id,organization_id,brand_id,template_version_id,manifest_hash,account_id,environment_id,capability_id,request_hash,input_hash,can_enable,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12)", [randomUUID(), scope.organization_id, scope.brand_id, version.id, version.manifest_hash, localIds.account, localIds.environment, localIds.publish, randomUUID(), randomUUID(), { valid: false }, scope.user_id]));
  }
  const page = await templateWorkspace(scope);
  // The page cannot see the qualifying preview any more: the newest 200 are all failures.
  expect(page.previews.filter(row => row.template_version_id === version.id).every(row => !row.can_enable)).toBe(true);
  // Readiness is still true, because the server computes it over every preview, and the server does
  // enable the version: a later failed preview must not hide an earlier success.
  expect(page.versions.find(row => row.id === version.id)!.enable_ready).toBe(true);
  expect((await policy(version, 'ALLOW')).state).toBe('ALLOWED');
  // A version whose only preview would be a failure stays not-ready.
  const failed = await derived(120);
  await scoped(scope, client => client.query("INSERT INTO kff.template_previews(id,organization_id,brand_id,template_version_id,manifest_hash,account_id,environment_id,capability_id,request_hash,input_hash,can_enable,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12)", [randomUUID(), scope.organization_id, scope.brand_id, failed.id, failed.manifest_hash, localIds.account, localIds.environment, localIds.publish, randomUUID(), randomUUID(), { valid: false }, scope.user_id]));
  expect((await templateWorkspace(scope)).versions.find(row => row.id === failed.id)!.enable_ready).toBe(false);
});

it('deduplicates new versions and allocates unique version numbers under concurrent changes', async () => {  const input = { request_id: randomUUID(), based_on_version_id: (await base()).id, name: 'New test version', version_label: 'v2', max_body_length: 100, reason: 'Synthetic change record' };
  const repeated = await Promise.all(Array.from({ length: 5 }, () => createTemplateVersion(scope, input)));
  expect(new Set(repeated.map(row => row.id)).size).toBe(1);
  const versions = await Promise.all(Array.from({ length: 4 }, (_, index) => createTemplateVersion(scope, { ...input, request_id: randomUUID(), version_label: 'parallel-' + index })));
  expect(new Set(versions.map(row => row.version_number)).size).toBe(4);
  await expect(createTemplateVersion(scope, { ...input, max_body_length: 101 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('keeps manifest definitions immutable and requires a successful input preview before allowing a derived version', async () => {
  const version = await derived(2);
  await expect(query("UPDATE kff.template_versions SET name='Changed',policy_version=policy_version+1 WHERE id=$1", [version.id])).rejects.toThrow('IMMUTABLE_TEMPLATE_DEFINITION');
  await expect(policy(version, 'ALLOW')).rejects.toMatchObject({ code: 'TEMPLATE_PREVIEW_REQUIRED' });
  const invalid = await previewTemplate(scope, version.id, previewInput('Too long'));
  expect(invalid.can_enable).toBe(false); expect(invalid.result.checks.find(check => check.code === 'input')?.state).toBe('FAIL');
  await expect(policy(version, 'ALLOW')).rejects.toMatchObject({ code: 'TEMPLATE_PREVIEW_REQUIRED' });
  await previewTemplate(scope, version.id, previewInput('OK'));
  expect((await policy(version, 'ALLOW')).state).toBe('ALLOWED');
});
it('previews without external calls, tasks, commands or approval and preserves an immutable preview record', async () => {
  const version = await derived(); const input = previewInput();
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No preview network allowed'));
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => previewTemplate(scope, version.id, input)));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results[0].result).toMatchObject({ execution_authorized: false, external_calls: 0 });
    expect(results[0].result.checks.filter(check => check.state === 'NOT_CHECKED')).toHaveLength(2);
    expect(transport).not.toHaveBeenCalled();
    expect((await query('SELECT count(*)::int AS count FROM kff.actions'))[0].count).toBe(0);
    expect((await query('SELECT count(*)::int AS count FROM kff.agent_commands'))[0].count).toBe(0);
    await expect(query("UPDATE kff.template_previews SET can_enable=false WHERE id=$1", [input.request_id])).rejects.toThrow('IMMUTABLE_TEMPLATE_RECORD');
    await expect(previewTemplate(scope, version.id, { ...input, body: 'Changed preview' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally { transport.mockRestore(); }
});
it('keeps approved snapshots pinned while later tasks can choose a new allowed version', async () => {
  const old = await createTask(scope, taskInput()); const oldHash = old.snapshot_hash;
  await approveTask(scope, old.id, { snapshot_hash: oldHash, decision: 'APPROVED' });
  const version = await enabled(); const latest = await createTask(scope, taskInput());
  expect(latest.snapshot.template?.version_id).toBe(version.id);
  const stored = (await query('SELECT snapshot_hash,snapshot FROM kff.tasks WHERE id=$1', [old.id]))[0];
  expect(stored.snapshot_hash).toBe(oldHash); expect(stored.snapshot.template.version_number).toBe(1);
  expect((await createTask(scope, taskInput(old.snapshot.template!.version_id))).snapshot.template?.version_number).toBe(1);
});
it('returns an original creation request even when its default template selection later changes', async () => {
  const input = taskInput(); const first = await createTask(scope, input); await enabled();
  expect((await createTask(scope, input)).id).toBe(first.id);
  expect((await createTask(scope, input)).snapshot.template?.version_id).toBe(first.snapshot.template?.version_id);
});
it('enforces a selected version input bound on task creation', async () => {
  const version = await enabled(2);
  await expect(createTask(scope, taskInput(version.id, 'Three'))).rejects.toMatchObject({ code: 'TEMPLATE_INPUT_INVALID' });
  expect((await createTask(scope, taskInput(version.id, 'OK'))).snapshot.template?.manifest.input.max_body_length).toBe(2);
});
it('blocks queueing an approved task after its version is disabled and reflects that in workspace eligibility', async () => {
  const version = await enabled(); const task = await createTask(scope, taskInput(version.id));
  await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' });
  await policy(version, 'DISABLE');
  await expect(enqueueTask(scope, task.id)).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' });
  expect((await workspace(scope)).eligibility[task.id]).toMatchObject({ allowed: false, reason_code: 'TEMPLATE_UNAVAILABLE' });
});
it('blocks a queued action after deprecation without making an execution attempt', async () => {
  const version = await enabled(); const value = await queued(version.id); await policy(version, 'DEPRECATE');
  expect(await dispatchOne()).toBe(true); const detail = await runDetail(scope, value.run.id);
  expect(detail.run).toMatchObject({ action_state: 'BLOCKED', error_code: 'TEMPLATE_UNAVAILABLE' }); expect(detail.attempts).toHaveLength(0);
});
it('rechecks version policy at the final write gate after the command was claimed', async () => {
  const version = await enabled(); const value = await claimed(version.id); await policy(version, 'DISABLE');
  await expect(beginSubmission(agent, value.command.id)).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' });
  expect((await runDetail(scope, value.run.id)).attempts[0].submitted_at).toBeNull();
});
it('serializes a final submission against a concurrent version stop without losing either record', async () => {
  const version = await enabled(); const value = await claimed(version.id);
  const results = await Promise.allSettled([policy(version, 'DISABLE'), beginSubmission(agent, value.command.id)]);
  expect(results[0].status).toBe('fulfilled');
  const state = (await runDetail(scope, value.run.id)).run.action_state;
  if (results[1].status === 'fulfilled') expect(state).toBe('SUBMITTING');
  else { expect(results[1].reason).toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' }); expect(state).toBe('PREPARING'); }
  expect((await templateWorkspace(scope)).versions.find(row => row.id === version.id)?.state).toBe('DISABLED');
});
it('allows the original result report and reconciliation after its version is deprecated', async () => {
  const version = await enabled(); const value = await claimed(version.id); await beginSubmission(agent, value.command.id);
  await policy(version, 'DEPRECATE');
  await acceptReport(agent, { event_id: randomUUID(), command_id: value.command.id, outcome: 'UNKNOWN_OUTCOME', diagnostic: { step: 'synthetic-deprecated-result' } });
  const snapshot = value.task.snapshot;
  const result = await reconcileSynthetic(scope, value.run.id, async () => [{ id: 'synthetic_' + randomUUID(), action_id: value.command.action_id, account_id: snapshot.external_account_id, body: snapshot.body, content_hash: snapshot.content_hash, created_at: new Date().toISOString() }]);
  expect(result.reconciled).toBe(true);
  await recordQuiescence(agent, value.command.id, { protocol_version: 'kff.guardian-closure.v1', command_id: value.command.id, action_id: value.command.action_id, closed_at: new Date().toISOString(), proof_sha256: 'b'.repeat(64) });
  await releaseQuarantine(scope, value.run.id);
  expect((await runDetail(scope, value.run.id)).attempts).toHaveLength(1);
});
it('deduplicates policy changes and refuses to reactivate a permanently deprecated version', async () => {
  const version = await enabled(); const input = { request_id: randomUUID(), expected_policy_version: version.policy_version, action: 'DEPRECATE' as const, reason: 'Synthetic permanent deprecation' };
  const records = await Promise.all(Array.from({ length: 5 }, () => setTemplatePolicy(scope, version.id, input)));
  expect(new Set(records.map(row => row.policy_version)).size).toBe(1);
  await expect(setTemplatePolicy(scope, version.id, { ...input, reason: 'Changed repeated reason' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(policy(records[0], 'ALLOW')).rejects.toMatchObject({ code: 'TEMPLATE_DEPRECATED' });
  await scoped(scope, client => ensureBundledTemplates(client, scope));
  expect((await templateWorkspace(scope)).versions.find(row => row.id === version.id)?.state).toBe('DEPRECATED');
});
it('separates template scopes and refuses wrong action bindings or viewer changes', async () => {
  const version = await derived(); const input = previewInput();
  const wrong = await previewTemplate(scope, version.id, { ...input, capability_id: localIds.read });
  expect(wrong.can_enable).toBe(false); expect(wrong.result.checks.find(check => check.code === 'bindings')?.state).toBe('FAIL');
  await expect(previewTemplate({ ...scope, role: 'viewer' }, version.id, previewInput())).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  await expect(setTemplatePolicy({ ...scope, role: 'operator' }, version.id, { request_id: randomUUID(), expected_policy_version: 1, action: 'ALLOW', reason: 'Operator cannot enable' })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
  const foreign = { ...scope, brand_id: randomUUID() };
  expect((await templateWorkspace(foreign)).versions).toEqual([]);
  await expect(previewTemplate(foreign, version.id, previewInput())).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
