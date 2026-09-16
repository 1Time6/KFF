import {createHmac,randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,closePool} from '@kff/database';
import {leadScope as scope,clearLeads,seedLead} from '../helpers/lead-fixture';
import {createAccount,createEnvironment,enqueueTask} from '../../packages/core/src/service';
import {configureFacebook,receiveFacebookWebhook} from '../../packages/core/src/facebook-inbound';
import {prepareMessengerPilot,sendConversationReply} from '../../packages/core/src/lead-reception';
import {dispatchOne} from '../../packages/core/src/execution';

beforeAll(async()=>{await migrate();await seed();});
beforeEach(clearLeads);afterAll(closePool);
it('prepares a scoped real Messenger pilot once without queuing a send, preserving its delay',async()=>{
  const account=await createAccount(scope,{display_name:'Contract only Page',external_id:'7100901',platform:'facebook',account_type:'page',credential_ref:'FACEBOOK_PILOT_TEST'});
  const environment=await createEnvironment(scope,{name:'Pilot test environment',account_id:account.id,agent_id:localIds.agent});
  await configureFacebook(scope,{request_id:randomUUID(),account_id:account.id,environment_id:environment.id,expected_version:0,state:'ACTIVE',auto_reply:false,reply_window_hours:24,policy_ref:'local.contract.service-window'});
  const previous=process.env.KFF_FACEBOOK_APP_SECRET;process.env.KFF_FACEBOOK_APP_SECRET='isolated-pilot-contract-secret';
  try{
    const bytes=Buffer.from(JSON.stringify({object:'page',entry:[{id:account.external_id,messaging:[{sender:{id:'88990'},recipient:{id:account.external_id},timestamp:Date.now(),message:{mid:randomUUID(),text:'Please help'}}]}]}));
    await receiveFacebookWebhook(bytes,'sha256='+createHmac('sha256',process.env.KFF_FACEBOOK_APP_SECRET).update(bytes).digest('hex'));
    const conversation=(await query('SELECT id,control_version FROM kff.conversations WHERE account_id=$1',[account.id]))[0];
    const input={request_id:randomUUID(),expected_version:conversation.control_version,body:'Approved test response',refer_whatsapp:false,delay_minutes:30};
    await expect(prepareMessengerPilot(scope,conversation.id,input)).rejects.toMatchObject({code:'ACCOUNT_UNAVAILABLE'});
    // Simulate the prerequisite identity receipt only inside this isolated database. No provider call.
    await query("UPDATE kff.accounts SET state='ACTIVE' WHERE id=$1",[account.id]);
    const results=await Promise.all([prepareMessengerPilot(scope,conversation.id,input),prepareMessengerPilot(scope,conversation.id,input)]);
    expect(results[0].task_id).toBe(results[1].task_id);
    const task=(await query('SELECT * FROM kff.tasks WHERE id=$1',[results[0].task_id]))[0];
    expect(task.snapshot).toMatchObject({mode:'CONTROLLED_PILOT',adapter_version:'facebook-messenger-v1',is_synthetic:false,message:{contact:{remote_id:'88990'}}});
    expect(task.snapshot.implementation_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(task.snapshot.not_before)-Date.now()).toBeGreaterThan(29*60000);
    expect((await query('SELECT * FROM kff.runs WHERE task_id=$1',[task.id]))).toHaveLength(0);
    await expect(enqueueTask(scope,task.id)).rejects.toMatchObject({code:'PILOT_PERMIT_REQUIRED'});
    await expect(prepareMessengerPilot({...scope,role:'viewer'},conversation.id,input)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
    await expect(prepareMessengerPilot(scope,conversation.id,{...input,body:'Different'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  }finally{if(previous===undefined)delete process.env.KFF_FACEBOOK_APP_SECRET;else process.env.KFF_FACEBOOK_APP_SECRET=previous;}
});
it('does not dispatch a delayed reply until due and keeps one job after replay',async()=>{
  const lead=await seedLead(),input={request_id:randomUUID(),expected_version:1,body:'Scheduled local response',refer_whatsapp:false,delay_minutes:30};
  const result=await sendConversationReply(scope,lead.conversation_id,input);await sendConversationReply(scope,lead.conversation_id,input);
  expect((await query('SELECT * FROM kff.jobs WHERE action_id=$1',[result.action_id]))).toHaveLength(1);
  await dispatchOne();expect((await query('SELECT state FROM kff.actions WHERE id=$1',[result.action_id]))[0].state).toBe('QUEUED');
  await query('UPDATE kff.jobs SET available_at=clock_timestamp() WHERE action_id=$1',[result.action_id]);
  await dispatchOne();expect((await query('SELECT state FROM kff.actions WHERE id=$1',[result.action_id]))[0].state).toBe('PREPARING');
});
