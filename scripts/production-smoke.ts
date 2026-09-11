import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { localConfig, projectRoot } from '@kff/database';
import { requireCondition } from '@kff/core';
import { randomUUID } from 'node:crypto';

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
  const jsonPost=async(path:string,value:unknown)=>{const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});requireCondition(response.ok,'TEST_FAILED','生产导入流程接口失败：'+path);return response;};
  const account=data.accounts.find((value:{is_synthetic:boolean})=>value.is_synthetic); requireCondition(account,'TEST_FAILED','缺少生产冒烟检查的合成账号');
  const uploadInput={request_id:randomUUID(),account_id:account.id,title:'Production synthetic CSV check',filename:'production-sample.csv',format:'csv',encoding:'utf-8',source_namespace:'production-'+randomUUID().slice(0,8),source_description:'Repository synthetic production smoke input',processing_basis:'Owned synthetic data for software verification',purpose:'data_review',export_fields:['message'],original_access:'owner_admin',original_retention_days:1,retention_days:1,display_timezone:'UTC'};
  const upload=await fetch(origin+'/api/imports',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/octet-stream','x-kff-import-metadata':encodeURIComponent(JSON.stringify(uploadInput))},body:'source_object_id,message\n000123456789012345678901234567890,=1+1\n'});
  requireCondition(upload.ok,'TEST_FAILED','生产构建无法调用受限文件解析进程');const imported=await upload.json();
  const preview=await (await jsonPost('imports/'+imported.id+'/previews',{request_id:randomUUID(),sheet:0,header_row:1,source_object_id:0,fields:{message:1},kind_columns:{},text_encoding:'plain'})).json();
  requireCondition(preview.summary.valid_rows===1 && preview.summary.error_rows===0,'TEST_FAILED','生产构建预览结果错误');
  const confirmation=await (await jsonPost('imports/'+imported.id+'/confirmations',{request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.preview_hash,excluded_error_rows:0,confirm_valid_rows:true})).json();
  const exported=await (await jsonPost('collections/'+confirmation.query_id+'/exports',{format:'csv',fields:['message']})).text();
  requireCondition(exported.includes("'000123456789012345678901234567890")&&exported.includes("'=1+1"),'TEST_FAILED','生产构建 CSV 导出未保留文本标识或公式保护');
  const targetPreview=await (await jsonPost('target-previews',{request_id:randomUUID(),query_id:confirmation.query_id,mode:'ALL_FILTERED',filter:{id_prefix:'000123'},fields:['message'],purpose:'data_review'})).json();
  requireCondition(targetPreview.definition?.included_count===1&&targetPreview.definition.execution_authorized===false,'TEST_FAILED','生产构建目标预览范围错误');
  const target=await (await jsonPost('target-snapshots',{request_id:randomUUID(),preview_id:targetPreview.id,preview_hash:targetPreview.definition_hash,title:'Production fixed selection',confirmed_included_count:1,confirmed_excluded_count:0})).json();
  const fixedExport=await (await jsonPost('collections/'+confirmation.query_id+'/exports',{format:'csv',fields:['message'],target_snapshot_id:target.id})).text();
  requireCondition(fixedExport.includes(target.id)&&fixedExport.includes("'000123456789012345678901234567890"),'TEST_FAILED','生产构建未导出固定目标及快照标识');
  await jsonPost('target-snapshots/'+target.id+'/revoke',{request_id:randomUUID(),expected_version:1,reason:'Production synthetic snapshot verification completed'});
  const schedulePreview=await (await jsonPost('schedule-previews',{request_id:randomUUID(),evaluate_at:'2024-11-03T07:00:00Z',rule:{timezone:'America/New_York',kind:'ONCE',start_date:'2024-11-03',end_date:'2024-11-03',time:'01:30',weekdays:[],repeated_time:'BOTH',missing_time:'SKIP',missed_policy:'CATCH_UP',catch_up_limit:2,spacing_seconds:60,late_tolerance_seconds:0,maximum_lateness_seconds:3600}})).json();
  requireCondition(schedulePreview.definition.slots.length===2&&schedulePreview.definition.slots[0].scheduled_at==='2024-11-03T05:30:00.000Z','TEST_FAILED','生产构建时区规则预览不正确');
  const schedule=await (await jsonPost('schedules',{request_id:randomUUID(),preview_id:schedulePreview.id,preview_hash:schedulePreview.definition_hash,title:'Production synthetic paused calendar'})).json();
  requireCondition(schedule.state==='PAUSED','TEST_FAILED','生产构建没有将新计划保存为暂停');
  await jsonPost('schedules/'+schedule.id+'/controls',{request_id:randomUUID(),expected_version:schedule.version,action:'STOP',reason:'Completed synthetic production calendar check'});
  await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  console.log('Production smoke: health, auth, scoped workspace, forged brand, CSRF, task route, bounded CSV upload, mapping, confirmation, protected export, frozen target selection, revocation, timezone calendar, paused schedule, future stop and logout passed; no external actions.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 5000); });
}
