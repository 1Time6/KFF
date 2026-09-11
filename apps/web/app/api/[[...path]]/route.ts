import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loginInput, uuid, taskInput, accountInput, environmentInput, approvalInput, heartbeatInput, resultInput, stopInput, permitInput, pauseInput, agentInput, agentControlInput, quiescenceInput, contactTargetInput, contactPermissionInput, contactExitInput, contactReviewInput, budgetInput, costReconciliationInput } from '@kff/contracts';
import { AppError, redactError, requireCondition } from '@kff/core';
import { workspace, createAccount, createEnvironment, createTask, approveTask, enqueueTask, stopRun, runDetail, setBrandPause } from '@kff/core/service';
import { authenticateAgent, agentHeartbeat, claimCommand, beginSubmission, acceptReport, commandStatus } from '@kff/core/execution';
import { exportDiagnostic, reconcileSynthetic, releaseQuarantine, recordQuiescence } from '@kff/core/reconciliation';
import { createPermit, revokePermit } from '@kff/core/permits';
import { attachLocalEvidence } from '@kff/core/capabilities';
import { setOrganizationPause, setAccountPause, createAgent, controlAgent } from '@kff/core/controls';
import { createContactTarget, grantContactPermission, exitContact, revokeContactPermission, reviewContactBasis, listContactRecords } from '@kff/core/contacts';
import { costWorkspace, configureBudget, reconcileCost } from '@kff/core/costs';
import { adjudicationInput } from '@kff/contracts';
import { adjudicateAction } from '@kff/core/adjudication';
import { templateVersionInput, templatePolicyInput, templatePreviewInput } from '@kff/contracts';
import { templateWorkspace, createTemplateVersion, setTemplatePolicy, previewTemplate } from '@kff/core/templates';
import { collectionInput, collectionResumeInput } from '@kff/contracts';
import { collectionWorkspace, createCollection, collectionDetail, collectionObservationHistory, controlCollection } from '@kff/core/collections';
import { importUploadInput, importMappingInput, importConfirmationInput, collectionExportInput, importLimits } from '@kff/contracts';
import { uploadImport, importWorkspace, importDetail, previewImport, confirmImport, downloadImportOriginal } from '@kff/core/imports';
import { exportCollection } from '@kff/core/collection-export';
import { collectionFilterSchema,targetPreviewInput,targetSnapshotInput,targetRevokeInput } from '../../../../../packages/contracts/src/target-selection';
import { previewTargets,saveTargetSnapshot,targetSnapshots,readTargetSnapshot,revokeTargetSnapshot } from '@kff/core/target-snapshots';
import {schedulePreviewInput,scheduleSaveInput,scheduleRevisionInput,scheduleControlInput} from '../../../../../packages/contracts/src/schedule';
import {previewSchedule,saveSchedule,scheduleList,scheduleDetail,controlSchedule} from '@kff/core/schedules';
import { requestScope, checkOrigin, login, logout } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path?: string[] }> };
async function body(request: Request,maximum=65536): Promise<unknown> {
  requireCondition(Number(request.headers.get('content-length') ?? 0) <= maximum, 'INVALID_INPUT', '请求内容过大', 413);
  requireCondition(request.headers.get('content-type')?.includes('application/json'), 'INVALID_INPUT', '请求必须使用 JSON');
  const reader = request.body?.getReader(); requireCondition(reader, 'INVALID_INPUT', '请求内容为空');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > maximum) { await reader.cancel(); throw new AppError('INVALID_INPUT', '请求内容过大', 413); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_INPUT', 'JSON 内容无法读取'); }
}
function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
async function uploadBytes(request:Request) {
  requireCondition(Number(request.headers.get('content-length')??0)<=importLimits.file_bytes,'FILE_LIMIT_EXCEEDED','上传文件超过 8 MiB',413);
  requireCondition(request.headers.get('content-type')==='application/octet-stream','INVALID_INPUT','上传需要原始文件内容');
  const reader=request.body?.getReader(); requireCondition(reader,'INVALID_INPUT','上传文件为空'); const chunks:Uint8Array[]=[]; let length=0;
  while(true) { const {value,done}=await reader.read(); if(done) break; length+=value.byteLength; if(length>importLimits.file_bytes) { await reader.cancel(); throw new AppError('FILE_LIMIT_EXCEEDED','上传文件超过 8 MiB',413); } chunks.push(value); }
  return Buffer.concat(chunks);
}
function download(file:{bytes:Buffer;filename:string;format:string;content_type?:string}) {
  return new Response(new Uint8Array(file.bytes),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Type':file.content_type??(file.format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset=utf-8'),'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.filename)}});
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
    if(path==='schedule-previews'&&write)return json(await previewSchedule(scope,schedulePreviewInput.parse(await body(request))));
    if(path==='schedules')return json(write?await saveSchedule(scope,scheduleSaveInput.parse(await body(request))):await scheduleList(scope));
    if(parts[0]==='schedules'&&parts.length>=2){const id=uuid.parse(parts[1]);
      if(parts.length===2&&!write)return json(await scheduleDetail(scope,id));
      if(parts.length===3&&parts[2]==='versions'&&write)return json(await saveSchedule(scope,scheduleRevisionInput.parse(await body(request)),id));
      if(parts.length===3&&parts[2]==='controls'&&write)return json(await controlSchedule(scope,id,scheduleControlInput.parse(await body(request))));
    }
    if(path==='target-previews'&&write)return json(await previewTargets(scope,targetPreviewInput.parse(await body(request,262144))),201);
    if(path==='target-snapshots'&&write)return json(await saveTargetSnapshot(scope,targetSnapshotInput.parse(await body(request))),201);
    if(parts[0]==='target-snapshots'&&parts.length===2&&!write)return json(await readTargetSnapshot(scope,uuid.parse(parts[1])));
    if(parts[0]==='target-snapshots'&&parts.length===3&&parts[2]==='revoke'&&write)return json(await revokeTargetSnapshot(scope,uuid.parse(parts[1]),targetRevokeInput.parse(await body(request))));
    if (path === 'imports' && !write) return json(await importWorkspace(scope));
    if (path === 'imports' && write) {
      requireCondition(scope.role!=='viewer','FORBIDDEN_SCOPE','当前角色仅可查看',403);
      const metadata=request.headers.get('x-kff-import-metadata')??''; requireCondition(metadata.length>0 && metadata.length<=8000,'INVALID_INPUT','上传配置缺失或过长');
      let decoded:unknown; try { decoded=JSON.parse(decodeURIComponent(metadata)); } catch { throw new AppError('INVALID_INPUT','上传配置无法读取'); }
      const input=importUploadInput.parse(decoded); return json(await uploadImport(scope,input,await uploadBytes(request)),201);
    }
    if(parts[0]==='imports' && parts.length>=2) {
      const id=uuid.parse(parts[1]);
      if(parts.length===2 && !write) return json(await importDetail(scope,id));
      if(parts.length===3 && parts[2]==='previews' && write) return json(await previewImport(scope,id,importMappingInput.parse(await body(request))));
      if(parts.length===3 && parts[2]==='confirmations' && write) return json(await confirmImport(scope,id,importConfirmationInput.parse(await body(request))));
      if(parts.length===3 && parts[2]==='original' && !write) return download(await downloadImportOriginal(scope,id));
    }
    if (path === 'collections' && !write) return json(await collectionWorkspace(scope));
    if (path === 'collections' && write) { const result = await createCollection(scope, collectionInput.parse(await body(request))); return json({ ...result, status_url: '/api/collections/' + result.id }, 202); }
    if (parts[0] === 'collections' && parts.length >= 2) {
      const id = uuid.parse(parts[1]);
      if (parts.length === 3 && parts[2] === 'exports' && write) return download(await exportCollection(scope,id,collectionExportInput.parse(await body(request))));
      if (parts.length === 2 && !write) { const search = new URL(request.url).searchParams; const encoded=search.get('filter')??'{}';requireCondition(encoded.length<=2048,'INVALID_INPUT','筛选条件过长');let filter:unknown;try{filter=JSON.parse(encoded);}catch{throw new AppError('INVALID_INPUT','筛选条件无法读取');}return json(await collectionDetail(scope, id, search.get('after') ?? '0', Number(search.get('limit') ?? 25),collectionFilterSchema.parse(filter))); }
      if(parts.length===3&&parts[2]==='target-snapshots'&&!write)return json(await targetSnapshots(scope,id));
      if (parts.length === 3 && write && ['stop-requests','resume'].includes(parts[2])) return json(await controlCollection(scope, id, parts[2] === 'resume' ? 'RESUME' : 'STOP', collectionResumeInput.parse(await body(request))));
      if (parts.length === 4 && parts[2] === 'results' && !write) return json(await collectionObservationHistory(scope, id, uuid.parse(parts[3])));
    }
    if (path === 'templates' && !write) return json(await templateWorkspace(scope));
    if (path === 'templates' && write) return json(await createTemplateVersion(scope, templateVersionInput.parse(await body(request))), 201);
    if (parts.length === 3 && parts[0] === 'templates' && parts[2] === 'previews' && write) return json(await previewTemplate(scope, uuid.parse(parts[1]), templatePreviewInput.parse(await body(request))));
    if (parts.length === 3 && parts[0] === 'templates' && parts[2] === 'policy' && write) return json(await setTemplatePolicy(scope, uuid.parse(parts[1]), templatePolicyInput.parse(await body(request))));
    if (path === 'costs' && !write) return json(await costWorkspace(scope));
    if (path === 'cost-budgets' && write) return json(await configureBudget(scope, budgetInput.parse(await body(request))));
    if (parts.length === 3 && parts[0] === 'costs' && parts[2] === 'reconciliation' && write) return json(await reconcileCost(scope, uuid.parse(parts[1]), costReconciliationInput.parse(await body(request))));
    if (path === 'contacts' && !write) return json(await listContactRecords(scope));
    if (path === 'contacts' && write) return json(await createContactTarget(scope, contactTargetInput.parse(await body(request))), 201);
    if (path === 'contacts/permissions' && write) return json(await grantContactPermission(scope, contactPermissionInput.parse(await body(request))), 201);
    if (path === 'contacts/eligibility' && write) return json(await reviewContactBasis(scope, contactReviewInput.parse(await body(request))));
    if (parts.length === 3 && parts[0] === 'contacts' && parts[2] === 'exit' && write) return json(await exitContact(scope, uuid.parse(parts[1]), contactExitInput.parse(await body(request))));
    if (parts.length === 4 && parts[0] === 'contacts' && parts[1] === 'permissions' && parts[3] === 'revoke' && write) return json(await revokeContactPermission(scope, uuid.parse(parts[2]), stopInput.parse(await body(request)).reason));
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
      if (write && parts[2] === 'adjudications' && parts.length === 3) return json(await adjudicateAction(scope, id, adjudicationInput.parse(await body(request))));
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
