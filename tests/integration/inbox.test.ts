import {randomUUID,randomBytes} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import type {Scope} from '../../packages/contracts/src/index';
import type {InboundMessageInput} from '../../packages/contracts/src/inbox';
import {createSiteChannel,controlSiteChannel,beginVisitorSession,endVisitorSession,visitorSessionStatus,receiveVisitorMessage,visitorHistory,inboxWorkspace,inboxConversation,customerWorkspace,customerDetail,updateCustomer,addCustomerNote} from '../../packages/core/src/inbox';
import {reviewContactBasis} from '../../packages/core/src/contacts';
import {digest} from '../../packages/core/src/index';
const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
const channelInput=()=>({request_id:randomUUID(),name:'Owned synthetic inbox',is_synthetic:true,session_hours:168,reply_window_hours:24,sessions_per_minute:60,messages_per_minute:300});
const message=(overrides:Partial<InboundMessageInput>={}):InboundMessageInput=>({client_message_id:randomUUID(),body:'A synthetic owned inquiry',display_name:'同名访客',client_sent_at:null,...overrides});
async function setup(){const channel=await createSiteChannel(scope,channelInput());const visitor=await beginVisitorSession(channel.id);return {channel,visitor};}
async function incoming(){const {channel,visitor}=await setup();const input=message();const result=await receiveVisitorMessage(channel.id,visitor.token,input);return {channel,visitor,input,result,customer:(await inboxConversation(scope,result.message.conversation_id)).conversation.customer_id};}
const children:ChildProcess[]=[];
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await done;}
async function crash(boundary:'before'|'after',channelId:string,token:string,input:InboundMessageInput){
  const child=spawn(process.execPath,['--import','tsx','tests/helpers/inbound-process.ts',boundary],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  const ready=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Inbound transaction barrier missing')),10000);child.on('message',value=>{if(value&&typeof value==='object'&&'barrier' in value&&value.barrier===boundary){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Inbound process exited: '+code));});});
  child.send({channel_id:channelId,token,message:input});await ready;await kill(child);
}
beforeAll(async()=>{const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated database required');await migrate();await seed();});
beforeEach(async()=>{await query('TRUNCATE kff.site_channels,kff.customers CASCADE');await query("DELETE FROM kff.inbound_events WHERE source_kind='site_chat'");await query('UPDATE kff.organizations SET outbound_paused=false');await query('UPDATE kff.brands SET outbound_paused=false');});
afterAll(async()=>{for(const child of children)await kill(child);await closePool();});
it('creates one independent channel account, preserves its policy and issues sessions without creating customers',async()=>{
  const input=channelInput(),rows=await Promise.all(Array.from({length:5},()=>createSiteChannel(scope,input)));expect(new Set(rows.map(row=>row.id)).size).toBe(1);
  const channel=rows[0],account=(await query('SELECT * FROM kff.accounts WHERE id=$1',[channel.account_id]))[0];expect(account).toMatchObject({platform:'site',account_type:'inbox',state:'ACTIVE'});expect((await query('SELECT * FROM kff.capabilities WHERE account_id=$1',[channel.account_id]))).toHaveLength(0);
  await expect(createSiteChannel(scope,{...input,name:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await expect(query('UPDATE kff.site_channels SET reply_window_hours=100 WHERE id=$1',[channel.id])).rejects.toThrow('IMMUTABLE_CHANNEL_POLICY');
  const session=await beginVisitorSession(channel.id);expect(await beginVisitorSession(channel.id,session.token)).toMatchObject({token:session.token,created:false});expect((await inboxWorkspace(scope)).counts).toEqual({customers:0,conversations:0,inbound_messages:0});expect(await visitorSessionStatus(channel.id,session.token)).toMatchObject({active:true});
});
it('commits event, customer, identity, conversation, message, service basis and timeline together without authorizing execution',async()=>{
  const before=(await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n;const value=await incoming();expect(value.result.status).toBe('STORED');expect(value.result.execution_authorized).toBe(false);
  expect((await inboxWorkspace(scope)).counts).toEqual({customers:1,conversations:1,inbound_messages:1});const detail=await customerDetail(scope,value.customer);expect(detail.acquisition_source).toBe('UNKNOWN');expect(detail.verified_payment).toBe(false);expect(detail.identities).toHaveLength(1);expect(detail.events[0].event_type).toBe('INQUIRY');
  const event=(await query('SELECT * FROM kff.inbound_events WHERE id=$1',[value.result.message.inbound_event_id]))[0];expect(event).toMatchObject({source_kind:'site_chat',payload_hash:digest(value.input),agent_id:null,command_id:null});
  const permission=(await query('SELECT p.* FROM kff.contact_permissions p JOIN kff.messages m ON m.contact_permission_id=p.id WHERE m.id=$1',[value.result.message.id]))[0];
  const basis=await reviewContactBasis(scope,{target_id:permission.target_id,permission_id:permission.id,purpose:'customer_service'});expect(basis.basis_eligible).toBe(true);expect(basis.execution_authorized).toBe(false);
  expect((await reviewContactBasis(scope,{target_id:permission.target_id,permission_id:permission.id,purpose:'marketing'})).reason_codes).toContain('CONTACT_PURPOSE_MISMATCH');expect((await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n).toBe(before);
  expect(JSON.stringify(await query("SELECT details FROM kff.audit_events WHERE object_id=$1",[event.id]))).not.toContain(value.input.body);
});
it('deduplicates concurrent deliveries and rejects changed content under the same message identity',async()=>{
  const {channel,visitor}=await setup(),input=message();const results=await Promise.all(Array.from({length:8},()=>receiveVisitorMessage(channel.id,visitor.token,input)));
  expect(new Set(results.map(row=>row.message.id)).size).toBe(1);expect((await inboxWorkspace(scope)).counts).toEqual({customers:1,conversations:1,inbound_messages:1});
  await expect(receiveVisitorMessage(channel.id,visitor.token,{...input,body:'Changed payload'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await expect(query("UPDATE kff.messages SET body='tampered' WHERE id=$1",[results[0].message.id])).rejects.toThrow('IMMUTABLE_OWNED_RECORD');
});
it('orders by server receipt, preserves untrusted client time, and pages without repeating or dropping accepted messages',async()=>{
  const {channel,visitor}=await setup();const inputs=[message({client_sent_at:'2024-12-31T23:59:59Z'}),message({client_sent_at:'2020-01-01T00:00:00Z'}),message({client_sent_at:null})];
  for(const input of inputs)await receiveVisitorMessage(channel.id,visitor.token,input);
  const page=await visitorHistory(channel.id,visitor.token,{limit:2});expect(page.messages.map(row=>row.sequence)).toEqual([1,2]);expect(page.has_more).toBe(true);expect(new Date(page.messages[1].client_sent_at!).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  const tail=await visitorHistory(channel.id,visitor.token,{after:page.next_after,limit:2});expect(tail.messages.map(row=>row.sequence)).toEqual([3]);expect(tail.has_more).toBe(false);
  const conversation=(await inboxWorkspace(scope)).conversations[0];const end=conversation.reply_window_expires_at;await receiveVisitorMessage(channel.id,visitor.token,inputs[0]);expect((await inboxWorkspace(scope)).conversations[0].reply_window_expires_at).toEqual(end);
});
it('isolates visitors and channels even when their names and client message IDs are identical',async()=>{
  const {channel,visitor}=await setup(),second=await beginVisitorSession(channel.id),other=await createSiteChannel(scope,channelInput()),input=message();
  const first=await receiveVisitorMessage(channel.id,visitor.token,input);await receiveVisitorMessage(channel.id,second.token,{...input,body:'Different visitor same ID'});
  expect((await visitorHistory(channel.id,visitor.token)).messages.map(row=>row.id)).toEqual([first.message.id]);expect((await inboxWorkspace(scope)).counts.customers).toBe(2);
  await expect(visitorHistory(other.id,visitor.token)).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});await expect(receiveVisitorMessage(channel.id,randomBytes(32).toString('hex'),input)).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});
  const copiedToken=randomBytes(32).toString('hex');await query('INSERT INTO kff.visitor_sessions(organization_id,brand_id,channel_id,visitor_id,token_hash,expires_at) SELECT organization_id,brand_id,$1,visitor_id,$2,expires_at FROM kff.visitor_sessions WHERE token_hash=$3',[other.id,digest(copiedToken),digest(visitor.token)]);
  await receiveVisitorMessage(other.id,copiedToken,input);expect((await inboxWorkspace(scope)).counts.customers).toBe(3);
});
it('blocks expired and revoked sessions while retaining already stored customer messages',async()=>{
  const value=await incoming(),expiredToken=randomBytes(32).toString('hex');
  await query("INSERT INTO kff.visitor_sessions(organization_id,brand_id,channel_id,visitor_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour')",[scope.organization_id,scope.brand_id,value.channel.id,randomUUID(),digest(expiredToken)]);
  await expect(visitorHistory(value.channel.id,expiredToken)).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});await expect(receiveVisitorMessage(value.channel.id,expiredToken,message())).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});
  await endVisitorSession(value.channel.id,value.visitor.token);expect(await visitorSessionStatus(value.channel.id,value.visitor.token)).toEqual({active:false,expires_at:null});await expect(visitorHistory(value.channel.id,value.visitor.token)).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});expect((await inboxWorkspace(scope)).counts.inbound_messages).toBe(1);
});
it('rechecks session expiry after waiting for its database lock before accepting any inquiry',async()=>{
  const channel=await createSiteChannel(scope,channelInput()),token=randomBytes(32).toString('hex');
  await query("INSERT INTO kff.visitor_sessions(organization_id,brand_id,channel_id,visitor_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '350 milliseconds')",[scope.organization_id,scope.brand_id,channel.id,randomUUID(),digest(token)]);
  let locked!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const holder=scoped(scope,async client=>{await client.query('SELECT id FROM kff.visitor_sessions WHERE token_hash=$1 FOR UPDATE',[digest(token)]);locked();await gate;});await ready;
  const receiving=receiveVisitorMessage(channel.id,token,message());const rejected=expect(receiving).rejects.toMatchObject({code:'VISITOR_SESSION_REQUIRED'});
  try{await delay(450);}finally{release();await holder;}await rejected;expect((await inboxWorkspace(scope)).counts.inbound_messages).toBe(0);
});
it('keeps inbound customer service available when organization, brand and account outbound execution are paused',async()=>{
  const {channel,visitor}=await setup();await query('UPDATE kff.organizations SET outbound_paused=true WHERE id=$1',[scope.organization_id]);await query('UPDATE kff.brands SET outbound_paused=true WHERE id=$1',[scope.brand_id]);await query('UPDATE kff.accounts SET outbound_paused=true WHERE id=$1',[channel.account_id]);
  const stored=await receiveVisitorMessage(channel.id,visitor.token,message());expect(stored.status).toBe('STORED');
  const permission=(await query('SELECT p.* FROM kff.contact_permissions p JOIN kff.messages m ON m.contact_permission_id=p.id WHERE m.id=$1',[stored.message.id]))[0];expect((await reviewContactBasis(scope,{target_id:permission.target_id,permission_id:permission.id,purpose:'customer_service'})).reason_codes).toContain('STOP_REQUESTED');
});
it('pauses new inquiry admission but permits safe duplicate acknowledgements and existing history',async()=>{
  const value=await incoming();const input={request_id:randomUUID(),expected_version:1,state:'PAUSED' as const,reason:'Pause owned test ingress'};const paused=await controlSiteChannel(scope,value.channel.id,input);
  expect(await controlSiteChannel(scope,value.channel.id,input)).toEqual(JSON.parse(JSON.stringify(paused)));
  await expect(beginVisitorSession(value.channel.id)).rejects.toMatchObject({code:'CHANNEL_PAUSED'});await expect(receiveVisitorMessage(value.channel.id,value.visitor.token,message())).rejects.toMatchObject({code:'CHANNEL_PAUSED'});
  expect((await receiveVisitorMessage(value.channel.id,value.visitor.token,value.input)).message.id).toBe(value.result.message.id);expect((await visitorHistory(value.channel.id,value.visitor.token)).messages).toHaveLength(1);
  await controlSiteChannel(scope,value.channel.id,{...input,request_id:randomUUID(),expected_version:paused.version,state:'ACTIVE'});await receiveVisitorMessage(value.channel.id,value.visitor.token,message());expect((await inboxWorkspace(scope)).counts.inbound_messages).toBe(2);
});
it('enforces durable session and channel quotas without charging duplicates or creating rejected customers',async()=>{
  const channel=await createSiteChannel(scope,{...channelInput(),sessions_per_minute:2,messages_per_minute:2});const first=await beginVisitorSession(channel.id),second=await beginVisitorSession(channel.id);
  await expect(beginVisitorSession(channel.id)).rejects.toMatchObject({code:'RATE_LIMITED'});expect(await beginVisitorSession(channel.id,first.token)).toMatchObject({created:false});
  const input=message();await receiveVisitorMessage(channel.id,first.token,input);await receiveVisitorMessage(channel.id,second.token,message());await receiveVisitorMessage(channel.id,first.token,input);
  await expect(receiveVisitorMessage(channel.id,first.token,message())).rejects.toMatchObject({code:'RATE_LIMITED'});expect((await inboxWorkspace(scope)).counts).toEqual({customers:2,conversations:2,inbound_messages:2});
});
it('enforces per-visitor quota atomically when distinct messages arrive concurrently',async()=>{
  const {channel,visitor}=await setup();const results=await Promise.allSettled(Array.from({length:22},()=>receiveVisitorMessage(channel.id,visitor.token,message())));
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(20);for(const row of results.filter(row=>row.status==='rejected'))expect(row.reason).toMatchObject({code:'RATE_LIMITED'});
  expect((await inboxWorkspace(scope)).counts).toEqual({customers:1,conversations:1,inbound_messages:20});expect((await visitorHistory(channel.id,visitor.token)).messages.map(row=>row.sequence)).toEqual(Array.from({length:20},(_,i)=>i+1));
});
it('rejects viewer writes, foreign owners and forged brand reads with database tenant boundaries',async()=>{
  const value=await incoming();const viewer={...scope,role:'viewer' as const},other={...scope,brand_id:randomUUID()};
  await expect(createSiteChannel(viewer,channelInput())).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(addCustomerNote(viewer,value.customer,{request_id:randomUUID(),text:'No viewer writes'})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(customerDetail(other,value.customer)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(inboxConversation(other,value.result.message.conversation_id)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await customerWorkspace(other)).customers).toEqual([]);expect((await customerWorkspace(other)).members).toEqual([]);
  for(const table of ['site_channels','visitor_sessions','customers','customer_identities','conversations','messages','customer_events'])expect(await scoped(other,async client=>(await client.query('SELECT * FROM kff.'+table)).rows)).toEqual([]);
  const input={request_id:randomUUID(),expected_version:1,display_name:'Assigned',owner_user_id:randomUUID(),stage:'IN_PROGRESS' as const,reason:'Foreign owner must be denied'};await expect(updateCustomer(scope,value.customer,input)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(scoped(other,client=>client.query("INSERT INTO kff.customer_events(organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'NOTE',$4,'{}',$5,'test')",[scope.organization_id,scope.brand_id,value.customer,scope.user_id,randomUUID()]))).rejects.toMatchObject({code:'42501'});
});
it('keeps identical visitor identifiers separate across actual brands and rejects cross-customer message references',async()=>{
  const value=await incoming(),brandId=randomUUID();await query('INSERT INTO kff.brands(id,organization_id,name) VALUES($1,$2,$3)',[brandId,scope.organization_id,'Owned second test brand']);await query("INSERT INTO kff.memberships(user_id,organization_id,brand_id,role) VALUES($1,$2,$3,'admin')",[scope.user_id,scope.organization_id,brandId]);
  const otherScope={...scope,brand_id:brandId},channel=await createSiteChannel(otherScope,channelInput()),token=randomBytes(32).toString('hex');
  await query('INSERT INTO kff.visitor_sessions(organization_id,brand_id,channel_id,visitor_id,token_hash,expires_at) SELECT organization_id,$1,$2,visitor_id,$3,expires_at FROM kff.visitor_sessions WHERE token_hash=$4',[brandId,channel.id,digest(token),digest(value.visitor.token)]);
  const second=await receiveVisitorMessage(channel.id,token,value.input);const secondConversation=(await inboxConversation(otherScope,second.message.conversation_id)).conversation;expect(secondConversation.customer_id).not.toBe(value.customer);expect((await inboxWorkspace(scope)).counts.customers).toBe(1);expect((await inboxWorkspace(otherScope)).counts.customers).toBe(1);
  await expect(query('INSERT INTO kff.messages(organization_id,brand_id,conversation_id,inbound_event_id,sequence,direction,body,received_at,contact_permission_id) SELECT organization_id,brand_id,$1,inbound_event_id,20,direction,body,received_at,contact_permission_id FROM kff.messages WHERE id=$2',[value.result.message.conversation_id,second.message.id])).rejects.toThrow('MESSAGE_IDENTITY_MISMATCH');
});
it('preserves customer edits, version conflicts and request ownership while recording notes once',async()=>{
  const value=await incoming(),other=await incoming();const input={request_id:randomUUID(),expected_version:1,display_name:'Assigned inquiry',owner_user_id:scope.user_id,stage:'QUALIFIED_INQUIRY' as const,reason:'Confirmed request during synthetic interview'};
  const saved=await updateCustomer(scope,value.customer,input);expect(saved.version).toBe(2);expect(saved.owner_user_id).toBe(scope.user_id);expect(await updateCustomer(scope,value.customer,input)).toEqual(JSON.parse(JSON.stringify(saved)));
  await expect(updateCustomer(scope,other.customer,input)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await expect(updateCustomer(scope,value.customer,{...input,request_id:randomUUID()})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  const note={request_id:randomUUID(),text:'Follow up tomorrow after confirming the scope'};const notes=await Promise.all(Array.from({length:4},()=>addCustomerNote(scope,value.customer,note)));expect(new Set(notes.map(row=>row.id)).size).toBe(1);await expect(addCustomerNote(scope,other.customer,note)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const detail=await customerDetail(scope,value.customer);expect(detail.events.filter(row=>row.event_type==='NOTE')).toHaveLength(1);expect(detail.events.find(row=>row.event_type==='PROFILE_UPDATED')?.details.before.stage).toBe('NEW_INQUIRY');
  await receiveVisitorMessage(value.channel.id,value.visitor.token,message());await expect(updateCustomer(scope,value.customer,{...input,request_id:randomUUID(),expected_version:2})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
});
it('makes customer opt-out effective and never restores contact consent through a new inquiry or a stage edit',async()=>{
  const value=await incoming();const input={request_id:randomUUID(),expected_version:1,display_name:null,owner_user_id:null,stage:'OPTED_OUT' as const,reason:'Visitor requested no further contact'};await updateCustomer(scope,value.customer,input);
  await receiveVisitorMessage(value.channel.id,value.visitor.token,message());const detail=await customerDetail(scope,value.customer);expect(detail.conversations[0].opted_out).toBe(true);
  await updateCustomer(scope,value.customer,{...input,request_id:randomUUID(),expected_version:detail.customer.version,stage:'IN_PROGRESS'});
  const permission=(await query('SELECT p.* FROM kff.contact_permissions p JOIN kff.messages m ON m.contact_permission_id=p.id WHERE m.conversation_id=$1 ORDER BY m.sequence DESC LIMIT 1',[value.result.message.conversation_id]))[0];
  expect((await reviewContactBasis(scope,{target_id:permission.target_id,permission_id:permission.id,purpose:'customer_service'})).reason_codes).toContain('CONTACT_OPTED_OUT');
});
it('rolls back all inquiry records and quotas when the actual process dies before commit',async()=>{
  const {channel,visitor}=await setup(),input=message();await crash('before',channel.id,visitor.token,input);expect((await inboxWorkspace(scope)).counts).toEqual({customers:0,conversations:0,inbound_messages:0});expect((await query('SELECT message_bucket_count FROM kff.site_channels WHERE id=$1',[channel.id]))[0].message_bucket_count).toBe(0);
  expect((await query("SELECT id FROM kff.inbound_events WHERE source_kind='site_chat'"))).toHaveLength(0);await receiveVisitorMessage(channel.id,visitor.token,input);expect((await inboxWorkspace(scope)).counts).toEqual({customers:1,conversations:1,inbound_messages:1});
});
it('retains the committed receipt after the actual process dies before acknowledgement and replays it once',async()=>{
  const {channel,visitor}=await setup(),input=message();await crash('after',channel.id,visitor.token,input);const before=await visitorHistory(channel.id,visitor.token);expect(before.messages).toHaveLength(1);const retry=await receiveVisitorMessage(channel.id,visitor.token,input);expect(retry.message.id).toBe(before.messages[0].id);expect((await inboxWorkspace(scope)).counts).toEqual({customers:1,conversations:1,inbound_messages:1});
});
