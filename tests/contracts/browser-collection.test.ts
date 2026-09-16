import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { discoveryConfig } from '../../packages/contracts/src/acquisition';
import { fixedPageManifest } from '../../packages/adapters/src/templates';
import { templateManifestSchema } from '@kff/contracts';
import { discoveryAdapter } from '../../packages/adapters/src/discovery';
import type { CollectionRead } from '../../packages/adapters/src/collection-fixture';

const input = { platform: 'facebook', strategy: 'COMMENTS', provider: 'LOCAL_BROWSER', keywords: ['help'], target: '', processing_basis: 'Local browser fixture verification', browser: { environment_id: randomUUID(), template: 'fixture-discovery-dom-v1' } };
it('requires an explicit installed template and prevents browser configuration on a data-provider request', () => {
  expect(discoveryConfig.safeParse(input).success).toBe(true);
  expect(discoveryConfig.safeParse({ ...input, browser: undefined }).success).toBe(false);
  expect(discoveryConfig.safeParse({ ...input, provider: 'DATA_PROVIDER' }).success).toBe(false);
  expect(discoveryConfig.safeParse({ ...input, browser: { ...input.browser, template: 'uninstalled-facebook-template' } }).success).toBe(false);
});
it('rejects write steps in the installed browser collection template', () => {
  const manifest = fixedPageManifest('kff.fixture.discovery.read.browser');
  expect(manifest.success_evidence).toBe('collection_page');
  expect(templateManifestSchema.safeParse({ ...manifest, steps: ['validate_input','verify_identity','submit_once'] }).success).toBe(false);
});
it('never falls back to a direct provider or HTTP adapter for a browser collection request', async () => {
  let calls = 0;
  const adapter = discoveryAdapter({ fetch: async () => { calls++; throw new Error('Unexpected provider call'); } });
  await expect(adapter.readPage({ snapshot: { discovery: discoveryConfig.parse(input) } } as CollectionRead)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  expect(calls).toBe(0);
});
