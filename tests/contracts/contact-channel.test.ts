import { it, expect } from 'vitest';
import { contactChannel, contactTargetInput } from '../../packages/contracts/src/contact';
import { resolveContactChannel } from '../../apps/web/components/contact-channel';

// The server rule this must mirror, copied from packages/core/src/contacts.ts as the comparator:
// a request is accepted only when the channel matches the account's platform and shape.
const serverAccepts = (account: { platform: string; is_synthetic: boolean }, channel: string, remoteId: string) =>
  (channel === 'synthetic' && account.is_synthetic)
  || (channel === 'facebook_messenger' && account.platform === 'facebook' && /^[0-9]{1,128}$/.test(remoteId))
  || (channel === 'site_chat' && account.platform === 'site');
/** What the form used to submit for every real account, whatever its platform. */
const previousRule = (account: { platform: string; is_synthetic: boolean }) => account.is_synthetic ? 'synthetic' : 'facebook_messenger';

const synthetic = { platform: 'kff', is_synthetic: true };
const facebook = { platform: 'facebook', is_synthetic: false };
const site = { platform: 'site', is_synthetic: false };
const instagram = { platform: 'instagram', is_synthetic: false };

it('derives the channel the server will accept for each account type', () => {
  expect(resolveContactChannel(synthetic)).toMatchObject({ supported: true, channel: 'synthetic' });
  expect(resolveContactChannel(facebook)).toMatchObject({ supported: true, channel: 'facebook_messenger' });
  // A site account is the case the old form got wrong: it was submitted as a Facebook target and
  // the server refused it with FORBIDDEN_SCOPE.
  expect(resolveContactChannel(site)).toMatchObject({ supported: true, channel: 'site_chat' });
  expect(previousRule(site)).toBe('facebook_messenger');
  for (const account of [synthetic, facebook, site]) {
    const resolved = resolveContactChannel(account);
    expect(resolved.supported).toBe(true);
    if (resolved.supported) {
      // The derived channel must satisfy the server rule for a remote id the form itself allows.
      const remoteId = account.is_synthetic ? 'synthetic.peer-1' : '1234567890';
      expect(serverAccepts(account, resolved.channel, remoteId), account.platform).toBe(true);
      // And the old rule must fail for the site account, which is the defect being closed.
      if (account.platform === 'site') expect(serverAccepts(account, previousRule(account), remoteId)).toBe(false);
      expect(new RegExp('^' + resolved.remote_id_pattern + '$').test(remoteId), account.platform + ' pattern').toBe(true);
      expect(contactChannel.safeParse(resolved.channel).success).toBe(true);
      expect(contactTargetInput.safeParse({ account_id: '6a14ca96-4988-4aa2-a0c7-686fc01c15eb', channel: resolved.channel, remote_id: remoteId }).success).toBe(true);
    }
  }
});

// Instagram has no contact channel at all, so the entry is unavailable instead of being given an
// invented one, and an unknown platform is refused rather than defaulted to Facebook.
it('disables platforms that have no contact channel without inventing one', () => {
  const ig = resolveContactChannel(instagram);
  expect(ig.supported).toBe(false);
  if (!ig.supported) expect(ig.reason).toContain('Instagram');
  expect(previousRule(instagram)).toBe('facebook_messenger');
  expect(serverAccepts(instagram, previousRule(instagram), '1234567890')).toBe(false);
  const unknown = resolveContactChannel({ platform: 'tiktok', is_synthetic: false });
  expect(unknown.supported).toBe(false);
  if (!unknown.supported) expect(unknown.reason).toContain('没有可用的联系渠道');
});

// A synthetic account is never offered a Facebook channel and vice versa: the shape of the remote
// id follows the channel, so the form cannot send an identifier the server will reject.
it('keeps the remote id shape consistent with the derived channel', () => {
  const syntheticId = resolveContactChannel(synthetic);
  const facebookId = resolveContactChannel(facebook);
  if (syntheticId.supported) {
    expect(new RegExp('^' + syntheticId.remote_id_pattern + '$').test('1234567890')).toBe(true);
    // A synthetic account may use a non-numeric stable id; a Facebook one may not.
    expect(new RegExp('^' + syntheticId.remote_id_pattern + '$').test('synthetic.peer-1')).toBe(true);
  }
  if (facebookId.supported) {
    expect(new RegExp('^' + facebookId.remote_id_pattern + '$').test('synthetic.peer-1')).toBe(false);
    expect(new RegExp('^' + facebookId.remote_id_pattern + '$').test('1234567890')).toBe(true);
  }
});
