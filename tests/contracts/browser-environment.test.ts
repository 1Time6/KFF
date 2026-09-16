import { afterEach, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { browserConfiguration, environmentResultInput } from '../../packages/contracts/src/environment';
import { AdsPowerClient } from '../../packages/adapters/src/browser-profile';
import { accountInput } from '../../packages/contracts/src/index';
const servers: Server[] = [];
it('keeps personal browser accounts separate from Page and Instagram API accounts', () => {
  const profile = { display_name: 'Profile', external_id: '1122', platform: 'facebook', account_type: 'profile' };
  expect(accountInput.safeParse(profile).success).toBe(true);
  for (const changes of [{ credential_ref: 'FACEBOOK_PAGE_TOKEN' }, { platform: 'instagram' }, { account_type: 'professional' }]) expect(accountInput.safeParse({ ...profile, ...changes }).success).toBe(false);
  expect(accountInput.safeParse({ ...profile, account_type: 'page', credential_ref: 'FACEBOOK_PAGE_TOKEN' }).success).toBe(true);
  expect(accountInput.safeParse({ ...profile, platform: 'instagram', account_type: 'professional' }).success).toBe(true);
});
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return 'http://127.0.0.1:' + address.port;
}
it('only accepts finite provider configuration, valid locale/timezone and credential references', () => {
  const config = { driver: 'adspower', provider_profile_id: 'profile01', login_account_id: '11', operating_identity_id: '22', locale: 'en-US', timezone_id: 'America/New_York', proxy_ref: null };
  expect(browserConfiguration.safeParse(config).success).toBe(true);
  for (const extra of [{ script: 'arbitrary' }, { provider_profile_id: '../daily-browser' }, { proxy_ref: 'secret-password' }, { timezone_id: 'not-a-zone' }, { driver: 'unverified-provider' }, { provider_profile_id: null }]) expect(browserConfiguration.safeParse({ ...config, ...extra }).success).toBe(false);
  expect(environmentResultInput.safeParse({ context_closed: false, outcome: 'CLOSED' }).success).toBe(false);
});
it('uses AdsPower documented v1 paths, profile IDs and bearer authentication; confirms stop with status', async () => {
  const calls: string[] = []; let active = false;
  const origin = await fixture((request, response) => {
    expect(request.headers.authorization).toBe('Bearer fixture-key'); const url = new URL(request.url!, 'http://local');
    expect(url.searchParams.get('user_id')).toBe('profile01'); calls.push(url.pathname);
    if (url.pathname.endsWith('/start')) { expect(url.searchParams.get('headless')).toBe('1'); expect(url.searchParams.get('open_tabs')).toBe('1'); active = true; }
    if (url.pathname.endsWith('/stop')) active = false;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { status: active ? 'Active' : 'Inactive', ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/fixture' } } }));
  });
  const client = new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin, KFF_ADSPOWER_API_KEY: 'fixture-key' });
  expect((await client.status('profile01')).status).toBe('Inactive'); expect(await client.start('profile01', true)).toContain('/devtools/browser/fixture'); await client.stop('profile01');
  expect(calls).toEqual(['/api/v1/browser/active', '/api/v1/browser/start', '/api/v1/browser/active', '/api/v1/browser/stop', '/api/v1/browser/active']);
});
it('rejects remote control endpoints, redirected responses and unconfirmed shutdown', async () => {
  expect(() => new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: 'https://example.com' })).toThrow();
  const origin = await fixture((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { status: 'Active', ws: { puppeteer: 'ws://evil.example/devtools/browser/x' } } })); });
  const client = new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin }); await expect(client.start('profile', false)).rejects.toMatchObject({ code: 'PROVIDER_ENDPOINT_INVALID' });
  await expect(client.stop('profile')).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
  const redirected = await fixture((_request, response) => { response.writeHead(302, { Location: 'https://example.com' }); response.end(); });
  await expect(new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: redirected }).status('profile')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
});
it('looks up serial numbers without exposing profile secrets, and reports provider network failure', async () => {
  let failed = false;
  const origin = await fixture((request, response) => {
    const url = new URL(request.url!, 'http://local');
    expect(url.pathname).toBe('/api/v1/user/list'); expect(url.searchParams.get('serial_number')).toBe('195');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(failed ? { code: -1, msg: 'The server is not working well, please check the network or try again later' } : { code: 0, data: { list: [{ user_id: 'fixture195', serial_number: '195', name: 'Fixture profile', password: 'private fixture value', username: 'private-login', proxy: { password: 'private-proxy' } }] } }));
  });
  const client = new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin });
  expect(await client.listProfiles({ serialNumber: '195' })).toEqual([{ user_id: 'fixture195', serial_number: '195', name: 'Fixture profile' }]);
  failed = true;
  await expect(client.listProfiles({ serialNumber: '195' })).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
});
it('waits for an acknowledged AdsPower stop to become Inactive without issuing another stop', async () => {
  let stopCalls = 0; let observationsAfterStop = 0;
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/closing';
  const origin = await fixture((request, response) => {
    const stopping = request.url?.startsWith('/api/v1/browser/stop');
    if (stopping) stopCalls++;
    else if (stopCalls) observationsAfterStop++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 0, data: { status: observationsAfterStop >= 3 ? 'Inactive' : 'Active', ws: { puppeteer: endpoint } } }));
  });
  await new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin }).stop('profile', endpoint);
  expect(stopCalls).toBe(1); expect(observationsAfterStop).toBe(3);
});
it('retains uncertainty when another browser replaces the closing instance', async () => {
  let stopCalls = 0;
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/owned';
  const origin = await fixture((request, response) => {
    if (request.url?.startsWith('/api/v1/browser/stop')) stopCalls++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 0, data: { status: 'Active', ws: { puppeteer: stopCalls ? 'ws://127.0.0.1:9223/devtools/browser/replacement' : endpoint } } }));
  });
  await expect(new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin }).stop('profile', endpoint)).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
  expect(stopCalls).toBe(1);
});
it('tolerates a throttled status read after stop without interpreting it as closure', async () => {
  let stopped = false; let reads = 0;
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/throttled';
  const origin = await fixture((request, response) => {
    const stop = request.url?.startsWith('/api/v1/browser/stop');
    if (stop) stopped = true;
    if (stopped && !stop) reads++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(reads === 1 ? { code: -1, msg: 'Too many request per second, please check' } : { code: 0, data: { status: reads >= 2 ? 'Inactive' : 'Active', ws: { puppeteer: endpoint } } }));
  });
  await new AdsPowerClient({ KFF_ADSPOWER_ORIGIN: origin }).stop('profile', endpoint);
  expect(reads).toBe(2);
});
it('waits for a slow acknowledged startup without issuing another start', async () => {
  let starts=0;
  const origin=await fixture((request,response)=>{
    if(request.url?.startsWith('/api/v1/browser/start'))starts++;
    setTimeout(()=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({code:0,data:{ws:{puppeteer:'ws://127.0.0.1:9222/devtools/browser/delayed'}}}));},21000);
  });
  expect(await new AdsPowerClient({KFF_ADSPOWER_ORIGIN:origin}).start('profile',false)).toBe('ws://127.0.0.1:9222/devtools/browser/delayed');
  expect(starts).toBe(1);
},30000);
