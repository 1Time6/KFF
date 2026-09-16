import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {query,scoped,closePool} from '@kff/database';
import {leadScope as scope,seedLead,clearLeads,leadEvent} from '../helpers/lead-fixture';
import {requestReceptionDraft,validateReceptionDraft} from '../../packages/core/src/reception-drafts';
import {claimReception,completeReception,receptionContext,processReceptionOne,configureReceptionPolicy} from '../../packages/core/src/reception-worker';
import {conversationControl,conversationReception,sendConversationReply,messageSubmissionGate} from '../../packages/core/src/lead-reception';
import {injectFacebookFixture} from '../../packages/core/src/facebook-inbound';
import {localReceptionRules} from '../../packages/adapters/src/reception-model';
import {receptionPolicy} from '../../packages/contracts/src/lead';
import {setAccountPause} from '../../packages/core/src/controls';

beforeAll(async()=>{await migrate();await seed();});beforeEach(clearLeads);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(closePool);
const current=async(id:string)=>(await query<{id:string;account_id:string;control_version:number;last_inbound_sequence:number;last_answered_sequence:number;handling_mode:string}>('SELECT * FROM kff.conversations WHERE id=$1',[id]))[0];
async function setup(){const lead=await seedLead({auto_reply:false,event:{body:'Hello'},policy:{min_reply_interval_seconds:0}});let c=await current(lead.conversation_id);if(c.handling_mode!=='HUMAN'){await conversationControl(scope,c.id,{request_id:randomUUID(),expected_version:c.control_version,mode:'HUMAN',reason:'Isolated draft review'});c=await current(c.id);}return {...lead,control_version:c.control_version};}
async function ready(){const lead=await setup(),result=await requestReceptionDraft(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:lead.control_version});await processReceptionOne();return {...lead,job_id:result.job_id};}
const input=(lead:Awaited<ReturnType<typeof ready>>,patch:Record<string,unknown>={})=>({request_id:randomUUID(),expected_version:lead.control_version,body:'Human edited and approved suggestion',refer_whatsapp:false,draft_job_id:lead.job_id,...patch});
it('generates a reviewable suggestion through the existing queue, with no task or customer mutation, and replays requests',async()=>{
  const lead=await setup(),c=await current(lead.conversation_id),customer=(await query('SELECT * FROM kff.customers WHERE id=$1',[lead.customer_id]))[0],value={request_id:randomUUID(),expected_version:lead.control_version};
  const result=await requestReceptionDraft(scope,c.id,value);expect(await requestReceptionDraft(scope,c.id,value)).toEqual(result);await processReceptionOne();
  expect((await query('SELECT * FROM kff.customers WHERE id=$1',[lead.customer_id]))[0]).toEqual(customer);expect(await current(c.id)).toEqual(c);
  expect((await query('SELECT count(*)::int n FROM kff.tasks'))[0].n).toBe(0);
  const reception=await conversationReception(scope,c.id);expect(reception.jobs).toHaveLength(1);expect(reception.jobs[0]).toMatchObject({draft_only:true,draft_usable:true,state:'DONE',result:{status:'DRAFT_READY',model:'LOCAL_RULES'}});
  await expect(requestReceptionDraft(scope,c.id,{...value,expected_version:value.expected_version+1})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it.each(['takeover','inbound','stop-resume','expiry'] as const)('discards a late draft after %s without changing conversation control',async change=>{
  const lead=await setup();await requestReceptionDraft(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:lead.control_version});
  const claim=(await claimReception())!,decision=await localReceptionRules.decide(await receptionContext(claim));
  if(change==='takeover')await conversationControl(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:lead.control_version,mode:'HUMAN',reason:'Another operator takes over'});
  if(change==='inbound')await injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page,{body:'Actually, a different question'}));
  if(change==='stop-resume'){await setAccountPause(scope,lead.account_id,true,'Draft test pause');await setAccountPause(scope,lead.account_id,false,'Draft test resume');}
  if(change==='expiry')vi.spyOn(Date,'now').mockReturnValue(Date.now()+21*60000);
  const c=await current(lead.conversation_id);expect(await completeReception(claim,decision,'LOCAL_RULES')).toMatchObject({status:'STALE'});expect(await current(c.id)).toEqual(c);expect((await query('SELECT count(*)::int n FROM kff.tasks'))[0].n).toBe(0);
});
it('pins human adoption and the edited body to the original task, then fences new inbound messages',async()=>{
  const lead=await ready(),value=input(lead),queued=await sendConversationReply(scope,lead.conversation_id,value);expect(await sendConversationReply(scope,lead.conversation_id,value)).toEqual(queued);
  const task=(await query('SELECT * FROM kff.tasks WHERE id=$1',[queued.task_id]))[0];expect(task.snapshot.body).toBe(value.body);expect(task.snapshot.message).toMatchObject({actor_kind:'HUMAN',control_version:lead.control_version+1,draft:{job_id:lead.job_id,model:'LOCAL_RULES'}});
  await scoped(scope,client=>messageSubmissionGate(client,task.snapshot,queued.action_id));
  await injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page,{body:'This is my latest message'}));
  await expect(scoped(scope,client=>messageSubmissionGate(client,task.snapshot,queued.action_id))).rejects.toMatchObject({code:'INBOUND_SUPERSEDED'});
});
it('refuses foreign, expired and delayed-beyond-expiry suggestions before creating a task',async()=>{
  const a=await ready(),b=await ready();await expect(sendConversationReply(scope,b.conversation_id,input(b,{draft_job_id:a.job_id}))).rejects.toMatchObject({code:'DRAFT_STALE'});
  await expect(sendConversationReply(scope,a.conversation_id,input(a,{delay_minutes:30}))).rejects.toMatchObject({code:'DRAFT_STALE'});
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+21*60000);
  await expect(sendConversationReply(scope,a.conversation_id,input(a))).rejects.toMatchObject({code:'DRAFT_STALE'});
  expect((await query('SELECT count(*)::int n FROM kff.tasks'))[0].n).toBe(0);expect((await current(a.conversation_id)).control_version).toBe(a.control_version);
});
it('fails a provider once without auto retry or changing human control',async()=>{
  const lead=await setup();await requestReceptionDraft(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:lead.control_version});const before=await current(lead.conversation_id);
  await processReceptionOne({name:'Isolated failing provider',async decide(){throw new Error('Fixture unavailable');}});
  expect((await query("SELECT state,attempts,result FROM kff.jobs WHERE kind='RECEPTION'"))[0]).toMatchObject({state:'DEAD',attempts:1,result:{status:'DRAFT_FAILED'}});expect(await processReceptionOne()).toBe(false);expect(await current(lead.conversation_id)).toEqual(before);
});
it('keeps handoff advice as advice and rejects viewer or paused-conversation requests',async()=>{
  const lead=await setup();await injectFacebookFixture(scope,lead.account_id,leadEvent(lead.page,{body:'I need a human agent'}));const c=await current(lead.conversation_id),value={request_id:randomUUID(),expected_version:c.control_version};
  await expect(requestReceptionDraft({...scope,role:'viewer'},c.id,value)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  const draft=await requestReceptionDraft(scope,c.id,value);await processReceptionOne();await expect(scoped(scope,client=>validateReceptionDraft(client,draft.job_id,c))).rejects.toMatchObject({code:'DRAFT_NOT_REPLY'});
  expect((await current(c.id)).handling_mode).toBe('HUMAN');await conversationControl(scope,c.id,{request_id:randomUUID(),expected_version:c.control_version,mode:'PAUSED',reason:'Pause this draft test'});
  await expect(requestReceptionDraft(scope,c.id,{request_id:randomUUID(),expected_version:c.control_version+1})).rejects.toMatchObject({code:'DRAFT_UNAVAILABLE'});
});

it('reports missing AI configuration without queuing or silently generating a rules draft',async()=>{
  const lead=await setup();for(const key of ['KFF_RECEPTION_AI_URL','KFF_RECEPTION_AI_KEY','KFF_RECEPTION_AI_MODEL'])vi.stubEnv(key,'');
  const connection=(await query('SELECT version FROM kff.facebook_connections WHERE account_id=$1',[lead.account_id]))[0];
  await configureReceptionPolicy(scope,{request_id:randomUUID(),account_id:lead.account_id,expected_version:connection.version,policy:receptionPolicy.parse({provider:'OPENAI_COMPATIBLE'})});
  await expect(requestReceptionDraft(scope,lead.conversation_id,{request_id:randomUUID(),expected_version:lead.control_version})).rejects.toMatchObject({code:'AI_NOT_CONFIGURED'});
  expect((await query("SELECT count(*)::int n FROM kff.jobs WHERE kind='RECEPTION'"))[0].n).toBe(0);
  expect((await conversationReception(scope,lead.conversation_id)).drafting).toMatchObject({provider:'OPENAI_COMPATIBLE',configured:false,unanswered:true});
});
