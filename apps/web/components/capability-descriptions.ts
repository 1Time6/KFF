/**
 * What each capability actually does, in the terms an operator needs.
 *
 * The previous labels were inferred from substrings of the key with a catch-all default of
 * "主页身份读取", so every capability that was not a comment, social, messenger or publish action -
 * browser inbox reading, browser discovery, Instagram identity, the local fixtures - was displayed
 * as a page identity read, and every real capability was shown as Graph API. The template step
 * dictionary was missing `read_page`, so the steps of every read template rendered blank.
 *
 * The key list below is exhaustive by type: adding a capability to the contract without describing
 * it here is a compile error, and the contract test fails as well, so a new capability cannot
 * silently fall back to a wrong sentence.
 */
export const CAPABILITY_KEYS = [
  'facebook.comment.reply.browser',
  'facebook.messenger.reply.browser',
  'facebook.inbox.read.browser',
  'facebook.discovery.read.browser',
  'kff.fixture.messenger.reply.browser',
  'kff.fixture.inbox.read.browser',
  'kff.fixture.discovery.read.browser',
  'kff.fixture.page.read.browser',
  'kff.fixture.page.publish.browser',
  'facebook.page.read.api',
  'facebook.page.publish.api',
  'kff.fixture.messenger.reply.api',
  'facebook.messenger.reply.api',
  'kff.fixture.social.reply.api',
  'social.comment.reply.api',
  'instagram.account.read.api',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Every step any bundled manifest uses, including the read steps that used to render blank. */
export const TEMPLATE_STEPS: Record<string, string> = {
  validate_input: '检查输入与版本',
  verify_identity: '核对实际账号',
  prepare_content: '准备已审核内容',
  read_page: '读取一页可见内容',
  submit_once: '提交前复核，单次提交',
  verify_original: '核验原提交的结果',
};

export interface CapabilityDescription {
  label: string;
  platform: 'facebook' | 'instagram' | 'kff';
  driver: 'browser' | 'api';
  kind: 'read' | 'write';
  /** A write that creates content or sends a message needs an approved body or draft snapshot. */
  needs_business_context: boolean;
  steps: string[];
  evidence: 'inbox_page' | 'collection_page' | 'page_identity' | 'message_acceptance' | 'published_object_identity_author_content';
}

const browser = 'browser' as const, api = 'api' as const;
const readSteps = ['validate_input', 'verify_identity', 'read_page'];
const writeSteps = ['validate_input', 'verify_identity', 'prepare_content', 'submit_once', 'verify_original'];
const identitySteps = ['validate_input', 'verify_identity'];

export const CAPABILITY_DESCRIPTIONS: Record<CapabilityKey, CapabilityDescription> = {
  'facebook.comment.reply.browser': { label: 'Facebook 公开评论回复', platform: 'facebook', driver: browser, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'facebook.messenger.reply.browser': { label: 'Facebook 私信回复（浏览器）', platform: 'facebook', driver: browser, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'facebook.inbox.read.browser': { label: 'Facebook 浏览器收件读取', platform: 'facebook', driver: browser, kind: 'read', needs_business_context: false, steps: readSteps, evidence: 'inbox_page' },
  'facebook.discovery.read.browser': { label: 'Facebook 公开发现读取', platform: 'facebook', driver: browser, kind: 'read', needs_business_context: false, steps: readSteps, evidence: 'collection_page' },
  'kff.fixture.messenger.reply.browser': { label: '本地合成私信回复（浏览器）', platform: 'kff', driver: browser, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'kff.fixture.inbox.read.browser': { label: '本地合成收件读取', platform: 'kff', driver: browser, kind: 'read', needs_business_context: false, steps: readSteps, evidence: 'inbox_page' },
  'kff.fixture.discovery.read.browser': { label: '本地合成发现读取', platform: 'kff', driver: browser, kind: 'read', needs_business_context: false, steps: readSteps, evidence: 'collection_page' },
  'kff.fixture.page.read.browser': { label: '本地合成主页读取', platform: 'kff', driver: browser, kind: 'read', needs_business_context: false, steps: identitySteps, evidence: 'page_identity' },
  'kff.fixture.page.publish.browser': { label: '本地合成主页发布', platform: 'kff', driver: browser, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'published_object_identity_author_content' },
  'facebook.page.read.api': { label: 'Facebook 主页读取（官方接口）', platform: 'facebook', driver: api, kind: 'read', needs_business_context: false, steps: identitySteps, evidence: 'page_identity' },
  'facebook.page.publish.api': { label: 'Facebook 主页发布（官方接口）', platform: 'facebook', driver: api, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'published_object_identity_author_content' },
  'kff.fixture.messenger.reply.api': { label: '本地合成私信回复（接口）', platform: 'kff', driver: api, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'facebook.messenger.reply.api': { label: 'Facebook 私信回复（官方接口）', platform: 'facebook', driver: api, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'kff.fixture.social.reply.api': { label: '本地合成社交互动回复', platform: 'kff', driver: api, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'social.comment.reply.api': { label: '社交评论互动回复（官方接口）', platform: 'facebook', driver: api, kind: 'write', needs_business_context: true, steps: writeSteps, evidence: 'message_acceptance' },
  'instagram.account.read.api': { label: 'Instagram 账号身份核验', platform: 'instagram', driver: api, kind: 'read', needs_business_context: false, steps: identitySteps, evidence: 'page_identity' },
};

/**
 * Describe a capability by its key. An unrecognised key is shown as unknown rather than being
 * described as a page identity read, so a capability added later is visibly unlabelled instead of
 * mislabelled.
 */
export function describeCapability(key: string | undefined | null): CapabilityDescription & { known: boolean } {
  const found = key ? Object.prototype.hasOwnProperty.call(CAPABILITY_DESCRIPTIONS, key) ? CAPABILITY_DESCRIPTIONS[key as CapabilityKey] : undefined : undefined;
  if (found) return { ...found, known: true };
  return { label: key ? '未知能力：' + key : '未知能力', platform: 'kff', driver: api, kind: 'read', needs_business_context: false, steps: identitySteps, evidence: 'page_identity', known: false };
}

/** Where a capability runs, in the terms the capability table uses. */
export function capabilityChannel(key: string): { platform: string; driver: string } {
  const described = describeCapability(key);
  // The platform of an unknown key is not claimed: it is reported as unknown with the key itself.
  return described.known ? { platform: described.platform, driver: described.driver } : { platform: '未知平台', driver: '未知通道' };
}

/** The Chinese label for a template step, or an explicit unknown marker. */
export function templateStepLabel(step: string): string {
  return TEMPLATE_STEPS[step] ?? '未知步骤：' + step;
}
