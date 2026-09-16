import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { openManagedBrowser } from '../../../packages/adapters/src/browser-profile';
import type { BrowserEnvironmentSnapshot, EnvironmentCommand, EnvironmentResult } from '../../../packages/contracts/src/environment';
import { environmentRunner } from '../../../apps/agent/src/environment-runner';
import { digest } from '../../../packages/core/src/index';

function snapshot(): BrowserEnvironmentSnapshot {
  return { environment_id: randomUUID(), account_id: randomUUID(), agent_id: randomUUID(), organization_id: randomUUID(), brand_id: randomUUID(), profile_key: randomUUID(), configuration_version: 1, platform: 'facebook', is_synthetic: true, configuration: { driver: 'native', provider_profile_id: null, login_account_id: '11', operating_identity_id: '22', locale: 'en-US', timezone_id: 'America/New_York', proxy_ref: null } };
}
function directories() { const root = path.resolve('.kff/browser-environment-tests', randomUUID()); mkdirSync(root, { recursive: true }); return { root, runtime: path.join(root, 'runtime'), profiles: path.join(root, 'profiles') }; }
test('two native profiles persist independent cookies and local storage after browser restarts', async () => {
  const { profiles } = directories(); const first = snapshot(); const second = snapshot();
  for (const [binding, text] of [[first, 'first-account'], [second, 'second-account']] as const) {
    const session = await openManagedBrowser(profiles, binding, true, {});
    try {
      await session.context.route('http://profile-fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Profile persistence fixture</title>' }));
      const page = await session.context.newPage(); await page.goto('http://profile-fixture.test');
      await page.evaluate(value => localStorage.setItem('owner', value), text);
      await session.context.addCookies([{ name: 'owner', value: text, domain: 'profile-fixture.test', path: '/', expires: Date.now() / 1000 + 3600 }]);
      await expect(openManagedBrowser(profiles, binding, true, {})).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    } finally { await session.close(); }
  }
  for (const [binding, text] of [[first, 'first-account'], [second, 'second-account']] as const) {
    const session = await openManagedBrowser(profiles, binding, true, {});
    try {
      await session.context.route('http://profile-fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Reopened</title>' }));
      const page = await session.context.newPage(); await page.goto('http://profile-fixture.test');
      expect(await page.evaluate(() => localStorage.getItem('owner'))).toBe(text);
      expect((await session.context.cookies()).find(cookie => cookie.name === 'owner')?.value).toBe(text);
    } finally { await session.close(); }
  }
});
test('rejects a changed persistent identity and missing proxy instead of opening another session', async () => {
  const { profiles } = directories(); const binding = snapshot();
  const session = await openManagedBrowser(profiles, binding, true, {}); await session.close();
  await expect(openManagedBrowser(profiles, { ...binding, brand_id: randomUUID() }, true, {})).rejects.toMatchObject({ code: 'PROFILE_IDENTITY_MISMATCH' });
  await expect(openManagedBrowser(profiles, { ...snapshot(), configuration: { ...binding.configuration, proxy_ref: 'KFF_BROWSER_PROXY_MISSING' } }, true, {})).rejects.toMatchObject({ code: 'PROXY_UNCONFIGURED' });
});
test('the actual environment guardian checks browser configuration and replays only closure after a lost reply', async () => {
  const { runtime, profiles } = directories(); const binding = snapshot();
  const command: EnvironmentCommand = { protocol_version: 'kff.environment.v1', id: randomUUID(), operation: 'CHECK', snapshot: binding, snapshot_hash: digest(binding), expires_at: new Date(Date.now() + 60000).toISOString() };
  const reports: EnvironmentResult[] = []; let drop = true;
  const api = async <T,>(endpoint: string, body?: unknown): Promise<T> => {
    if (endpoint.endsWith('/result')) { reports.push(body as EnvironmentResult); if (drop) { drop = false; throw new Error('Fixture lost response'); } return { accepted: true } as T; }
    return { continue: true } as T;
  };
  const identity = { agent_id: binding.agent_id, organization_id: binding.organization_id, brand_id: binding.brand_id };
  const runner = environmentRunner(runtime, profiles, identity, api);
  await expect(runner.run(command, new AbortController().signal)).rejects.toThrow('Fixture lost response');
  const restarted = environmentRunner(runtime, profiles, identity, api);
  expect(await restarted.flush()).toBe(true); expect(reports).toHaveLength(2); expect(reports[1]).toEqual(reports[0]);
  expect(reports[0]).toMatchObject({ context_closed: true, outcome: 'CHECKED' });
  await expect(restarted.run(command, new AbortController().signal)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
  const stored = readFileSync(path.join(runtime, 'agent/environment-journal.json'), 'utf8'); expect(stored).not.toContain('Cookie');
  const reopened = await openManagedBrowser(profiles, binding, true, {}); await reopened.close();
});
test('retains a provider lock after an ambiguous start even while status is temporarily Inactive', async () => {
  const { profiles } = directories(); const binding = snapshot();
  binding.configuration = { ...binding.configuration, driver: 'adspower', provider_profile_id: 'ambiguous-fixture' };
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(request.url?.startsWith('/api/v1/browser/start') ? '{lost-response' : JSON.stringify({ code: 0, data: { status: 'Inactive' } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
    const environment = { KFF_ADSPOWER_ORIGIN: 'http://127.0.0.1:' + address.port };
    await expect(openManagedBrowser(profiles, binding, true, environment)).rejects.toMatchObject({ code: 'GUARDIAN_UNCONFIRMED' });
    expect(existsSync(path.join(profiles, 'adspower-ambiguous-fixture/owner.lock'))).toBe(true);
    await expect(openManagedBrowser(profiles, binding, true, environment)).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
