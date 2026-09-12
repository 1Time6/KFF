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
  const channel=await (await jsonPost('site-channels',{request_id:randomUUID(),name:'Production owned synthetic inbox',is_synthetic:true,session_hours:1,reply_window_hours:1,sessions_per_minute:10,messages_per_minute:30})).json();
  const chatPage=await fetch(origin+'/chat/'+channel.id);requireCondition(chatPage.ok,'TEST_FAILED','生产构建访客页面不可访问');
  const visitorStart=await fetch(origin+'/api/public/chat/'+channel.id+'/sessions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  const visitorCookie=visitorStart.headers.get('set-cookie')?.split(';')[0];requireCondition(visitorStart.ok&&visitorCookie,'TEST_FAILED','生产构建未签发独立访客会话');
  const inbound={client_message_id:randomUUID(),body:'Production owned inquiry',display_name:'Synthetic visitor',client_sent_at:null};
  const visitorPost=()=>fetch(origin+'/api/public/chat/'+channel.id+'/messages',{method:'POST',headers:{Cookie:visitorCookie!,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(inbound)});
  const received=await visitorPost(),receivedBody=await received.json(),repeated=await visitorPost(),repeatedBody=await repeated.json();
  requireCondition(received.ok&&repeated.ok&&receivedBody.status==='STORED'&&receivedBody.message.id===repeatedBody.message.id,'TEST_FAILED','生产构建消息去重或持久确认失败');
  const inbox=await (await fetch(origin+'/api/inbox',{headers:{Cookie:cookie}})).json();const conversation=inbox.conversations.find((row:{id:string})=>row.id===receivedBody.message.conversation_id);
  requireCondition(conversation&&conversation.last_sequence===1&&conversation.channel_id===channel.id,'TEST_FAILED','生产构建未建立对应客户会话');
  const stranger=await fetch(origin+'/api/public/chat/'+channel.id+'/messages');requireCondition(stranger.status===401,'TEST_FAILED','访客历史未鉴权');
  const customer=await (await fetch(origin+'/api/customers/'+conversation.customer_id,{headers:{Cookie:cookie}})).json();requireCondition(customer.customer.first_inquiry_event_id===receivedBody.message.inbound_event_id&&customer.verified_payment===false,'TEST_FAILED','生产构建主数据来源不一致');
  await jsonPost('customers/'+conversation.customer_id+'/notes',{request_id:randomUUID(),text:'Owned synthetic production verification completed'});
  const product=await (await jsonPost('products',{request_id:randomUUID(),sku:'SMOKE-'+randomUUID().slice(0,8),name:'Owned synthetic service',currency:'USD',minor_unit_exponent:2,precision_source:'Synthetic currency fixture, two decimal places',unit_amount_minor:'1250',delivery_scope:'One synthetic report',terms:'Local verification only, no actual sale'})).json();
  await jsonPost('products/'+product.product_id+'/controls',{request_id:randomUUID(),expected_version:1,state:'ACTIVE',reason:'Reviewed synthetic product version'});
  const orderPreview=await (await jsonPost('order-previews',{request_id:randomUUID(),customer_id:conversation.customer_id,conversation_id:conversation.id,items:[{product_id:product.product_id,quantity:3}]})).json();
  const orderInput={request_id:randomUUID(),preview_id:orderPreview.id,preview_hash:orderPreview.snapshot_hash,confirmed_total_minor:'3750',currency:'USD',confirmation:'CREATE_THIS_ORDER'};
  const order=await (await jsonPost('orders',orderInput)).json(),orderReplay=await (await jsonPost('orders',orderInput)).json();requireCondition(order.id===orderReplay.id&&order.snapshot.total_minor==='3750'&&order.payment_state==='UNVERIFIED','TEST_FAILED','生产构建订单快照或重复确认错误');
  await jsonPost('orders/'+order.id+'/cancel',{request_id:randomUUID(),expected_version:1,reason:'Completed synthetic order verification'});
  await jsonPost('site-channels/'+channel.id+'/controls',{request_id:randomUUID(),expected_version:channel.version,state:'PAUSED',reason:'Completed synthetic production inbound verification'});
  await fetch(origin+'/api/public/chat/'+channel.id+'/end',{method:'POST',headers:{Cookie:visitorCookie!,Origin:origin,'Content-Type':'application/json'},body:'{}'});
  await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  console.log('Production smoke: existing auth/data/calendar checks, owned inquiry and customer, product activation, immutable order confirmation, duplicate receipt and order cancellation passed; no external actions.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(resolve, 5000); });
}
