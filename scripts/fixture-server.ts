import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeDir } from '@kff/database';
import { digest } from '@kff/core';
import { fixtureScenarioSchema, externalId } from '@kff/contracts';

interface FixturePost { id: string; account_id: string; action_id: string; body: string; content_hash: string; created_at: string }
export async function startFixtureServer(port = 4311) {
  await mkdir(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, 'fixture-posts.json');
  let posts: FixturePost[] = [];
  try { posts = JSON.parse(await readFile(file, 'utf8')) as FixturePost[]; } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  let writes = Promise.resolve();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:' + port);
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ fixture: true })); return; }
    if (url.pathname === '/posts' && request.method === 'POST') {
      try {
        let buffer = ''; for await (const chunk of request) { buffer += chunk.toString(); if (buffer.length > 16000) throw new Error('too large'); }
        const input = JSON.parse(buffer) as Record<string, string>;
        const account = externalId.parse(input.account_id);
        if (!input.body || input.body.length > 5000 || !/^[a-f0-9-]{36}$/.test(input.action_id)) throw new Error('invalid input');
        const post: FixturePost = { id: 'synthetic_' + randomUUID(), account_id: account, action_id: input.action_id, body: input.body, content_hash: digest(input.body), created_at: new Date().toISOString() };
        posts.push(post);
        writes = writes.then(async () => { await writeFile(file + '.tmp', JSON.stringify(posts)); await rename(file + '.tmp', file); });
        await writes; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(post));
      } catch { response.statusCode = 400; response.end('Invalid synthetic input'); }
      return;
    }
    if (url.pathname === '/posts' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(posts.filter(post => post.action_id === url.searchParams.get('action_id')))); return; }
    if (url.pathname !== '/page') { response.statusCode = 404; response.end(); return; }
    const parsed = fixtureScenarioSchema.safeParse(url.searchParams.get('scenario') ?? 'normal');
    const accountParsed = externalId.safeParse(url.searchParams.get('account'));
    if (!parsed.success || !accountParsed.success) { response.statusCode = 400; response.end(); return; }
    const scenario = parsed.data; const account = scenario === 'wrong_account' ? '999999999999999999' : accountParsed.data;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>KFF 合成验证页</title></head><body><h1>KFF 合成验证页</h1><p>此页面属于本地软件测试，不是 Facebook。</p>' + (scenario === 'login_expired' ? '<button>登录</button>' : '<div data-testid="account-identity">' + account + '</div><label>发布内容<textarea aria-label="发布内容"></textarea></label><button data-testid="publish">发布</button>' + (scenario === 'duplicate_control' ? '<button data-testid="publish">发布</button>' : '') + '<div id="results"></div>') + '<script>const account=' + JSON.stringify(account) + ';const action=new URL(location.href).searchParams.get("action");document.querySelectorAll("[data-testid=publish]").forEach(button=>button.addEventListener("click",async()=>{const body=document.querySelector("textarea").value;const response=await fetch("/posts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account_id:account,action_id:action,body})});const post=await response.json();const item=document.createElement("article");item.dataset.testid="published-post";item.dataset.remoteId=post.id;item.dataset.accountId=post.account_id;item.dataset.contentHash=post.content_hash;item.textContent=post.body;document.querySelector("#results").append(item);}));</script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixtureServer(); console.log('KFF synthetic browser fixture on 127.0.0.1:4311');
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0); }); process.on('SIGTERM', async () => { await fixture.close(); process.exit(0); });
}
