import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import {leadScope as scope,leadAgent as agent,seedLead,seedDestination,clearLeads,claimLead,successReport,closeCommand,leadEvent} from '../helpers/lead-fixture';
import {updateLead,leadAnalytics,leadAudit,leadAuditCursor} from '../../packages/core/src/lead-management';
import {sendConversationReply,conversationControl,conversationReception,referralResult} from '../../packages/core/src/lead-reception';
import {claimReception,completeReception,receptionContext} from '../../packages/core/src/reception-worker';
import {injectFacebookFixture} from '../../packages/core/src/facebook-inbound';
import {beginSubmission} from '../../packages/core/src/execution';
import {localReceptionRules} from '../../packages/adapters/src/reception-model';
import {processReceptionOne} from '../../packages/core/src/reception-worker';
const day=new Date().toISOString().slice(0,10),filter={from:day,to:day,synthetic:'true' as const};
const input=(version:number)=>({request_id:randomUUID(),expected_version:version,lead_status:'QUALIFIED' as const,tags:['产品咨询','产品咨询'],intent_level:'HIGH' as const,valid_inquiry:true,reason:'Operator verified a product inquiry'});
beforeAll(async()=>{await migrate();await seed();});beforeEach(clearLeads);afterAll(closePool);
it('measures subsequent customer inquiries after confirmed AI replies without counting model suggestions as sends',async()=>{const lead=await seedLead({event:{body:'Hello'}});await processReceptionOne();expect((await leadAnalytics(scope,filter)).outcomes).toEqual([]);const command=await claimLead();await beginSubmission(agent,command.id);await closeCommand(command,successReport(command));await injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page,{body:'Tell me about this product'}));expect((await leadAnalytics(scope,filter)).outcomes[0]).toMatchObject({actor_kind:'AI',replies:1,customers:1,subsequent_inquiries:1});});
it('applies explicit exit before any model job and blocks immediate human sends',async()=>{const lead=await seedLead({event:{body:'Do not contact me again'}});expect((await query('SELECT lead_status,stage FROM kff.customers WHERE id=$1',[lead.customer_id]))[0]).toMatchObject({lead_status:'BLOCKED',stage:'OPTED_OUT'});expect((await query("SELECT count(*)::int AS n FROM kff.jobs WHERE kind='RECEPTION'"))[0].n).toBe(0);await expect(sendConversationReply(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:2,body:'Still sending',refer_whatsapp:false,fixture_scenario:'normal'})).rejects.toMatchObject({code:'LEAD_STOPPED'});});
it('preserves lead edits idempotently, fences stale AI and records who changed classification',async()=>{const lead=await seedLead(),claim=(await claimReception())!,decision=await localReceptionRules.decide(await receptionContext(claim)),customer=(await query('SELECT version FROM kff.customers WHERE id=$1',[lead.customer_id]))[0];const value=input(customer.version);const result=await updateLead(scope,lead.customer_id,value);expect(result).toMatchObject({tags:['产品咨询'],intent_level:'HIGH',valid_inquiry:true});expect(JSON.parse(JSON.stringify(await updateLead(scope,lead.customer_id,value)))).toEqual(JSON.parse(JSON.stringify(result)));expect(await completeReception(claim,decision,'LOCAL_RULES')).toMatchObject({status:'STALE'});expect((await leadAudit(scope)).events.some(row=>row.event_type==='lead.updated'&&row.actor_id===scope.user_id)).toBe(true);await expect(updateLead(scope,lead.customer_id,{...value,tags:[]})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});});
it('counts distinct valid customers, excludes pending sends and separates account and synthetic cohorts',async()=>{await seedDestination();const a=await seedLead({auto_reply:false}),b=await seedLead({auto_reply:false}),c=await seedLead({auto_reply:false});for(const lead of[a,b]){const row=(await query('SELECT version FROM kff.customers WHERE id=$1',[lead.customer_id]))[0];await updateLead(scope,lead.customer_id,input(row.version));}for(const [lead,version]of[[a,2],[c,1],[b,2]] as const){await sendConversationReply(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:version,body:'',refer_whatsapp:true,fixture_scenario:'normal'});if(lead!==b){const command=await claimLead();await beginSubmission(agent,command.id);await closeCommand(command,successReport(command));}}const total=(await leadAnalytics(scope,filter)).metrics.find(row=>row.group_kind==='TOTAL')!;expect(total).toMatchObject({new_customers:3,valid_inquiries:2,referred_valid_customers:1,conversion_rate:0.5,inbound_messages:3,referrals:2,human_replies:2});const scopedTotal=(await leadAnalytics(scope,{...filter,account_id:a.account_id})).metrics.find(row=>row.group_kind==='TOTAL')!;expect(scopedTotal).toMatchObject({new_customers:1,referrals:1,conversion_rate:1});expect((await leadAnalytics(scope,{...filter,synthetic:'false'})).metrics[0]).toMatchObject({new_customers:0,referrals:0,conversion_rate:null});});
it('separates actual contact from sent invitations and exposes versioned template/source evidence',async()=>{await seedDestination();const lead=await seedLead({auto_reply:false});await sendConversationReply(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:1,body:'',refer_whatsapp:true,fixture_scenario:'normal'});const command=await claimLead();await beginSubmission(agent,command.id);await closeCommand(command,successReport(command));let report=await leadAnalytics(scope,filter);expect(report.templates[0]).toMatchObject({sent:1,confirmed:0,source:'MESSENGER',actor_kind:'HUMAN',destination_version:1});const row=(await conversationReception(scope,lead.conversation_id)).referrals[0];await referralResult(scope,row.id,{request_id:randomUUID(),expected_version:row.version,result:'CONFIRMED',reason:'Sales verified contact on WhatsApp'});report=await leadAnalytics(scope,filter);expect(report.metrics.find(row=>row.group_kind==='TOTAL')).toMatchObject({referrals:1,confirmed:1,conversion_rate:null});expect(report.templates[0].confirmed).toBe(1);});
it('counts comment origins separately from private messages and manual handovers',async()=>{const lead=await seedLead();await injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page,{kind:'COMMENT',body:'Interested',source:{kind:'COMMENT',page_id:lead.page,source_id:'post_comment',ref:'post',ad_id:null}}));await conversationControl(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:1,mode:'HUMAN',reason:'Human follow-up'});const report=await leadAnalytics(scope,filter);expect(report.metrics.find(row=>row.group_kind==='TOTAL')).toMatchObject({new_customers:2,inbound_messages:1,handoffs:1});expect(report.metrics.filter(row=>row.group_kind==='SOURCE').map(row=>row.source).sort()).toEqual(['COMMENT','MESSENGER']);});
it('isolates reporting, edits and audit by brand and keeps records immutable',async()=>{const lead=await seedLead(),other={...scope,brand_id:randomUUID()};expect((await leadAnalytics(other,filter)).metrics[0].new_customers).toBe(0);expect((await leadAudit(other)).events).toHaveLength(0);await expect(updateLead({...scope,role:'viewer'},lead.customer_id,input(2))).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(updateLead(other,lead.customer_id,input(2))).rejects.toMatchObject({code:'NOT_FOUND'});await expect(scoped(scope,client=>client.query("UPDATE kff.audit_events SET details='{}' WHERE object_id=$1",[lead.event_id]))).rejects.toThrow();});
it('bounds account intake while duplicate retry returns its original receipt',async()=>{const saved=process.env.KFF_FACEBOOK_EVENTS_PER_MINUTE;process.env.KFF_FACEBOOK_EVENTS_PER_MINUTE='1';try{const lead=await seedLead();expect(await injectFacebookFixture(scope,lead.account_id,lead.event)).toMatchObject({duplicate:true});await expect(injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page))).rejects.toMatchObject({code:'RATE_LIMITED'});expect((await query('SELECT count(*)::int AS n FROM kff.messages'))[0].n).toBe(1);}finally{if(saved===undefined)delete process.env.KFF_FACEBOOK_EVENTS_PER_MINUTE;else process.env.KFF_FACEBOOK_EVENTS_PER_MINUTE=saved;}});
// A page is ordered by (created_at DESC, id DESC). Paging only by `created_at < before` drops every
// record that shares the boundary timestamp, which is exactly what a single transaction producing
// more than one page of events looks like. The position cursor has to carry both keys.
it('pages same-timestamp audit events without dropping or repeating any',async()=>{
 const stamp=new Date().toISOString(),ids:string[]=[];
 for(let index=0;index<201;index++){
  const id=randomUUID();
  await query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details,created_at) VALUES($1,$2,$3,'lead.pagination_probe',$4,'{}'::jsonb,$5)",[scope.organization_id,scope.brand_id,scope.user_id,id,stamp]);
  ids.push(id);
 }
 const first=await leadAudit(scope,'');
 // The whole probe window shares one timestamp, so a time-only cursor would stop after the first
 // page with the rest unreachable. Walk the cursor to the end instead of assuming a page count.
 expect(first.events).toHaveLength(200);
 expect(first.next_cursor).toBeTruthy();
 expect(first.cursor_kind).toBe('POSITION');
 const pages=[first]; let cursor=first.next_cursor;
 // Other tests in this file keep writing audit events, so a listing read page by page can overlap;
 // that is inherent to keyset paging and not what this test is about. The property that matters is
 // that the boundary timestamp never hides a record.
 while(cursor&&pages.length<12){const next=await leadAudit(scope,cursor);pages.push(next);cursor=next.next_cursor;}
 const seen=pages.flatMap(page=>page.events).map(row=>row.object_id);
 const probeSeen=seen.filter(id=>ids.includes(id));
 // Every one of the 201 same-timestamp records is reachable, exactly once.
 expect([...probeSeen].sort()).toEqual([...ids].sort());
 expect(new Set(probeSeen).size).toBe(ids.length);
 // More than one page was required, and the walk terminated instead of looping forever.
 expect(pages.length).toBeGreaterThan(1);
 expect(pages.at(-1)!.next_cursor).toBeNull();
 // Walking the *final* page's own cursor returns nothing: the listing has a real end.
 const beyond=await leadAudit(scope,leadAuditCursor(pages.at(-1)!.events.at(-1)!));
 expect(beyond.events).toHaveLength(0);
});
// The old `before` timestamp still works, and is reported as the time-only boundary it is.
it('keeps the legacy timestamp cursor working and labels its boundary',async()=>{
 const stamp=new Date(Date.now()-3600000).toISOString(),ids:string[]=[];
 for(let index=0;index<3;index++){const id=randomUUID();await query("INSERT INTO kff.audit_events(organization_id,brand_id,actor_id,event_type,object_id,details,created_at) VALUES($1,$2,$3,'lead.pagination_probe',$4,'{}'::jsonb,$5)",[scope.organization_id,scope.brand_id,scope.user_id,id,stamp]);ids.push(id);}
 const legacy=await leadAudit(scope,new Date(Date.now()-1800000).toISOString());
 expect(legacy.cursor_kind).toBe('LEGACY_TIMESTAMP');
 expect(legacy.cursor_limited).toBe(true);
 expect(legacy.events.map(row=>row.object_id).sort()).toEqual([...ids].sort());
 // A malformed cursor is refused rather than restarting the listing from the newest record.
 await expect(leadAudit(scope,'not-a-timestamp')).rejects.toThrow();
 // Cross-brand reads stay blocked: another brand sees none of these events.
 expect((await leadAudit({...scope,brand_id:randomUUID()})).events).toHaveLength(0);
});
