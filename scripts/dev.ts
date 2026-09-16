import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import pg from 'pg';
import { initializeLocalConfig, projectRoot, closePool } from '@kff/database';
import { startDatabase } from './database';
import { startFixtureServer } from './fixture-server';
import { migrate } from './migrate';
import { seed } from './seed';

const releaseDirectory = process.env.KFF_AGENT_RELEASE_DIR;
if (releaseDirectory && !path.isAbsolute(releaseDirectory)) throw new Error('KFF_AGENT_RELEASE_DIR must be an absolute verified release directory');
const config = initializeLocalConfig();
process.env.KFF_ROOT = projectRoot;
process.env.DATABASE_URL ??= config.database_url;
process.env.KFF_AUTH_MODE ??= 'local';
process.env.KFF_APP_ORIGIN ??= 'http://127.0.0.1:3000';
process.env.KFF_AGENT_TOKEN ??= config.agent_token;
process.env.KFF_ENABLE_LIVE ??= 'false';
process.env.NEXT_TELEMETRY_DISABLED = '1';
let database: Awaited<ReturnType<typeof startDatabase>> | undefined;
const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1000 });
try { await probe.connect(); await probe.end(); console.log('Using existing project database.'); }
catch { await probe.end().catch(() => {}); database = await startDatabase(); }
await migrate(); await seed(); await closePool();
const fixture = await startFixtureServer();
const children: ChildProcess[] = [];
function agentEnvironment() {
  return { NODE_ENV: process.env.NODE_ENV ?? 'development', ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|KFF_ROOT|KFF_APP_ORIGIN|KFF_AGENT_TOKEN|KFF_ENABLE_LIVE|KFF_ENABLE_DISCOVERY|KFF_ENABLE_BROWSER_INBOX|KFF_FACEBOOK_GRAPH_VERSION|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY|PLAYWRIGHT_BROWSERS_PATH)$/.test(key) || /^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]+$/.test(key) || /^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key))) };
}
function launch(script: string, args: string[] = []) {
  const isAgent = args.includes('apps/agent/src/main.ts');
  const env = isAgent ? agentEnvironment() : process.env;
  const child = spawn(process.execPath, [path.join(projectRoot, script), ...args], { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
  children.push(child); return child;
}
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 5000); })));
  await fixture.close(); await database?.stop(); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const web = launch('node_modules/next/dist/bin/next', ['dev', 'apps/web', '--hostname', '127.0.0.1', '--port', '3000']);
web.once('exit', () => { if (!stopping) void stop(); });
let ready = false;
for (let count = 0; count < 90 && !stopping; count++) {
  try { const response = await fetch(process.env.KFF_APP_ORIGIN + '/api/health', { signal: AbortSignal.timeout(2000) }); if (response.ok) { ready = true; break; } } catch { /* Wait for the specific web process above. */ }
  await delay(1000);
}
if (!ready) { console.error('Web startup failed.'); await stop(); }
launch('node_modules/tsx/dist/cli.mjs', ['apps/worker/src/main.ts']);
if (releaseDirectory) {
  // The original dev owner still manages the child; no second Agent or separate pairing is created.
  const agent = spawn(path.join(releaseDirectory, 'node.exe'), [path.join(releaseDirectory, 'agent-launch.mjs'), 'start', '--data-root', projectRoot], { cwd: releaseDirectory, env: agentEnvironment(), stdio: 'inherit', windowsHide: true });
  children.push(agent); agent.once('error', () => { if (!stopping) void stop(); });
  agent.once('exit', () => { if (!stopping) void stop(); });
} else launch('node_modules/tsx/dist/cli.mjs', ['apps/agent/src/main.ts']);
console.log('KFF ready at ' + process.env.KFF_APP_ORIGIN + ' · login details: .kff/本地登录.txt');
