import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { mkdir, open, readFile, writeFile, rename, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, AppError, requireCondition } from '@kff/core';
import { browserEnvironmentSnapshot, type BrowserEnvironmentSnapshot } from '../../contracts/src/environment';

export interface ManagedBrowser { context: BrowserContext; version: string; close(): Promise<void> }
const proxySchema = z.object({ server: z.string().url(), username: z.string().max(300).optional(), password: z.string().max(300).optional() }).strict();
function loopbackUrl(value: string, websocket = false) {
  const url = new URL(value);
  requireCondition(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && (websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) && !url.username && !url.password && !url.hash, 'PROVIDER_ENDPOINT_INVALID', '浏览器供应商必须使用本机接口');
  return url;
}

const providerProfile = z.object({ user_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), serial_number: z.string().regex(/^[0-9]+$/), name: z.string().max(1000), domain_name: z.string().max(1000).optional() });
/** A narrow AdsPower v1 client: no caller-supplied paths, launch flags, or script execution. */
export class AdsPowerClient {
  private readonly origin: string;
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {
    const endpoint = loopbackUrl(environment.KFF_ADSPOWER_ORIGIN ?? 'http://127.0.0.1:50325');
    requireCondition(endpoint.pathname === '/' && !endpoint.search, 'PROVIDER_ENDPOINT_INVALID', 'AdsPower 地址只能包含本机协议、主机和端口');
    this.origin = endpoint.origin;
  }
  private async request(operation: 'active' | 'start' | 'stop', profileId: string, headless = false) {
    requireCondition(/^[A-Za-z0-9_-]{1,100}$/.test(profileId), 'INVALID_INPUT', 'Profile ID 无效');
    const url = new URL('/api/v1/browser/' + operation, this.origin); url.searchParams.set('user_id', profileId);
    if (operation === 'start') { url.searchParams.set('open_tabs', '1'); url.searchParams.set('ip_tab', '0'); url.searchParams.set('headless', headless ? '1' : '0'); }
    return this.read(url, operation === 'start' ? 60000 : 20000);
  }
  private async read(url: URL, timeout = 20000) {
    try {
      const response = await fetch(url, { headers: this.environment.KFF_ADSPOWER_API_KEY ? { Authorization: 'Bearer ' + this.environment.KFF_ADSPOWER_API_KEY } : {}, signal: AbortSignal.timeout(timeout), redirect: 'error' });
      requireCondition(response.ok, 'PROVIDER_UNAVAILABLE', 'AdsPower 本地接口不可用');
      const body = z.object({ code: z.number(), data: z.unknown().optional(), msg: z.string().optional() }).parse(await response.json());
      if (body.code !== 0 && /too many request|request.*per second/i.test(body.msg ?? '')) throw new AppError('PROVIDER_RATE_LIMITED', 'AdsPower 本地接口请求过于频繁，请稍后重试');
      if (body.code !== 0 && /server is not working|check the network/i.test(body.msg ?? '')) throw new AppError('PROVIDER_NETWORK_ERROR', 'AdsPower 返回服务器或网络错误，请在本机窗口查看具体原因');
      if (body.code !== 0 && /require api.key|invalid.*api.key|api.key.*invalid/i.test(body.msg ?? '')) throw new AppError('PROVIDER_AUTH_REQUIRED', '请检查本机 AdsPower API Key');
      requireCondition(body.code === 0, 'PROVIDER_REJECTED', 'AdsPower 拒绝操作，请在本机检查 Profile 和 API 权限');
      return body.data;
    } catch (error) { throw error instanceof AppError ? error : new AppError('PROVIDER_UNAVAILABLE', 'AdsPower 本地接口未返回有效结果'); }
  }
  async health() { await this.read(new URL('/status', this.origin)); return { available: true }; }
  async listProfiles(options: { serialNumber?: string; page?: number } = {}) {
    const input = z.object({ serialNumber: z.string().regex(/^[0-9]{1,12}$/).optional(), page: z.number().int().min(1).max(10000).default(1) }).strict().parse(options);
    const url = new URL('/api/v1/user/list', this.origin);
    url.searchParams.set('page', String(input.page)); url.searchParams.set('page_size', '100');
    if (input.serialNumber) url.searchParams.set('serial_number', input.serialNumber);
    // The provider response also contains passwords and proxies; only return this explicit projection.
    const data = z.object({ list: z.array(providerProfile).max(100) }).parse(await this.read(url));
    requireCondition(!input.serialNumber || data.list.every(profile => profile.serial_number === input.serialNumber), 'PROFILE_IDENTITY_MISMATCH', '返回的环境与指定序号不符');
    return data.list;
  }
  async status(profileId: string) {
    return z.object({ status: z.enum(['Active', 'Inactive']), ws: z.object({ puppeteer: z.string() }).passthrough().optional() }).passthrough().parse(await this.request('active', profileId));
  }
  async start(profileId: string, headless: boolean) {
    const result = z.object({ ws: z.object({ puppeteer: z.string() }).passthrough() }).passthrough().parse(await this.request('start', profileId, headless));
    const endpoint = loopbackUrl(result.ws.puppeteer, true);
    requireCondition(endpoint.pathname.startsWith('/devtools/browser/'), 'PROVIDER_ENDPOINT_INVALID', 'AdsPower 返回的浏览器连接无效');
    return endpoint.href;
  }
  async stop(profileId: string, expectedEndpoint?: string) {
    const before = await this.status(profileId);
    if (before.status === 'Inactive') return;
    const endpoint = expectedEndpoint ?? before.ws?.puppeteer;
    requireCondition(endpoint && before.ws?.puppeteer === endpoint, 'GUARDIAN_UNCONFIRMED', 'Profile 已切换浏览器实例，不能关闭其他操作者的窗口');
    try { loopbackUrl(endpoint, true); } catch { throw new AppError('GUARDIAN_UNCONFIRMED', '无法核对本机浏览器实例'); }
    await this.request('stop', profileId);
    // AdsPower can acknowledge stop before the browser disappears from active status.
    // Observe this same instance until it closes; never issue a second stop against a replacement.
    const deadline = performance.now() + 10000;
    for (;;) {
      let current: Awaited<ReturnType<AdsPowerClient['status']>>;
      try { current = await this.status(profileId); }
      catch (error) {
        if (!(error instanceof AppError && error.code === 'PROVIDER_RATE_LIMITED' && performance.now() < deadline)) throw error;
        await delay(1100); continue;
      }
      if (current.status === 'Inactive') return;
      requireCondition(current.ws?.puppeteer === endpoint, 'GUARDIAN_UNCONFIRMED', '关闭期间浏览器实例已变化，保留环境占用');
      requireCondition(performance.now() < deadline, 'GUARDIAN_UNCONFIRMED', 'AdsPower 尚未确认 Profile 关闭');
      await delay(1100);
    }
  }
}

/** Project-owned manifest and non-stealable lock survive process crashes. */
export async function openManagedBrowser(root: string, raw: BrowserEnvironmentSnapshot, headless: boolean, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<ManagedBrowser> {
  const snapshot = browserEnvironmentSnapshot.parse(raw); const config = snapshot.configuration;
  const base = path.resolve(root); await mkdir(base, { recursive: true });
  requireCondition(path.resolve(await realpath(base)).toLowerCase() === base.toLowerCase(), 'PROFILE_PATH_INVALID', '浏览器根目录不能通过符号链接重定向');
  const folder = path.join(base, config.driver === 'adspower' ? 'adspower-' + config.provider_profile_id : snapshot.profile_key);
  await mkdir(folder, { recursive: true });
  requireCondition(path.resolve(await realpath(folder)).toLowerCase() === folder.toLowerCase(), 'PROFILE_PATH_INVALID', '环境目录不能通过符号链接重定向');
  const lockFile = path.join(folder, 'owner.lock');
  const owner = await open(lockFile, 'wx', 0o600).catch(() => { throw new AppError('RESOURCE_BUSY', 'Profile 已被占用，或旧浏览器尚未确认关闭'); });
  await owner.writeFile(JSON.stringify({ pid: process.pid, environment_id: snapshot.environment_id, agent_id: snapshot.agent_id })); await owner.sync();
  const release = async () => { await owner.close(); await unlink(lockFile); };
  let browser: Browser | undefined; let context: BrowserContext | undefined; let providerStarted = false; let nativeStarting = false;
  let provider: AdsPowerClient | undefined;
  let providerEndpoint: string | undefined;
  const close = async () => {
    try {
      if (providerStarted) {
        requireCondition(providerEndpoint, 'GUARDIAN_UNCONFIRMED', '启动结果未知，不能把暂时未打开当作关闭证明');
        await provider!.stop(config.provider_profile_id!, providerEndpoint); await browser?.close();
      }
      else if (context) await context.close();
      await release();
    } catch { await owner.close().catch(() => {}); throw new AppError('GUARDIAN_UNCONFIRMED', '没有取得浏览器关闭证明，保留环境占用'); }
  };
  try {
    const manifestFile = path.join(folder, 'binding.json');
    const binding = { organization_id: snapshot.organization_id, brand_id: snapshot.brand_id, account_id: snapshot.account_id, environment_id: snapshot.environment_id, profile_key: snapshot.profile_key, agent_id: snapshot.agent_id, login_account_id: config.login_account_id, operating_identity_id: config.operating_identity_id };
    const previous = await readFile(manifestFile, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    requireCondition(!previous || digest(JSON.parse(previous)) === digest(binding), 'PROFILE_IDENTITY_MISMATCH', '持久目录已绑定其他账号、品牌或执行身份');
    if (!previous) { await writeFile(manifestFile + '.tmp', JSON.stringify(binding), { mode: 0o600, flush: true }); await rename(manifestFile + '.tmp', manifestFile); }
    if (config.driver === 'adspower') {
      provider = new AdsPowerClient(environment);
      requireCondition((await provider.status(config.provider_profile_id!)).status === 'Inactive', 'RESOURCE_BUSY', 'AdsPower Profile 已由其他操作者打开，请先关闭');
      // A lost response can precede a delayed launch. Inactive alone cannot clear an ambiguous start.
      providerStarted = true;
      let endpoint: string;
      try { endpoint = await provider.start(config.provider_profile_id!, headless); providerEndpoint = endpoint; }
      catch (error) {
        // Only an explicit provider rejection followed by Inactive establishes that no browser was started.
        if (error instanceof AppError && ['PROVIDER_NETWORK_ERROR', 'PROVIDER_REJECTED', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_RATE_LIMITED'].includes(error.code) && (await provider.status(config.provider_profile_id!)).status === 'Inactive') providerStarted = false;
        throw error;
      }
      const active = await provider.status(config.provider_profile_id!);
      requireCondition(active.status === 'Active' && active.ws?.puppeteer === endpoint, 'PROFILE_IDENTITY_MISMATCH', 'Profile 状态与启动连接不一致');
      browser = await chromium.connectOverCDP(endpoint, { timeout: 15000, noDefaults: true });
      requireCondition(browser.contexts().length === 1, 'PROFILE_IDENTITY_MISMATCH', '供应商返回多个上下文，无法确定环境');
      context = browser.contexts()[0];
    } else {
      let proxy: z.infer<typeof proxySchema> | undefined;
      if (config.proxy_ref) {
        requireCondition(environment[config.proxy_ref], 'PROXY_UNCONFIGURED', '本机代理引用未配置，禁止回退直连');
        try { proxy = proxySchema.parse(JSON.parse(environment[config.proxy_ref]!)); } catch { throw new AppError('PROXY_UNCONFIGURED', '本机代理配置无效'); }
        const server = new URL(proxy.server);
        requireCondition(['http:', 'https:', 'socks5:'].includes(server.protocol) && !server.username && !server.password && !server.search && !server.hash, 'PROXY_UNCONFIGURED', '代理地址格式无效');
      }
      const userData = path.join(folder, 'user-data'); await mkdir(userData, { recursive: true });
      requireCondition(path.resolve(await realpath(userData)).toLowerCase() === userData.toLowerCase(), 'PROFILE_PATH_INVALID', '持久数据目录不能通过符号链接重定向');
      nativeStarting = true;
      context = await chromium.launchPersistentContext(userData, { headless, locale: config.locale, timezoneId: config.timezone_id, proxy, acceptDownloads: false, serviceWorkers: 'block', timeout: 20000 });
    }
    let closing: Promise<void> | undefined;
    return { context, version: (browser ?? context.browser())?.version() ?? 'unknown', close: () => closing ??= close() };
  } catch (error) {
    if (providerStarted || context) await close();
    else if (nativeStarting) { await owner.close(); throw new AppError('GUARDIAN_UNCONFIRMED', '浏览器启动中断，需核实本机关闭状态'); }
    else await release();
    throw error;
  }
}
