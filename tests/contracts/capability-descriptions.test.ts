import { it, expect } from 'vitest';
import { capabilityKey as capabilityKeySchema } from '../../packages/contracts/src/index';
import { CAPABILITY_KEYS, TEMPLATE_STEPS, capabilityChannel, describeCapability, templateStepLabel } from '../../apps/web/components/capability-descriptions';

// The contract is the authority for which capabilities exist. Every key it declares must be
// described here, so a new capability cannot silently fall back to a wrong sentence.
it('describes every capability the contract declares, with nothing extra', () => {
  const declared = capabilityKeySchema.options as string[];
  expect([...CAPABILITY_KEYS].sort()).toEqual([...declared].sort());
  for (const key of declared) {
    const described = describeCapability(key);
    expect(described.known, key).toBe(true);
    expect(described.label.length, key).toBeGreaterThan(3);
    expect(['facebook', 'instagram', 'kff']).toContain(described.platform);
    expect(['browser', 'api']).toContain(described.driver);
    expect(['read', 'write']).toContain(described.kind);
    // Every step a manifest can name must have a label, or the template view renders blank.
    for (const step of described.steps) expect(TEMPLATE_STEPS[step], key + '/' + step).toBeTruthy();
  }
});

// The defect: the old label function ended in a catch-all that called every unmatched capability a
// page identity read, and the channel column called every real capability Graph API.
it('never labels an unmatched capability as a page identity read', () => {
  for (const key of ['facebook.inbox.read.browser', 'facebook.discovery.read.browser', 'instagram.account.read.api', 'kff.fixture.inbox.read.browser']) {
    expect(describeCapability(key).label).not.toBe('主页身份读取');
  }
  expect(describeCapability('facebook.inbox.read.browser').label).toContain('收件');
  expect(describeCapability('facebook.discovery.read.browser').label).toContain('发现');
  expect(describeCapability('instagram.account.read.api').platform).toBe('instagram');
  // Reading capabilities are not writes, and their evidence is a page rather than a publication.
  expect(describeCapability('facebook.inbox.read.browser')).toMatchObject({ kind: 'read', driver: 'browser', evidence: 'inbox_page' });
  expect(describeCapability('facebook.page.publish.api')).toMatchObject({ kind: 'write', driver: 'api', needs_business_context: true });
});

// The channel column used to say "本地浏览器" or "Graph API" for everything.
it('reports the channel each capability really uses, and refuses to guess for unknown keys', () => {
  expect(capabilityChannel('facebook.inbox.read.browser')).toEqual({ platform: 'facebook', driver: 'browser' });
  expect(capabilityChannel('facebook.discovery.read.browser')).toEqual({ platform: 'facebook', driver: 'browser' });
  expect(capabilityChannel('kff.fixture.messenger.reply.browser')).toEqual({ platform: 'kff', driver: 'browser' });
  expect(capabilityChannel('facebook.page.publish.api')).toEqual({ platform: 'facebook', driver: 'api' });
  // An unknown key is not described at all, rather than being defaulted into a platform.
  expect(capabilityChannel('facebook.inbox.read.graph-v9')).toEqual({ platform: '未知平台', driver: '未知通道' });
  expect(describeCapability('facebook.inbox.read.graph-v9').known).toBe(false);
  expect(describeCapability('facebook.inbox.read.graph-v9').label).toContain('未知能力');
  expect(describeCapability(undefined).label).toBe('未知能力');
  expect(describeCapability(null).known).toBe(false);
});

// The template step dictionary was missing read_page, so read templates rendered a blank step.
it('labels every step the bundled manifests use, including the read steps', () => {
  const manifestSteps = ['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original', 'read_page'];
  for (const step of manifestSteps) {
    expect(TEMPLATE_STEPS[step], step).toBeTruthy();
    expect(templateStepLabel(step), step).not.toContain('未知步骤');
  }
  // An unrecognised step is shown as unknown rather than blank.
  expect(templateStepLabel('invented_step')).toContain('未知步骤');
  // Read capabilities carry read_page; write capabilities carry the submission steps.
  expect(describeCapability('facebook.inbox.read.browser').steps).toContain('read_page');
  expect(describeCapability('facebook.discovery.read.browser').steps).toContain('read_page');
  expect(describeCapability('facebook.comment.reply.browser').steps).toContain('submit_once');
  expect(describeCapability('facebook.comment.reply.browser').steps).not.toContain('read_page');
});
