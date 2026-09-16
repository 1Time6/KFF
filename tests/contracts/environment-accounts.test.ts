import { it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browserEnvironmentSnapshot } from '../../packages/contracts/src/environment';
import { BROWSER_ENVIRONMENT_PLATFORMS, browserEnvironmentAccounts, supportsBrowserEnvironment, withheldEnvironmentAccounts } from '../../apps/web/components/environment-accounts';
import { Field } from '../../apps/web/components/field';

const account = (platform: string, display_name: string, is_synthetic = false) => ({ platform, display_name, is_synthetic });

// The account list travels with its select inside one wrapper. A label that no longer reaches its
// control is a defect no matter how the markup is nested: the choice is what a person reads. The
// entry passed this through a span so it could show which accounts it withheld, and the shared
// field then put the id on the span, so `getByLabel('绑定账号')` matched nothing in the real page.
it('keeps a wrapped control associated with its label', () => {
  const h = createElement;
  // `createElement` takes the children as its remaining arguments, so they are cast to the single
  // `children` prop `Field` declares rather than spread differently at each call site.
  const field = (props: { label: string }, ...children: ReturnType<typeof h>[]) => h(Field, { label: props.label, children });
  const markup = renderToStaticMarkup(field({ label: '绑定账号' },
    h('span', null, h('select', { name: 'account_id' }, h('option', { value: 'a' }, 'A')))));
  const id = /<label for="([^"]+)"/.exec(markup)?.[1];
  expect(id, markup).toBeTruthy();
  // The id belongs to the control itself, and the wrapper is left without one.
  expect(markup).toContain('<select name="account_id" id="' + id + '"');
  expect(markup).toContain('<span><select');
  // A direct control keeps working, and a wrapper holding no control is not given a stray id.
  const direct = renderToStaticMarkup(field({ label: '执行 Agent' }, h('select', { name: 'agent_id' })));
  expect(direct).toMatch(/<label for="([^"]+)">执行 Agent<\/label><select name="agent_id" id="\1"/);
  const note = renderToStaticMarkup(field({ label: '说明' }, h('span', null, '仅文字')));
  expect(note).toContain('<span>仅文字</span>');
});

// The snapshot contract is the authority: whatever the entry offers must be constructible.
const snapshotPlatforms: string[] = ['facebook', 'instagram', 'kff'];
it('offers exactly the platforms a browser snapshot can be built for', () => {
  expect([...BROWSER_ENVIRONMENT_PLATFORMS].sort()).toEqual([...snapshotPlatforms].sort());
  const snapshot = (platform: string) => browserEnvironmentSnapshot.safeParse({
    environment_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15eb', account_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15ec',
    agent_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15ed', organization_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15ee',
    brand_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15ef', profile_key: '6a14ca96-4988-4aa2-a0c7-686fc01c15f0',
    configuration_version: 1, platform, is_synthetic: platform === 'kff',
    configuration: { driver: 'native', provider_profile_id: null, login_account_id: '800001', operating_identity_id: '800002', locale: 'en-US', timezone_id: 'UTC', proxy_ref: null },
  });
  for (const platform of [...snapshotPlatforms, 'site']) {
    // The entry's verdict and the contract's verdict must agree for every platform.
    expect(supportsBrowserEnvironment({ platform }), platform).toBe(snapshot(platform).success);
  }
});

// A site account is the case the old entry allowed: it was offered like any other account, the
// environment was created, and only the later browser check failed.
it('withholds a site account from the browser environment entry', () => {
  const accounts = [account('facebook', 'Facebook page'), account('site', 'In-site channel'), account('instagram', 'Instagram account'), account('kff', 'Local fixture', true)];
  expect(browserEnvironmentAccounts(accounts).map(value => value.display_name)).toEqual(['Facebook page', 'Instagram account', 'Local fixture']);
  expect(withheldEnvironmentAccounts(accounts).map(value => value.display_name)).toEqual(['In-site channel']);
  expect(supportsBrowserEnvironment({ platform: 'site' })).toBe(false);
  // An unknown platform is withheld too, rather than defaulted into a browser binding.
  expect(supportsBrowserEnvironment({ platform: 'tiktok' })).toBe(false);
  expect(browserEnvironmentAccounts([account('tiktok', 'Other')])).toEqual([]);
});

// The offered list must be a strict subset: nothing is added, nothing is reordered.
it('never adds an account and keeps the server order', () => {
  const accounts = [account('site', 'A'), account('kff', 'B', true), account('facebook', 'C'), account('site', 'D')];
  const offered = browserEnvironmentAccounts(accounts);
  expect(offered.map(value => value.display_name)).toEqual(['B', 'C']);
  expect(accounts.length).toBe(offered.length + withheldEnvironmentAccounts(accounts).length);
  expect(offered.every(value => accounts.includes(value))).toBe(true);
});
