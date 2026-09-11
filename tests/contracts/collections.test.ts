import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { collectionInput, collectionSnapshotSchema, collectionRecordSchema } from '../../packages/contracts/src/index';
import { syntheticCollectionPage, normalizeCollectionPage } from '../../packages/adapters/src/collection-fixture';

const input = { request_id: randomUUID(), title: 'Synthetic collection', source_key: 'kff.fixture.page.posts', account_id: randomUUID(), targets: ['000123456789012345678901234567890'], fields: ['message','author_id','reaction_count','comment_count','created_time'], purpose: 'software_verification', mode: 'TEST_ONLY', incremental_rule: 'append_observations', max_records: 20, max_pages: 10, page_size: 2, display_timezone: 'Asia/Shanghai', retention_days: 7, scenario: 'normal' };
const { request_id: queryId, ...configuration } = collectionInput.parse(input);
const snapshot = collectionSnapshotSchema.parse({ ...configuration, schema_version: 'kff.collection.v1', source_version: 'fixture-page-posts-v1', source_type: 'OWNED_FIXTURE', external_account_id: input.targets[0], account_version: 1, allowed_purposes: ['software_verification'] });
const request = { query_id: queryId, snapshot, cursor: null, limit: 2 };

it('preserves long and leading-zero identities while refusing a real source or undeclared purpose', () => {
  expect(collectionInput.parse(input).targets[0]).toBe('000123456789012345678901234567890');
  for (const change of [{ source_key: 'facebook.page.posts' }, { purpose: 'marketing' }, { mode: 'PRODUCTION' }, { brand_id: randomUUID() }, { display_timezone: '+08:00' }, { fields: ['message','message'] }]) expect(collectionInput.safeParse({ ...input, ...change }).success).toBe(false);
});
it('distinguishes a returned zero, null, hidden field and a field the source omitted', () => {
  const page = normalizeCollectionPage(syntheticCollectionPage(request), request);
  expect(page.rows[0].fields.reaction_count).toEqual({ kind: 'VALUE', value: 0 });
  expect(page.rows[0].fields.comment_count).toEqual({ kind: 'NOT_RETURNED' });
  expect(page.rows[1].fields.message).toEqual({ kind: 'NULL' });
  expect(page.rows[1].fields.author_id).toEqual({ kind: 'HIDDEN' });
  expect(page.reported_total).toBeNull(); expect(page.coverage).toBe('SYNTHETIC_SAMPLE');
});
it('rejects numeric identities, unsafe counters and extra fields instead of coercing them', () => {
  const original = syntheticCollectionPage(request);
  for (const [key, value] of [['author_id', 9007199254740992], ['reaction_count', -1], ['reaction_count', '0']]) {
    const page = structuredClone(original); page.rows[0].fields[key as 'author_id' | 'reaction_count'] = { kind: 'VALUE', value };
    expect(() => normalizeCollectionPage(page, request)).toThrow();
  }
  expect(collectionRecordSchema.safeParse({ ...original.rows[0], fields: { cookie: { kind: 'VALUE', value: 'not-accepted' } } }).success).toBe(false);
});
it('binds a page to its exact account, query, cursor, source link and allowed field list', () => {
  for (const change of [{ account_external_id: '99999' }, { query_id: randomUUID() }, { cursor: 'offset:2' }]) expect(() => normalizeCollectionPage({ ...syntheticCollectionPage(request), ...change }, request)).toThrow();
  const page = syntheticCollectionPage(request); page.rows[0].source_url = 'http://169.254.169.254/latest/meta-data';
  expect(() => normalizeCollectionPage(page, request)).toThrow();
  const missing = syntheticCollectionPage(request); delete missing.rows[0].fields.message;
  expect(() => normalizeCollectionPage(missing, request)).toThrow();
});
