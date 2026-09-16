import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {connectApifySource,importApifyDataset,providerWorkspace,controlProviderProspect,purgeExpiredProviderData} from '../../packages/core/src/acquisition-provider';
import type {ApifyDataset} from '../../packages/adapters/src/apify-dataset';
const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
const owner='u'.repeat(17),postRun='p'.repeat(17),commentRun='c'.repeat(17),sourceUrl='https://www.facebook.com/reel/123/';
beforeAll(async()=>{await migrate();await seed();});
beforeEach(async()=>{
  const db=(await query('SELECT current_database() AS name'))[0].name;
  if(db!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(db))throw new Error('Isolated database required');
  await query('TRUNCATE kff.acquisition_sources CASCADE');
  vi.stubEnv('APIFY_USER_ID',owner);vi.stubEnv('APIFY_API_TOKEN','test-token-not-real-123');
});
afterAll(async()=>{vi.unstubAllEnvs();await closePool();});
const dataset=(kind:ApifyDataset['kind']='FACEBOOK_POSTS'):ApifyDataset=>({owner_id:owner,run_id:kind==='FACEBOOK_POSTS'?postRun:commentRun,actor_id:'a'.repeat(17),dataset_id:'d'.repeat(17),kind,finished_at:new Date().toISOString(),usage_usd:0.01,input:kind==='FACEBOOK_POSTS'?{query:'八字测算'}:{startUrls:[{url:sourceUrl}]},rows:kind==='FACEBOOK_POSTS'?[{postId:'123',url:sourceUrl,postText:'了解五行八字测算',timestamp:Date.now(),author:{id:'456',name:'原发布者'}}]:[{commentId:'789',text:'PM',commentUrl:sourceUrl+'?comment_id=789',inputUrl:sourceUrl,profileId:'pfbidOpaque',profileName:'公开昵称',date:new Date().toISOString()}]});
async function source(){return connectApifySource(scope,(async()=>new Response(JSON.stringify({data:{id:owner,username:'test-source'}}))) as typeof fetch);}
async function ingest(sourceId:string,data=dataset()) {return importApifyDataset(scope,{source_id:sourceId,run_id:data.run_id,kind:data.kind,request_id:randomUUID(),retention_days:14},async()=>data);}
const workspace=()=>scoped(scope,providerWorkspace);
it('stores real provider data without any new Meta account and idempotently imports each run',async()=>{
  const count=(await query('SELECT count(*)::int AS n FROM kff.accounts'))[0].n;
  const s=await source();expect((await source()).id).toBe(s.id);
  const imported=await ingest(s.id);expect(imported.reused).toBe(false);
  expect((await ingest(s.id)).reused).toBe(true);
  await ingest(s.id,dataset('FACEBOOK_COMMENTS'));
  const ws=await workspace();expect(ws.totals).toEqual({posts:1,comments:1,profiles:1,qualified:0});expect(ws.imports).toHaveLength(2);
  const comment=ws.prospects.find(p=>p.kind==='COMMENT')!;expect(comment.score).toBe(45);expect(comment.search_keywords).toEqual(['八字测算']);expect(comment.profile_ref).toBe('pfbidOpaque');
  expect((await query('SELECT count(*)::int AS n FROM kff.accounts'))[0].n).toBe(count);
  expect((await query('SELECT count(*)::int AS n FROM kff.acquisition_action_links'))[0].n).toBe(0);
});
it('fences concurrent imports and preserves review state across a newer run',async()=>{
  const s=await source();const results=await Promise.all([ingest(s.id),ingest(s.id)]);expect(results.filter(r=>!r.reused)).toHaveLength(1);
  await ingest(s.id,dataset('FACEBOOK_COMMENTS'));const row=(await workspace()).prospects.find(p=>p.kind==='COMMENT')!;
  const request={request_id:randomUUID(),expected_version:row.version,state:'OPTED_OUT',reason:'记录已明确退出联系'};
  await controlProviderProspect(scope,row.id,request);expect((await controlProviderProspect(scope,row.id,request)).state).toBe('OPTED_OUT');
  const newer={...dataset('FACEBOOK_COMMENTS'),run_id:'n'.repeat(17)};await ingest(s.id,newer);
  expect((await workspace()).prospects.find(p=>p.id===row.id)?.state).toBe('OPTED_OUT');expect((await workspace()).totals.comments).toBe(1);
  const older={...dataset('FACEBOOK_COMMENTS'),run_id:'o'.repeat(17),finished_at:'2020-01-01T00:00:00.000Z'};older.rows[0].text='旧内容不可覆盖新记录';await ingest(s.id,older);
  expect((await workspace()).prospects.find(p=>p.id===row.id)?.body).toBe('PM');
});
it('isolates brands with RLS and blocks viewers and unrelated provider owners before writing',async()=>{
  const s=await source();await ingest(s.id);
  const other={...scope,brand_id:randomUUID()};expect((await scoped(other,providerWorkspace)).sources).toHaveLength(0);
  const reader=vi.fn(async()=>dataset());
  await expect(importApifyDataset(other,{source_id:s.id,run_id:commentRun,kind:'FACEBOOK_COMMENTS',request_id:randomUUID()},reader)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});expect(reader).not.toHaveBeenCalled();
  await expect(connectApifySource({...scope,role:'viewer'})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  const bad={...dataset('FACEBOOK_COMMENTS'),owner_id:'x'.repeat(17)};await expect(ingest(s.id,bad)).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
  const row=(await workspace()).prospects[0];await expect(controlProviderProspect({...scope,role:'viewer'},row.id,{request_id:randomUUID(),expected_version:1,state:'QUALIFIED',reason:'不允许只读角色写入'})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(scoped(other,c=>c.query("INSERT INTO kff.acquisition_sources(organization_id,brand_id,provider,provider_user_id,display_name,verified_at,created_by) VALUES($1,$2,'APIFY','forged','forged',now(),$3)",[scope.organization_id,scope.brand_id,scope.user_id]))).rejects.toMatchObject({code:'42501'});
});
it('rolls back the whole batch on error rows or out-of-scope links',async()=>{
  const s=await source();const failed=dataset();failed.rows.push({error:'provider failed'});
  await expect(ingest(s.id,failed)).rejects.toMatchObject({code:'SOURCE_ITEM_ERROR'});expect((await workspace()).imports).toHaveLength(0);
  const bad=dataset('FACEBOOK_COMMENTS');bad.rows[0].inputUrl='https://www.facebook.com/reel/999/';
  await expect(ingest(s.id,bad)).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});expect((await workspace()).totals.comments).toBe(0);
});
it('keeps unsupported comment topics unqualified and hides/purges expired personal data',async()=>{
  const s=await source();await ingest(s.id,dataset('FACEBOOK_COMMENTS'));const ws=await workspace();expect(ws.prospects[0].score).toBe(0);expect(ws.prospects[0].state).toBe('NEW');
  await query("UPDATE kff.acquisition_prospects SET expires_at=clock_timestamp()-interval '1 second'");
  expect((await workspace()).prospects).toHaveLength(0);expect(await purgeExpiredProviderData()).toBe(1);expect((await workspace()).imports).toHaveLength(1);
});
