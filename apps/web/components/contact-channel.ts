import type { ContactChannel } from '@kff/contracts';

/**
 * The channel a contact target may be registered on, derived from the account itself.
 *
 * This mirrors the server rule in `packages/core/src/contacts.ts:createContactTarget`:
 *  - a synthetic account registers a `synthetic` target;
 *  - a real Facebook account registers a `facebook_messenger` target with a numeric remote id;
 *  - a `site` account registers a `site_chat` target.
 * The previous form only decided between `synthetic` and `facebook_messenger`, so a site account
 * or an Instagram account was always submitted as a Facebook target and the server refused it with
 * FORBIDDEN_SCOPE. Instagram has no contact channel at all, so the entry is unavailable rather
 * than being given an invented one.
 */
export type ContactChannelAccount = { platform: string; is_synthetic: boolean };
export type ContactChannelResolution =
  | { supported: true; channel: ContactChannel; remote_id_pattern: string; remote_id_hint: string }
  | { supported: false; reason: string };

export function resolveContactChannel(account: ContactChannelAccount): ContactChannelResolution {
  if (account.is_synthetic) return {
    supported: true, channel: 'synthetic',
    remote_id_pattern: '[A-Za-z0-9_:+.@\\-]{1,160}',
    remote_id_hint: '本地合成账号使用稳定标识，可与平台数字 ID 不同。',
  };
  if (account.platform === 'facebook') return {
    supported: true, channel: 'facebook_messenger',
    remote_id_pattern: '[0-9]{1,128}',
    remote_id_hint: '填写对方主页的数字 ID；Facebook 联系目标只接受数字标识。',
  };
  if (account.platform === 'site') return {
    supported: true, channel: 'site_chat',
    remote_id_pattern: '[0-9]{1,128}',
    remote_id_hint: '站内渠道使用站内会话标识；此账号没有浏览器检查与平台自动化。',
  };
  return {
    supported: false,
    reason: account.platform === 'instagram'
      ? 'Instagram 联系渠道尚未开放，无法在此登记联系目标。'
      : '当前账号平台没有可用的联系渠道。',
  };
}
