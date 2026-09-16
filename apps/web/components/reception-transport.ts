import type { BrowserConfiguration } from '../../../packages/contracts/src/environment';

/**
 * Which reception transports the *currently selected* environment can actually run.
 *
 * This mirrors the server rules in `packages/core/src/facebook-inbound.ts`, which refuses
 * `SOURCE_NOT_CONFIGURED` for a BROWSER transport unless the selected environment is a `native`
 * driver on a synthetic account, or an `adspower` driver on a real personal account.
 *
 * The refusal is about the BROWSER transport alone. A synthetic account still configures its
 * reception over the platform interface — that is the transport its connection is created with —
 * so an unconfigured synthetic environment loses the browser option, not the whole form. Withholding
 * the form instead left the operator with no way to configure reception at all, and the account
 * looked as though it had no reception settings rather than one unavailable channel.
 */
export type ReceptionAccount = { platform: string; account_type: string; is_synthetic: boolean };
export type ReceptionTransport = 'BROWSER' | 'API';
/** Only the driver matters here, so the caller does not need a complete environment row. */
export type EnvironmentDriverSource = { browser_configuration?: Pick<BrowserConfiguration, 'driver'> | null };
export type TransportResolution =
  | { supported: true; transports: ReceptionTransport[]; default_transport: ReceptionTransport; driver: string | null }
  | { supported: false; reason: string };

/**
 * The one rule deciding whether this account and driver may read conversations in a browser. Both
 * the browser option and the test that verifies this module against the server read it here, so the
 * entry cannot drift from the refusal it depends on.
 */
export function browserReceptionAccepted(account: { account_type: string; is_synthetic: boolean }, driver: string | null): boolean {
  return account.is_synthetic ? driver === 'native' : account.account_type === 'profile' && driver === 'adspower';
}
/**
 * The platform interface is the transport a page's connection is created with. The server inserts
 * that capability for any page through a bound environment and only ever reads the driver for a
 * BROWSER transport, so the driver decides whether the browser channel is available, never whether
 * the interface is.
 */
export function apiReceptionAccepted(account: { account_type: string; is_synthetic: boolean }, driver: string | null): boolean {
  void driver;
  return account.is_synthetic || account.account_type !== 'profile';
}

export function resolveReceptionTransport(account: ReceptionAccount, environment: EnvironmentDriverSource | undefined): TransportResolution {
  // Every account is resolved through a bound environment, and the driver is what the server reads.
  if (!environment) return { supported: false, reason: '此账号还没有绑定执行环境，请先到环境中心创建。' };
  const driver = environment.browser_configuration?.driver ?? null;
  const browser = browserReceptionAccepted(account, driver), api = apiReceptionAccepted(account, driver);
  const transports: ReceptionTransport[] = [...(browser ? ['BROWSER' as const] : []), ...(api ? ['API' as const] : [])];
  if (!transports.length) return { supported: false, reason: unavailableReason(account, driver) };
  return { supported: true, transports, default_transport: transports[0], driver };
}
function unavailableReason(account: ReceptionAccount, driver: string | null): string {
  const observed = '当前选中的环境驱动为 ' + (driver ?? '未配置');
  if (account.is_synthetic) return '本地合成账号的浏览器接待需要 native 驱动的环境；' + observed + '，无法接收合成私信。';
  if (account.account_type === 'profile') return '真实个人账号的浏览器接待需要 AdsPower 环境；' + observed + '。';
  return '主页账号的官方接口需要一个 native（逻辑）环境；' + observed + '。';
}
