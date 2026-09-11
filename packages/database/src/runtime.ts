import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const projectRoot = process.env.KFF_ROOT ?? (path.basename(process.cwd()) === 'web' ? path.resolve(/* turbopackIgnore: true */ process.cwd(), '../..') : process.cwd());
export const runtimeDir = path.join(projectRoot, '.kff');
export interface LocalConfig { database_url: string; database_password: string; session_secret: string; operator_password: string; agent_token: string }
export function localConfig(): LocalConfig {
  const file = path.join(runtimeDir, 'local-config.json');
  if (!existsSync(file)) throw new Error('请先运行 pnpm dev 初始化本地环境');
  return JSON.parse(readFileSync(file, 'utf8')) as LocalConfig;
}
export function initializeLocalConfig(): LocalConfig {
  mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, 'local-config.json');
  if (!existsSync(file)) {
    const password = randomBytes(24).toString('hex');
    const config: LocalConfig = { database_url: 'postgresql://kff_local:' + password + '@127.0.0.1:55432/kff', database_password: password, session_secret: randomBytes(48).toString('hex'), operator_password: randomBytes(10).toString('base64url'), agent_token: randomBytes(32).toString('hex') };
    writeFileSync(file, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(runtimeDir, '本地登录.txt'), '地址：http://127.0.0.1:3000\n账号：operator@kff.local\n密码：' + config.operator_password + '\n仅用于本机开发。\n', { mode: 0o600 });
  }
  const config = localConfig();
  const agentFile = path.join(runtimeDir, 'agent-config.json');
  if (!existsSync(agentFile)) writeFileSync(agentFile, JSON.stringify({ agent_id: '66666666-6666-4666-8666-666666666666', organization_id: '11111111-1111-4111-8111-111111111111', brand_id: '22222222-2222-4222-8222-222222222222', token: config.agent_token, controller_origin: 'http://127.0.0.1:3000' }, null, 2), { mode: 0o600, flag: 'wx' });
  return config;
}
