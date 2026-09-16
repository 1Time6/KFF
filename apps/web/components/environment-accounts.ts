/**
 * Which accounts may be bound to a browser environment.
 *
 * `browserEnvironmentSnapshot.platform` accepts `facebook`, `instagram` and `kff`
 * (packages/contracts/src/environment.ts). A `site` account is an in-site channel: it has no
 * browser identity, no profile and no page to verify, so binding it to a browser environment only
 * fails later, when the check tries to build a snapshot it cannot support. The environment entry
 * therefore filters those accounts out and says why, rather than letting the operator retry.
 *
 * A site account's own logical environment, if the in-site business needs one, is a separate
 * concern; this only excludes it from the *browser* entry.
 */
export type EnvironmentAccount = { platform: string; is_synthetic: boolean; display_name: string };
export const BROWSER_ENVIRONMENT_PLATFORMS = ['facebook', 'instagram', 'kff'] as const;
export const SITE_PLATFORM_NOTE = '站内渠道账号没有浏览器身份，无法创建浏览器环境；它在站内执行链中不使用浏览器检查。';

export function supportsBrowserEnvironment(account: Pick<EnvironmentAccount, 'platform'>) {
  return (BROWSER_ENVIRONMENT_PLATFORMS as readonly string[]).includes(account.platform);
}
/** The accounts the browser-environment entry may offer, in the order the server listed them. */
export function browserEnvironmentAccounts<T extends EnvironmentAccount>(accounts: readonly T[]): T[] {
  return accounts.filter(account => supportsBrowserEnvironment(account));
}
/** The accounts that were withheld, so the form can explain the omission instead of hiding it. */
export function withheldEnvironmentAccounts<T extends EnvironmentAccount>(accounts: readonly T[]): T[] {
  return accounts.filter(account => !supportsBrowserEnvironment(account));
}
