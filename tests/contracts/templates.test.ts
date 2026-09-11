import { expect, it } from 'vitest';
import { fixtureCommand } from '../helpers/commands';
import { digest } from '../../packages/core/src/index';
import { templateManifestSchema, taskSnapshotSchema } from '../../packages/contracts/src/index';
import { assertTemplateSnapshot, fixedPageManifest } from '../../packages/adapters/src/templates';
import { FacebookPageAdapter } from '../../packages/adapters/src/facebook';

it('rejects an arbitrary workflow or changed steps outside the installed fixed template engine', () => {
  const manifest = fixedPageManifest('facebook.page.publish.api');
  expect(templateManifestSchema.safeParse({ ...manifest, script: 'untrusted' }).success).toBe(false);
  expect(templateManifestSchema.safeParse({ ...manifest, steps: ['validate_input', 'submit_once'] }).success).toBe(false);
  expect(templateManifestSchema.safeParse({ ...manifest, automatic_write_retry: true }).success).toBe(false);
});
it('preserves legacy snapshots for historical records but prevents launching them as new work', () => {
  const command = fixtureCommand(); const legacy = { ...command.snapshot }; delete legacy.template;
  expect(taskSnapshotSchema.safeParse(legacy).success).toBe(true);
  expect(() => assertTemplateSnapshot(legacy)).toThrow('历史任务缺少模板版本快照');
  const corrupted = { ...command.snapshot, template: { ...command.snapshot.template!, manifest_hash: '0'.repeat(64) } };
  expect(() => assertTemplateSnapshot(corrupted)).toThrow('模板摘要、动作或执行器版本不一致');
});
it('enforces a pinned input bound in the Facebook execution process before any external request', async () => {
  const command = fixtureCommand({ capability_key: 'facebook.page.publish.api', adapter_version: 'facebook-graph-v1', is_synthetic: false, mode: 'CONTROLLED_PILOT' });
  const manifest = fixedPageManifest(command.snapshot.capability_key, 2);
  command.snapshot.template = { ...command.snapshot.template!, manifest, manifest_hash: digest(manifest) };
  let requests = 0; const adapter = new FacebookPageAdapter({ version: 'v99.0', pageToken: 'synthetic-token', fetch: async () => { requests++; throw new Error('Unexpected request'); } });
  await expect(adapter.execute(command.snapshot, async () => { throw new Error('Unexpected write gate'); })).rejects.toMatchObject({ code: 'TEMPLATE_INPUT_INVALID' });
  expect(requests).toBe(0);
});
