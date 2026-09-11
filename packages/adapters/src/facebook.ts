import { z } from 'zod';
import { AppError, digest, requireCondition, validateTargetUrl } from '@kff/core';
import type { TaskSnapshot } from '@kff/contracts';
import { assertTemplateSnapshot } from './templates';

const pageIdentity = z.object({ id: z.string(), name: z.string() });
const postIdentity = z.object({ id: z.string(), message: z.string(), from: z.object({ id: z.string() }), permalink_url: z.string().url(), is_published: z.boolean() });
export class FacebookPageAdapter {
  constructor(private options: { version: string; pageToken: string; fetch?: typeof fetch; signal?: AbortSignal; assertControlled?: () => void }) {
    requireCondition(/^v[0-9]{1,3}\.[0-9]+$/.test(options.version), 'INVALID_INPUT', '需配置明确的 Graph API 版本');
    requireCondition(options.pageToken.length > 0, 'AUTH_EXPIRED', '未配置主页凭据');
  }
  describeCapabilities() { return { adapter_version: 'facebook-graph-v1', capability_keys: ['facebook.page.read.api', 'facebook.page.publish.api'], automatic_write_retry: false, live_verification: 'PENDING' } as const; }
  validateInput(snapshot: TaskSnapshot) {
    assertTemplateSnapshot(snapshot);
    requireCondition(!snapshot.is_synthetic && snapshot.capability_key.startsWith('facebook.page.') && /^[0-9]{1,128}$/.test(snapshot.external_account_id), 'INVALID_INPUT', 'Facebook 主页输入无效');
    requireCondition(snapshot.body.length <= 5000, 'INVALID_INPUT', '文本超出当前模板范围');
    requireCondition(!snapshot.platform_api_version || snapshot.platform_api_version === this.options.version, 'VERSION_CONFLICT', 'Graph API 版本与任务不符');
  }
  private async graph(path: string, method: 'GET' | 'POST', fields: Record<string, string>): Promise<unknown> {
    this.options.assertControlled?.();
    const url = validateTargetUrl('https://graph.facebook.com/' + this.options.version + '/' + path, ['graph.facebook.com']);
    if (method === 'GET') for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    const timeout = AbortSignal.timeout(15000); const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const response = await (this.options.fetch ?? fetch)(url, { method, headers: { Authorization: 'Bearer ' + this.options.pageToken, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: method === 'POST' ? new URLSearchParams(fields) : undefined, signal, redirect: 'error' });
    const reader = response.body?.getReader(); requireCondition(reader, 'REMOTE_ERROR', '平台未返回可读取内容', 502);
    const parts: Uint8Array[] = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1024 * 1024) { await reader.cancel(); throw new AppError('REMOTE_ERROR', '平台响应超出限制', 502); } parts.push(value); }
    let data: unknown; try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new AppError('REMOTE_ERROR', '平台响应格式无法核验', 502); }
    const graphError = z.object({ error: z.object({ code: z.number().optional() }) }).safeParse(data);
    if (!response.ok || graphError.success) {
      const code = graphError.success ? graphError.data.error.code : undefined;
      throw new AppError(code === 190 ? 'AUTH_EXPIRED' : code === 10 || code === 200 ? 'FORBIDDEN_SCOPE' : response.status === 429 || code === 4 || code === 17 ? 'RATE_LIMITED' : 'REMOTE_ERROR', '平台拒绝操作或当前响应无法核验', 502);
    }
    return data;
  }
  async preflight(snapshot: TaskSnapshot) {
    this.validateInput(snapshot);
    const page = pageIdentity.parse(await this.graph('me', 'GET', { fields: 'id,name' }));
    requireCondition(page.id === snapshot.external_account_id, 'ACCOUNT_MISMATCH', '实际主页身份与任务不一致'); return page;
  }
  async execute(snapshot: TaskSnapshot, beforeSubmit: () => Promise<void>) {
    const page = await this.preflight(snapshot);
    if (snapshot.capability_key === 'facebook.page.read.api') return { remote_id: page.id, actual_account_id: page.id, evidence_kind: 'graph_object' as const, observed_at: new Date().toISOString() };
    requireCondition(snapshot.capability_key === 'facebook.page.publish.api' && snapshot.body.length > 0, 'INVALID_INPUT', '未支持此 Facebook 动作');
    await beforeSubmit();
    const result = z.object({ id: z.string().regex(/^[0-9]+_[0-9]+$/) }).parse(await this.graph(snapshot.external_account_id + '/feed', 'POST', { message: snapshot.body }));
    return this.verifyOutcome(snapshot, result.id);
  }
  async verifyOutcome(snapshot: TaskSnapshot, remoteId: string) {
    requireCondition(/^[0-9]+_[0-9]+$/.test(remoteId), 'INVALID_INPUT', '远端帖子标识无效');
    const parsed = postIdentity.safeParse(await this.graph(remoteId, 'GET', { fields: 'id,message,from,permalink_url,is_published' }));
    requireCondition(parsed.success, 'SUBMISSION_UNCERTAIN', '平台未返回完整的发布证据');
    const post = parsed.data;
    requireCondition(post.is_published && post.id === remoteId && post.from.id === snapshot.external_account_id && digest(post.message) === snapshot.content_hash, 'SUBMISSION_UNCERTAIN', '远端结果与任务不符或尚未发布');
    return { remote_id: post.id, actual_account_id: post.from.id, content_hash: digest(post.message), evidence_kind: 'graph_object' as const, observed_at: new Date().toISOString() };
  }
  normalizeEvent() { throw new AppError('CAPABILITY_BLOCKED', '主页 Webhook 接入尚未启用', 409); }
}
