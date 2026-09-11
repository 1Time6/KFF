import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loginInput, uuid, taskInput, accountInput, environmentInput, approvalInput, heartbeatInput, resultInput, stopInput, permitInput, pauseInput, agentInput, agentControlInput, quiescenceInput } from '@kff/contracts';
import { AppError, redactError, requireCondition } from '@kff/core';
import { workspace, createAccount, createEnvironment, createTask, approveTask, enqueueTask, stopRun, runDetail, setBrandPause } from '@kff/core/service';
import { authenticateAgent, agentHeartbeat, claimCommand, beginSubmission, acceptReport, commandStatus } from '@kff/core/execution';
import { exportDiagnostic, reconcileSynthetic, releaseQuarantine, recordQuiescence } from '@kff/core/reconciliation';
import { createPermit, revokePermit } from '@kff/core/permits';
import { attachLocalEvidence } from '@kff/core/capabilities';
import { setOrganizationPause, setAccountPause, createAgent, controlAgent } from '@kff/core/controls';
import { requestScope, checkOrigin, login, logout } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path?: string[] }> };
async function body(request: Request): Promise<unknown> {
  requireCondition(Number(request.headers.get('content-length') ?? 0) <= 65536, 'INVALID_INPUT', '请求内容过大', 413);
  requireCondition(request.headers.get('content-type')?.includes('application/json'), 'INVALID_INPUT', '请求必须使用 JSON');
  const reader = request.body?.getReader(); requireCondition(reader, 'INVALID_INPUT', '请求内容为空');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 65536) { await reader.cancel(); throw new AppError('INVALID_INPUT', '请求内容过大', 413); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_INPUT', 'JSON 内容无法读取'); }
}
function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
async function handle(request: Request, context: Context) {
  const requestId = randomUUID();
  try {
    const parts = (await context.params).path ?? []; const path = parts.join('/'); const write = request.method === 'POST';
    if (path === 'health' && !write) return json({ status: 'ok', protocol: 'kff.api.v1' });
    if (path === 'auth/login' && write) { const input = loginInput.parse(await body(request)); const cookie = await login(request, input.email, input.password); return json({ authenticated: true }, 200, { 'Set-Cookie': cookie }); }
    if (path === 'auth/logout' && write) return json({ authenticated: false }, 200, { 'Set-Cookie': await logout(request) });
    if (parts[0] === 'agent') {
      requireCondition(write, 'NOT_FOUND', '接口不存在', 404);
      const agent = await authenticateAgent(request);
      if (path === 'agent/heartbeats') { const input = heartbeatInput.parse(await body(request)); return json(await agentHeartbeat(agent, input.command_id)); }
      if (path === 'agent/claims') return json({ command: await claimCommand(agent) });
      if (path === 'agent/action-reports') return json(await acceptReport(agent, resultInput.parse(await body(request))));
      if (parts.length === 4 && parts[1] === 'commands' && parts[3] === 'submit') return json(await beginSubmission(agent, uuid.parse(parts[2])));
      if (parts.length === 4 && parts[1] === 'commands' && parts[3] === 'status') return json(await commandStatus(agent, uuid.parse(parts[2])));
      if (parts.length === 4 && parts[1] === 'commands' && parts[3] === 'quiescence') return json(await recordQuiescence(agent, uuid.parse(parts[2]), quiescenceInput.parse(await body(request))));
      throw new AppError('NOT_FOUND', '接口不存在', 404);
    }
    const scope = await requestScope(request);
    if (write) checkOrigin(request);
    if (path === 'workspace' && !write) return json(await workspace(scope));
    if (path === 'accounts' && write) return json(await createAccount(scope, accountInput.parse(await body(request))), 201);
    if (path === 'agents' && write) return json(await createAgent(scope, agentInput.parse(await body(request))), 201);
    if (parts.length === 3 && parts[0] === 'agents' && parts[2] === 'control' && write) return json(await controlAgent(scope, uuid.parse(parts[1]), agentControlInput.parse(await body(request))));
    if (parts.length === 3 && parts[0] === 'accounts' && parts[2] === 'pause' && write) { const input = pauseInput.parse(await body(request)); return json(await setAccountPause(scope, uuid.parse(parts[1]), input.paused, input.reason)); }
    if (path === 'organization/pause' && write) { const input = pauseInput.parse(await body(request)); return json(await setOrganizationPause(scope, input.paused, input.reason)); }
    if (path === 'environments' && write) return json(await createEnvironment(scope, environmentInput.parse(await body(request))), 201);
    if (path === 'tasks' && write) return json(await createTask(scope, taskInput.parse(await body(request))), 201);
    if (path === 'pilot-permits' && write) return json(await createPermit(scope, permitInput.parse(await body(request))), 201);
    if (parts.length === 3 && parts[0] === 'pilot-permits' && parts[2] === 'revoke' && write) return json(await revokePermit(scope, uuid.parse(parts[1])));
    if (parts.length === 3 && parts[0] === 'diagnostics' && parts[2] === 'export' && write) return json(await exportDiagnostic(scope, uuid.parse(parts[1])));
    if (parts.length === 3 && parts[0] === 'capabilities' && parts[2] === 'local-evidence' && write) return json(await attachLocalEvidence(scope, uuid.parse(parts[1])));
    if (parts.length === 3 && parts[0] === 'tasks' && write) {
      const id = uuid.parse(parts[1]);
      if (parts[2] === 'approval-decisions') return json(await approveTask(scope, id, approvalInput.parse(await body(request))));
      if (parts[2] === 'runs') { const run = await enqueueTask(scope, id); return json({ ...run, status_url: '/api/runs/' + run.id }, 202); }
    }
    if (parts[0] === 'runs') {
      const id = uuid.parse(parts[1]);
      if (!write && parts.length === 2) return json(await runDetail(scope, id));
      if (write && parts[2] === 'stop-requests' && parts.length === 3) return json(await stopRun(scope, id, stopInput.parse(await body(request)).reason));
      if (write && parts[2] === 'reconciliation' && parts.length === 3) return json(await reconcileSynthetic(scope, id));
      if (write && parts[2] === 'quarantine-release' && parts.length === 3) return json(await releaseQuarantine(scope, id));
    }
    if (path === 'brand/pause' && write) { const input = z.object({ paused: z.boolean() }).strict().parse(await body(request)); return json(await setBrandPause(scope, input.paused)); }
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: { code: 'INVALID_INPUT', message: error.issues[0]?.message ?? '输入无效', request_id: requestId } }, 400);
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return json({ error: { code: 'VERSION_CONFLICT', message: '记录已存在，请刷新后查看', request_id: requestId } }, 409);
    const mapped = redactError(error); if (mapped.status === 500) console.error('API request failed:', requestId, error instanceof Error ? error.name : 'Unknown');
    return json({ error: { code: mapped.code, message: mapped.message, request_id: requestId } }, mapped.status);
  }
}
export const GET = handle;
export const POST = handle;
