import { it, expect } from 'vitest';
import { apiReceptionAccepted, browserReceptionAccepted, resolveReceptionTransport } from '../../apps/web/components/reception-transport';

// Mirrors packages/core/src/facebook-inbound.ts: a BROWSER transport needs a native driver on a
// synthetic account, or an adspower driver on a real personal account. The refusal is about the
// BROWSER transport only; the platform interface stays available for anything that is not a personal
// account, driven through a logical (native) environment. Anything else is refused with
// SOURCE_NOT_CONFIGURED.
const serverAcceptsBrowser = (account: { account_type: string; is_synthetic: boolean }, driver: string | null) =>
  account.is_synthetic ? driver === 'native' : account.account_type === 'profile' && driver === 'adspower';
/** Any page keeps the interface through its bound environment; only the browser channel reads the driver. */
const serverAcceptsApi = (account: { account_type: string; is_synthetic: boolean }, _driver: string | null) =>
  account.is_synthetic || account.account_type !== 'profile';

const synthetic = { platform: 'facebook', account_type: 'page', is_synthetic: true };
const realProfile = { platform: 'facebook', account_type: 'profile', is_synthetic: false };
const realPage = { platform: 'facebook', account_type: 'page', is_synthetic: false };
const env = (driver: string | null) => ({ browser_configuration: driver ? { driver: driver as 'native' | 'adspower' } : null });

it('offers only the transports the selected environment can run', () => {
  for (const [account, driver] of [[synthetic, 'native'], [realProfile, 'adspower'], [realPage, 'native']] as const) {
    const resolved = resolveReceptionTransport(account, env(driver));
    expect(resolved.supported).toBe(true);
    if (!resolved.supported) continue;
    // Every offered transport must be one the server accepts for this account and driver.
    for (const transport of resolved.transports) {
      if (transport === 'BROWSER') expect(serverAcceptsBrowser(account, driver), account.account_type + '/' + driver).toBe(true);
      if (transport === 'API') expect(serverAcceptsApi(account, driver), account.account_type + '/' + driver).toBe(true);
    }
    expect(resolved.transports).toContain(resolved.default_transport);
    expect(resolved.driver).toBe(driver);
    // The module's own predicates are the shared rule, so they must agree with the server mirror.
    expect(browserReceptionAccepted(account, driver)).toBe(serverAcceptsBrowser(account, driver));
    expect(apiReceptionAccepted(account, driver)).toBe(serverAcceptsApi(account, driver));
  }
  // A mismatched browser pair is refused rather than silently offered, but the account still has the
  // platform interface it can configure reception over. Hiding the whole form instead left an
  // account created without browser configuration with no reception settings at all. A real page has
  // no browser channel to fall back on, so for it the mismatch really is nothing available.
  for (const [account, driver] of [[synthetic, 'adspower'], [realPage, 'adspower']] as const) {
    const resolved = resolveReceptionTransport(account, env(driver));
    expect(resolved.supported, account.account_type + '/' + driver).toBe(true);
    if (!resolved.supported) continue;
    expect(resolved.transports, account.account_type + '/' + driver).not.toContain('BROWSER');
  }
  // A personal account has no platform interface to fall back on, so the mismatch is nothing
  // available rather than a narrower list.
  const profileWithoutAdsPower = resolveReceptionTransport(realProfile, env('native'));
  expect(profileWithoutAdsPower.supported).toBe(false);
  if (!profileWithoutAdsPower.supported) expect(profileWithoutAdsPower.reason).toContain('AdsPower');
  // A synthetic account with no configured environment keeps the platform interface and loses only
  // the browser channel.
  const unconfiguredSynthetic = resolveReceptionTransport(synthetic, env(null));
  expect(unconfiguredSynthetic).toMatchObject({ supported: true, transports: ['API'], default_transport: 'API', driver: null });
});

// The defect: the form offered BROWSER whenever the account had *any* native environment, even with
// a different environment selected. A synthetic account bound to an adspower environment is the
// clearest case: the server refuses it, but the old rule still showed the option.
it('never offers a transport the selected environment cannot run', () => {
  // A synthetic account on an adspower environment: the browser channel is gone, the platform
  // interface remains, and the module agrees with the server about which one was refused.
  const syntheticOnAdspower = resolveReceptionTransport(synthetic, env('adspower'));
  expect(syntheticOnAdspower.supported).toBe(true);
  if (syntheticOnAdspower.supported) expect(syntheticOnAdspower.transports).toEqual(['API']);
  expect(browserReceptionAccepted(synthetic, 'adspower')).toBe(false);
  // The old rule looked at other environments, not the selected one, so it disagreed with this.
  const realProfileOnNative = resolveReceptionTransport(realProfile, env('native'));
  expect(realProfileOnNative.supported).toBe(false);
  if (!realProfileOnNative.supported) expect(realProfileOnNative.reason).toContain('AdsPower');
  expect(browserReceptionAccepted(realProfile, 'native')).toBe(false);
});

// A real page keeps the platform interface through whatever environment is bound to it, and an
// account with no environment is blocked by the form itself with an explanation rather than by a
// server refusal after submitting.
it('keeps the platform interface for a real page and blocks an unbound account', () => {
  const page = resolveReceptionTransport(realPage, env('native'));
  expect(page).toMatchObject({ supported: true, transports: ['API'], default_transport: 'API' });
  // The interface does not read the driver, so a page stays configurable on either environment —
  // it simply has no browser channel, which is what the personal-account path is for.
  for (const driver of ['adspower', null] as const) {
    expect(resolveReceptionTransport(realPage, env(driver))).toMatchObject({ supported: true, transports: ['API'], driver });
  }
  // A personal account is the case with nothing available: no interface, and a browser channel that
  // only AdsPower can run.
  expect(resolveReceptionTransport(realProfile, env('native')).supported).toBe(false);
  for (const account of [synthetic, realProfile, realPage]) {
    const none = resolveReceptionTransport(account, undefined);
    expect(none.supported).toBe(false);
    if (!none.supported) expect(none.reason).toContain('环境');
  }
});
