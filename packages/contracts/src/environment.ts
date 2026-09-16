import { z } from 'zod';

const id = z.string().uuid();
const remoteId = z.string().regex(/^[0-9]{1,128}$/);
export const browserConfiguration = z.object({
  driver: z.enum(['native', 'adspower']),
  provider_profile_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable(),
  login_account_id: remoteId,
  operating_identity_id: remoteId,
  locale: z.string().min(2).max(40).refine(value => { try { new Intl.Locale(value); return true; } catch { return false; } }, '语言代码无效'),
  timezone_id: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '时区无效'),
  proxy_ref: z.string().regex(/^KFF_BROWSER_PROXY_[A-Z0-9_]{1,60}$/).nullable(),
}).strict().refine(value => value.driver === 'adspower' ? value.provider_profile_id !== null && value.proxy_ref === null : value.provider_profile_id === null, 'AdsPower 需要 Profile ID，代理由 AdsPower 管理；原生环境不能绑定供应商 Profile');
export const environmentConfigurationInput = z.object({ expected_version: z.number().int().positive(), configuration: browserConfiguration }).strict();
export const environmentOperationInput = z.object({
  operation: z.enum(['CHECK', 'OPEN_LOGIN']), expected_version: z.number().int().positive(), request_id: id,
}).strict();
export const environmentControlInput = z.object({ action: z.enum(['STOP', 'DISABLE', 'ENABLE']), expected_version: z.number().int().positive() }).strict();
export const browserEnvironmentSnapshot = z.object({
  environment_id: id, account_id: id, agent_id: id, organization_id: id, brand_id: id, profile_key: id,
  configuration_version: z.number().int().positive(), configuration: browserConfiguration,
  platform: z.enum(['facebook', 'instagram', 'kff']), is_synthetic: z.boolean(),
  account_type: z.string().min(1).max(40).optional(),
}).strict().refine(value => value.platform !== 'kff' || value.is_synthetic, '本地验证平台必须明确标记为合成环境');
export const environmentCommand = z.object({
  protocol_version: z.literal('kff.environment.v1'), id, operation: z.enum(['CHECK', 'OPEN_LOGIN']),
  snapshot: browserEnvironmentSnapshot, snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.iso.datetime(),
}).strict();
export const environmentOpenedInput = z.object({ browser_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/) }).strict();
export const browserIdentityObservation = z.object({
  method: z.literal('facebook-profile-dom-v1'), authenticated: z.literal(true),
  operating_identity_id: remoteId, account_type: z.literal('profile'),
  display_name: z.string().trim().min(1).max(80), observed_at: z.iso.datetime(),
  source_url: z.string().url(),
}).strict().refine(value => value.source_url === 'https://www.facebook.com/profile.php?id=' + value.operating_identity_id, '身份来源必须匹配个人主页 ID');
export const environmentResultInput = z.object({
  context_closed: z.literal(true), outcome: z.enum(['CHECKED', 'CLOSED', 'BLOCKED']),
  browser_version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
  error_code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
  identity: browserIdentityObservation.optional(),
}).strict().refine(value => !value.identity || value.outcome === 'CHECKED' && !value.error_code, '身份核验必须来自成功的环境检查');
export type BrowserIdentityObservation = z.infer<typeof browserIdentityObservation>;
export type BrowserConfiguration = z.infer<typeof browserConfiguration>;
export type BrowserEnvironmentSnapshot = z.infer<typeof browserEnvironmentSnapshot>;
export type EnvironmentCommand = z.infer<typeof environmentCommand>;
export type EnvironmentResult = z.infer<typeof environmentResultInput>;
