import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { seed, localIds } from '../../scripts/seed';
import { query, closePool, projectRoot } from '@kff/database';
import type { AgentCommand, ActionReport } from '@kff/contracts';
import { digest } from '@kff/core';
import { leadScope as scope, leadAgent as agent, clearLeads } from '../helpers/lead-fixture';
import { createAccount, createEnvironment, createTask } from '../../packages/core/src/service';
import { configureEnvironment } from '../../packages/core/src/environments';
import { createMonitor, controlMonitor, projectDiscoveryLeads, prepareDiscoveryScan } from '../../packages/core/src/acquisition';
import { configureBudget } from '../../packages/core/src/costs';
import { attachLocalEvidence } from '../../packages/core/src/capabilities';
import { adapterImplementationDigest } from '../../packages/core/src/artifacts';
import { prepareBrowserCollectionPage } from '../../packages/core/src/browser-collections';
import { dispatchOne, claimCommand, acceptReport, agentHeartbeat } from '../../packages/core/src/execution';
import {deriveCommentMonitors} from '../../packages/core/src/acquisition-continuation';
import {closeCommand} from '../helpers/lead-fixture';
import { collectionDetail } from '../../packages/core/src/collections';

const original = { discovery: process.env.KFF_ENABLE_DISCOVERY, live: process.env.KFF_ENABLE_LIVE };
beforeAll(async () => { await migrate(); await seed(); });
beforeEach(async () => {
  await clearLeads();
  await query('TRUNCATE kff.acquisition_monitors,kff.collection_queries,kff.collection_objects,kff.cost_budgets CASCADE');
  process.env.KFF_ENABLE_LIVE = 'false'; process.env.KFF_ENABLE_DISCOVERY = 'true';
  await configureBudget(scope, { request_id: randomUUID(), expected_version: 0, currency: 'USD', minor_unit_exponent: 2, precision_source: 'Isolated test currency', limit_minor: '0', reason: 'Zero-cost local browser read contract' });
});
afterAll(async () => { for (const [key, value] of [['KFF_ENABLE_DISCOVERY',original.discovery],['KFF_ENABLE_LIVE',original.live]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } await closePool(); });
async function setup(attach = true, comments = false, maxAgeDays?:number, pageSource = false, continuation = false) {
  const account = await createAccount(scope, { display_name: 'Test personal profile, no platform call', external_id: BigInt('0x' + randomUUID().replaceAll('-','')).toString(), platform: 'facebook', account_type: 'profile' });
  const environment = await createEnvironment(scope, { name: 'Isolated browser test', account_id: account.id, agent_id: localIds.agent });
  await configureEnvironment(scope, environment.id, { expected_version: 1, configuration: { driver: 'native', provider_profile_id: null, login_account_id: account.external_id, operating_identity_id: account.external_id, locale: 'en-US', timezone_id: 'UTC', proxy_ref: null } });
  const monitor = await createMonitor(scope, { request_id: randomUUID(), title: 'Read contract only', account_id: account.id, discovery: { platform: 'facebook', strategy: pageSource ? 'PAGE' : comments ? 'COMMENTS' : 'KEYWORD', provider: 'LOCAL_BROWSER', keywords: ['八字测算'], ...(maxAgeDays===undefined?{}:{max_age_days:maxAgeDays}), target: pageSource ? 'https://www.facebook.com/000123456/' : comments ? 'https://www.facebook.com/local.author/posts/pfbid0123456789abcdef/' : '', processing_basis: 'Isolated contract data; no live platform calls.', browser: { environment_id: environment.id, template: pageSource ? 'facebook-page-dom-v1' : comments ? 'facebook-comments-dom-v1' : 'facebook-search-dom-v1' } }, ...(continuation?{comment_continuation:{allowed_source_types:['POST','REEL'],max_sources_per_scan:1,max_sources_total:2,source_lifetime_hours:24,comment_order:'VISIBLE_WINDOW'}}:{}), interval_minutes: 60, max_records: 2, max_pages: 1, page_size: 2, retention_days: 1 });
  const capability = (await query('SELECT * FROM kff.capabilities WHERE account_id=$1', [account.id]))[0];
  if (attach) {
    // Test-only artifact registration in a random isolated database; never production evidence.
    const hash = adapterImplementationDigest(projectRoot,'facebook');
    await query("INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,'facebook-graph-v1','{}',1,'ISOLATED CONTRACT FIXTURE',now(),'{\"synthetic_test\":true}') ON CONFLICT DO NOTHING", [hash]);
    await attachLocalEvidence(scope, capability.id);
  }
  if(continuation){await controlMonitor(scope,monitor.id,{request_id:randomUUID(),expected_version:1,action:'START',reason:'Start isolated continuation'});monitor.version=2;}
  const scan = await controlMonitor(scope, monitor.id, { request_id: randomUUID(), expected_version: monitor.version, action: 'SCAN', reason: 'Explicit bounded read query' }) as { id: string; run_id: string };
  return { account, environment, monitor, capability, scan };
}
function report(command: AgentCommand): ActionReport {
  const read = command.snapshot.collection!;
  const page = { schema_version: 'kff.collection-page.v1' as const, source_key: 'social.discovery' as const, source_version: 'social-discovery-v1' as const, query_id: read.query_id, account_external_id: command.snapshot.external_account_id, cursor: read.cursor, next_cursor: 'contract-next-page', observed_at: new Date().toISOString(), reported_total: null, coverage: 'BROWSER_VISIBLE_ONLY' as const, rows: [{ source_object_id: 'facebook:reel:123', source_url: 'https://www.facebook.com/reel/123/', fields: Object.fromEntries(read.snapshot.fields.map(field => [field, { kind: 'NOT_RETURNED' as const }])) }] };
  return { event_id: randomUUID(), command_id: command.id, outcome: 'VERIFIED_SUCCEEDED', collection_page: page, receipt: { remote_id: 'collection:' + read.run_id + ':1', actual_account_id: command.snapshot.external_account_id, content_hash: digest(page), observed_at: page.observed_at, evidence_kind: 'browser_dom' }, diagnostic: { step: 'isolated-contract-only' } };
}
it('dispatches through the original permit and Agent queue with discovery enabled and all writes disabled', async () => {
  const context = await setup();
  const task = await prepareBrowserCollectionPage(); expect(task).not.toBeNull();
  expect(task!.snapshot).toMatchObject({ capability_key: 'facebook.discovery.read.browser', mode: 'CONTROLLED_PILOT', credential_ref: null, platform_api_version: null, is_synthetic: false, browser_environment: { account_type: 'profile' } });
  const permit = (await query('SELECT * FROM kff.pilot_permits WHERE task_id=$1', [task!.id]))[0];
  expect(permit).toMatchObject({ access_path: 'browser_read', max_actions: 1, max_cost_minor: '0', expected_evidence: 'collection_page' });
  await expect(query("UPDATE kff.pilot_permits SET access_path='api' WHERE id=$1", [permit.id])).rejects.toThrow('IMMUTABLE_PILOT_SCOPE');
  expect(await dispatchOne()).toBe(true); const command = (await claimCommand(agent))!; expect(command).not.toBeNull();
  const received = report(command);
  await expect(acceptReport(agent, { ...received, receipt: { ...received.receipt!, evidence_kind: 'graph_object' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await acceptReport(agent, received);
  expect((await collectionDetail(scope, context.scan.id)).run).toMatchObject({ state: 'PARTIAL', committed_pages: 1, stop_reason: 'MAX_PAGES' });
  expect((await query('SELECT reserved_actions,reserved_cost_minor FROM kff.pilot_permits WHERE id=$1', [permit.id]))[0]).toEqual({ reserved_actions: 1, reserved_cost_minor: '0' });
});
it('ingests fixed-post comment receipts through the original read permit and rejects another parent', async () => {
  const context = await setup(true, true,7);
  const task = await prepareBrowserCollectionPage(); expect(task).not.toBeNull();
  expect(await dispatchOne()).toBe(true); const command = (await claimCommand(agent))!;
  const received = report(command), target = context.monitor.config.discovery.target;
  const row = received.collection_page!.rows[0];
  row.source_object_id = 'facebook:comment:000123'; row.source_url = target + '?comment_id=000123';
  row.fields.message={kind:'VALUE',value:'八字测算，我需要了解'};
  row.fields.created_time={kind:'DISPLAYED_TIME',value:'2026年7月30日周四15:19'};
  received.receipt!.content_hash = digest(received.collection_page);
  const wrong = structuredClone(received); wrong.collection_page!.rows[0].source_url = target.replace('local.author','wrong.author') + '?comment_id=000123'; wrong.receipt!.content_hash = digest(wrong.collection_page);
  await expect(acceptReport(agent, wrong)).rejects.toMatchObject({ code: 'COLLECTION_SOURCE_MISMATCH' });
  await acceptReport(agent, received);
  expect((await collectionDetail(scope, context.scan.id)).run).toMatchObject({ state: 'PARTIAL', committed_pages: 1 });
  expect((await collectionDetail(scope,context.scan.id)).results[0].fields.created_time).toEqual(row.fields.created_time);
  await projectDiscoveryLeads();expect((await query('SELECT count(*)::int n FROM kff.acquisition_leads'))[0].n).toBe(0);
  expect((await query('SELECT score,reason FROM kff.acquisition_evaluations'))[0]).toMatchObject({score:0,reason:expect.stringContaining('原始发布时间已超出最近 7 天')});
  expect((await query('SELECT access_path FROM kff.pilot_permits WHERE task_id=$1',[task!.id]))[0].access_path).toBe('browser_read');
});
it('fails unregistered implementations and disabled discovery before delivering a browser command', async () => {
  const first = await setup(false);
  expect(await prepareBrowserCollectionPage()).toBeNull();
  expect((await collectionDetail(scope, first.scan.id)).run).toMatchObject({ state: 'FAILED', error_code: 'CAPABILITY_UNASSESSED' });
  const second = await setup(); process.env.KFF_ENABLE_DISCOVERY = 'false';
  expect(await prepareBrowserCollectionPage()).toBeNull();
  expect((await collectionDetail(scope, second.scan.id)).run).toMatchObject({ state: 'FAILED', error_code: 'LIVE_DISABLED' });
  expect(await claimCommand(agent)).toBeNull();
});
it('keeps Page observations in the original read queue and refuses an unverified publisher', async () => {
  const context = await setup(true, false, undefined, true);
  const task = await prepareBrowserCollectionPage(); expect(task?.snapshot.collection?.snapshot.discovery?.strategy).toBe('PAGE');
  expect(await dispatchOne()).toBe(true); const command = (await claimCommand(agent))!;
  const received = report(command), row = received.collection_page!.rows[0];
  row.source_object_id = 'facebook:post:pfbid0123456789abcdef'; row.source_url = 'https://www.facebook.com/permalink.php?story_fbid=pfbid0123456789abcdef&id=000123456';
  row.fields.author_id = { kind: 'VALUE', value: '000123456' }; row.fields.message = { kind: 'VALUE', value: '八字测算服务。我们提供咨询，欢迎私信我们预约。' }; row.fields.created_time = { kind: 'DISPLAYED_TIME', value: '5天' };
  received.receipt!.content_hash = digest(received.collection_page);
  const wrong = structuredClone(received); wrong.collection_page!.rows[0].fields.author_id = { kind: 'VALUE', value: '999' }; wrong.receipt!.content_hash = digest(wrong.collection_page);
  await expect(acceptReport(agent, wrong)).rejects.toMatchObject({ code: 'COLLECTION_SOURCE_MISMATCH' });
  await acceptReport(agent, received);
  const detail = await collectionDetail(scope, context.scan.id); expect(detail.run).toMatchObject({ state: 'PARTIAL', committed_pages: 1 }); expect(detail.results[0].fields.created_time).toEqual(row.fields.created_time);
  await projectDiscoveryLeads(); expect((await query('SELECT count(*)::int n FROM kff.acquisition_leads'))[0].n).toBe(0);
  expect((await query('SELECT access_path FROM kff.pilot_permits WHERE task_id=$1', [task!.id]))[0].access_path).toBe('browser_read');
});
it('rejects generic task creation and discards a real-scope contract page after the monitor is paused', async () => {
  const context = await setup();
  await expect(createTask(scope, { title: 'Missing collection', account_id: context.account.id, environment_id: context.environment.id, capability_id: context.capability.id, body: '', mode: 'CONTROLLED_PILOT', fixture_scenario: 'normal', idempotency_key: randomUUID() })).rejects.toThrow();
  expect(await prepareBrowserCollectionPage()).not.toBeNull(); expect(await dispatchOne()).toBe(true);
  const command = (await claimCommand(agent))!;
  await controlMonitor(scope, context.monitor.id, { request_id: randomUUID(), expected_version: 1, action: 'PAUSE', reason: 'Stop this bounded query now' });
  expect((await agentHeartbeat(agent, command.id)).continue).toBe(false);
  await acceptReport(agent, report(command));
  expect((await collectionDetail(scope, context.scan.id)).results).toHaveLength(0);
});

async function discoveredSources(){
  const context=await setup(true,false,7,false,true);
  await prepareBrowserCollectionPage();expect(await dispatchOne()).toBe(true);
  const command=(await claimCommand(agent))!,received=report(command);
  const page=received.collection_page!;
  const stamp=new Date(Date.now()-2*86400000),label=stamp.getUTCFullYear()+'年'+(stamp.getUTCMonth()+1)+'月'+stamp.getUTCDate()+'日12:00';
  page.next_cursor=null;
  page.rows=['123','456'].map(id=>({source_object_id:'facebook:reel:'+id,source_url:'https://www.facebook.com/reel/'+id+'/',fields:{message:{kind:'VALUE',value:'八字测算，请问如何查询'},author_id:{kind:'NOT_RETURNED'},created_time:{kind:'DISPLAYED_TIME',value:label},reaction_count:{kind:'NOT_RETURNED'},comment_count:{kind:'NOT_RETURNED'}}}));
  received.receipt!.content_hash=digest(page);await closeCommand(command,received);
  return context;
}
it('derives one bounded source through the original worker queue, deduplicates, and pauses children with the parent',async()=>{
  const context=await discoveredSources();
  const results=await Promise.all([deriveCommentMonitors(),deriveCommentMonitors()]);expect(results.reduce((a,b)=>a+b,0)).toBe(1);
  const child=(await query('SELECT * FROM kff.acquisition_monitors WHERE parent_monitor_id=$1',[context.monitor.id]))[0];
  expect(child).toMatchObject({account_id:context.account.id,state:'ACTIVE',parent_monitor_version:2,automation:null});
  expect(child.config.discovery).toMatchObject({strategy:'COMMENTS',browser:{environment_id:context.environment.id,template:'facebook-comments-dom-v1',comment_order:'VISIBLE_WINDOW'}});
  expect(child.config.comment_continuation).toBeUndefined();expect(child.config.max_pages).toBe(1);
  expect(await prepareDiscoveryScan()).not.toBeNull();
  const task=await prepareBrowserCollectionPage();expect(task!.snapshot.collection!.snapshot.discovery!.target).toBe(child.derived_source_url);
  expect(await dispatchOne()).toBe(true);const commentCommand=(await claimCommand(agent))!,commentReport=report(commentCommand);
  const commentPage=commentReport.collection_page!;commentPage.next_cursor=null;
  const stamp=new Date(Date.now()-2*86400000);
  commentPage.rows=[{source_object_id:'facebook:comment:987',source_url:child.derived_source_url+'?comment_id=987',fields:{message:{kind:'VALUE',value:'八字测算，我需要咨询'},author_id:{kind:'NOT_RETURNED'},created_time:{kind:'DISPLAYED_TIME',value:stamp.getUTCFullYear()+'年'+(stamp.getUTCMonth()+1)+'月'+stamp.getUTCDate()+'日12:00'},comment_count:{kind:'NOT_RETURNED'},reaction_count:{kind:'NOT_RETURNED'}}}];
  commentReport.receipt!.content_hash=digest(commentPage);await closeCommand(commentCommand,commentReport);await projectDiscoveryLeads();
  expect((await query('SELECT state,score FROM kff.acquisition_leads WHERE monitor_id=$1',[child.id]))[0]).toEqual({state:'NEW',score:75});
  await controlMonitor(scope,child.id,{request_id:randomUUID(),expected_version:1,action:'SCAN',reason:'Next child scan for pause fence'});
  const pending=await prepareBrowserCollectionPage();expect(pending).not.toBeNull();
  await controlMonitor(scope,context.monitor.id,{request_id:randomUUID(),expected_version:2,action:'PAUSE',reason:'Stop parent and all children'});
  expect((await query('SELECT state FROM kff.acquisition_monitors WHERE id=$1',[child.id]))[0].state).toBe('PAUSED');
  expect((await query('SELECT state FROM kff.collection_runs WHERE browser_task_id=$1',[pending!.id]))[0].state).toBe('CANCELED');
  await expect(controlMonitor(scope,child.id,{request_id:randomUUID(),expected_version:2,action:'SCAN',reason:'Must not bypass parent pause'})).rejects.toMatchObject({code:'SOURCE_CONTINUATION_STOPPED'});
  expect(await deriveCommentMonitors()).toBe(0);
  await controlMonitor(scope,context.monitor.id,{request_id:randomUUID(),expected_version:3,action:'START',reason:'Restart does not revive old children'});
  expect(await deriveCommentMonitors()).toBe(0);
});
it('expires derived sources without recreating them or reusing failed/paused parent evidence',async()=>{
  const context=await discoveredSources();expect(await deriveCommentMonitors()).toBe(1);
  await query("UPDATE kff.acquisition_monitors SET derived_expires_at=clock_timestamp()-interval '1 minute' WHERE parent_monitor_id=$1",[context.monitor.id]);
  expect(await deriveCommentMonitors()).toBe(0);
  expect((await query('SELECT state FROM kff.acquisition_monitors WHERE parent_monitor_id=$1',[context.monitor.id]))[0].state).toBe('PAUSED');
  expect(await prepareDiscoveryScan()).toBeNull();
});
