import { describe, expect, it } from 'vitest';
import { FacebookPageAdapter } from '../../packages/adapters/src/facebook';
import { fixtureCommand } from '../helpers/commands';
import { AppError } from '../../packages/core/src/index';

const snapshot = fixtureCommand({ capability_key: 'facebook.page.publish.api', adapter_version: 'facebook-graph-v1', mode: 'CONTROLLED_PILOT', is_synthetic: false, credential_ref: 'FACEBOOK_CONTRACT_TEST_TOKEN' }).snapshot;
const pageId = snapshot.external_account_id;
const remoteId = pageId + '_12345';
const post = { id: remoteId, from: { id: pageId }, message: snapshot.body, permalink_url: 'https://www.facebook.com/' + remoteId, is_published: true };
function transport(responses: (unknown | Error)[]) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const mock: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    const value = responses[calls.length - 1];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('UNMATCHED_REQUEST');
    return Response.json(value);
  };
  return { adapter: new FacebookPageAdapter({ version: 'v99.0', pageToken: 'synthetic-contract-credential', fetch: mock }), calls };
}
describe('Facebook Graph adapter contract only; no platform calls', () => {
  it('preflights identity, submits once, and verifies the actual published author and content', async () => {
    const { adapter, calls } = transport([{ id: pageId, name: 'Contract page' }, { id: remoteId }, post]);
    let intents = 0; const receipt = await adapter.execute(snapshot, async () => { intents++; });
    expect(intents).toBe(1); expect('content_hash' in receipt && receipt.content_hash).toBe(snapshot.content_hash);
    expect(calls.map(call => call.init?.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[0].url.pathname).toBe('/v99.0/me');
    expect(calls[1].url.pathname).toBe('/v99.0/' + pageId + '/feed');
    expect(calls[1].init?.body?.toString()).toContain('message=');
    expect(calls.every(call => call.url.hostname === 'graph.facebook.com' && !call.url.searchParams.has('access_token') && call.init?.redirect === 'error')).toBe(true);
  });
  it('blocks the write when account identity differs', async () => {
    const { adapter, calls } = transport([{ id: '999', name: 'Wrong page' }]);
    await expect(adapter.execute(snapshot, async () => { throw new Error('Must not submit'); })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect(calls.length).toBe(1);
  });
  it('does not POST after the final permission gate rejects', async () => {
    const { adapter, calls } = transport([{ id: pageId, name: 'Contract page' }]);
    await expect(adapter.execute(snapshot, async () => { throw new Error('STOP_REQUESTED'); })).rejects.toThrow('STOP_REQUESTED');
    expect(calls.length).toBe(1);
  });
  it.each([false, undefined])('does not label accepted or unconfirmed publication as verified (%s)', async published => {
    const { adapter } = transport([{ ...post, is_published: published }]);
    await expect(adapter.verifyOutcome(snapshot, remoteId)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  });
  it.each([{ ...post, from: { id: '999' } }, { ...post, message: 'Different content' }, { ...post, id: pageId + '_888' }])('rejects mismatched remote evidence %#', async result => {
    await expect(transport([result]).adapter.verifyOutcome(snapshot, remoteId)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  });
  it('never retries a POST on a dropped response', async () => {
    const { adapter, calls } = transport([{ id: pageId, name: 'Contract page' }, new Error('Connection lost after accept')]);
    await expect(adapter.execute(snapshot, async () => {})).rejects.toThrow('Connection lost');
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });
  it('maps revocation without leaking the provider error or credential', async () => {
    const { adapter } = transport([{ error: { code: 190, message: 'SENSITIVE_PROVIDER_VALUE' } }]);
    await expect(adapter.preflight(snapshot)).rejects.toMatchObject({ code: 'AUTH_EXPIRED', message: '平台拒绝操作或当前响应无法核验' });
  });
  it('reads without entering the write gate', async () => {
    const { adapter, calls } = transport([{ id: pageId, name: 'Contract page' }]);
    const receipt = await adapter.execute({ ...snapshot, capability_key: 'facebook.page.read.api' }, async () => { throw new Error('Unexpected write'); });
    expect(receipt.remote_id).toBe(pageId); expect(calls.length).toBe(1);
  });
  it('rejects the POST if guardian control is lost immediately after the final gate', async () => {
    let controlled = true; const calls: string[] = [];
    const adapter = new FacebookPageAdapter({ version: 'v99.0', pageToken: 'synthetic-credential', assertControlled: () => { if (!controlled) throw new AppError('STOP_REQUESTED', 'Test control loss'); }, fetch: async (_url, init) => { calls.push(init!.method!); return Response.json({ id: pageId, name: 'Synthetic page' }); } });
    await expect(adapter.execute(snapshot, async () => { controlled = false; })).rejects.toMatchObject({ code: 'STOP_REQUESTED' });
    expect(calls).toEqual(['GET']);
  });
});
