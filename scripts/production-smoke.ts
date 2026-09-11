import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { localConfig, projectRoot } from '@kff/database';
import { requireCondition } from '@kff/core';

const origin = 'http://127.0.0.1:3001';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next','start','apps/web','--hostname','127.0.0.1','--port','3001'], { cwd: projectRoot, env: { ...process.env, KFF_ROOT: projectRoot, KFF_APP_ORIGIN: origin, KFF_ENABLE_LIVE: 'false', KFF_AUTH_MODE: 'local', NEXT_TELEMETRY_DISABLED: '1' }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let bindError = false;
child.stdout.on('data', () => {});
child.stderr.on('data', chunk => { if (String(chunk).includes('EADDRINUSE')) bindError = true; });
try {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    requireCondition(!bindError && child.exitCode === null, 'RUNTIME_START_FAILED', '生产检查服务未启动');
    try { ready = (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait only for the child started above. */ }
    if (ready) break; await delay(500);
  }
  requireCondition(ready && !bindError, 'RUNTIME_START_FAILED', '生产构建未在独立端口就绪');
  const unauthorized = await fetch(origin + '/api/workspace'); requireCondition(unauthorized.status === 401, 'TEST_FAILED', '未登录的生产接口必须拒绝');
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'operator@kff.local', password: localConfig().operator_password }) });
  requireCondition(login.ok, 'TEST_FAILED', '生产构建登录失败');
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; requireCondition(cookie, 'TEST_FAILED', '缺少会话 Cookie');
  const workspace = await fetch(origin + '/api/workspace', { headers: { Cookie: cookie } });
  const data = await workspace.json(); requireCondition(workspace.ok && data.scope && data.live_enabled === false && Array.isArray(data.tasks), 'TEST_FAILED', '生产构建不能读取隔离后的工作区');
  const forbidden = await fetch(origin + '/api/workspace', { headers: { Cookie: cookie, 'x-kff-brand': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }); requireCondition(forbidden.status === 403, 'TEST_FAILED', '伪造品牌没有被拒绝');
  const invalid = await fetch(origin + '/api/workspace', { headers: { Cookie: cookie, 'x-kff-brand': '-'.repeat(36) } }); requireCondition(invalid.status === 400, 'TEST_FAILED', '无效品牌没有被输入校验拒绝');
  const csrf = await fetch(origin + '/api/tasks', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' }); requireCondition(csrf.status === 403, 'TEST_FAILED', '跨源写请求没有被拒绝');
  const page = await fetch(origin + '/tasks'); requireCondition(page.ok && (await page.text()).includes('KFF'), 'TEST_FAILED', '生产页面不可访问');
  await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  console.log('Production smoke: health, auth rejection, login, scoped workspace, forged/invalid brand rejection, CSRF rejection, task route and logout passed; no external actions.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 5000); });
}
