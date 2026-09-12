import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {query,scoped} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {contactPolicy} from '../../contracts/src/contact';
import {channelInput,channelControlInput,inboundMessageInput,conversationPageInput,customerUpdateInput,customerNoteInput,type SiteChannel,type Customer,type InboxConversation,type InboxMessage,type MessagePage} from '../../contracts/src/inbox';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite} from './service';

type ChannelRow=SiteChannel & {organization_id:string;brand_id:string;created_by:string;request_hash:string;session_bucket_at:Date;session_bucket_count:number;message_bucket_at:Date;message_bucket_count:number};
interface VisitorSession {id:string;visitor_id:string;expires_at:Date;revoked_at:Date|null;message_bucket_at:Date;message_bucket_count:number}
const channelColumns='id,name,account_id,state,version,is_synthetic,session_hours,reply_window_hours,sessions_per_minute,messages_per_minute,created_at';
const messageColumns='id,conversation_id,sequence,direction,body,received_at,client_sent_at,inbound_event_id';
const conversationColumns='v.id,v.customer_id,v.channel_id,v.identity_id,v.last_sequence,v.last_message_at,v.reply_window_expires_at,c.display_name,c.stage,c.owner_user_id,h.name AS channel_name,h.is_synthetic,t.opted_out,i.contact_target_id';
const conversationJoins=' FROM kff.conversations v JOIN kff.customers c ON c.id=v.customer_id JOIN kff.site_channels h ON h.id=v.channel_id JOIN kff.customer_identities i ON i.id=v.identity_id JOIN kff.contact_targets t ON t.id=i.contact_target_id';
const receipt=(message:InboxMessage)=>({message,status:'STORED' as const,execution_authorized:false as const});
async function now(client:PoolClient):Promise<Date> {return (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;}

export async function createSiteChannel(scope:Scope,input:z.infer<typeof channelInput>) {
  requireAdmin(scope);const value=channelInput.parse(input);const hash=digest(value);
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['site-channel/'+scope.brand_id+'/'+value.request_id]);
    const old=(await client.query<ChannelRow>('SELECT * FROM kff.site_channels WHERE request_id=$1',[value.request_id])).rows[0];
    if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','同一请求已创建不同咨询入口',409);return publicChannel(old);}
    const id=randomUUID(),accountId=randomUUID();
    // Accounts use decimal string identifiers; this is an owned namespace, never a Facebook identity.
    const accountNumber=BigInt('0x'+accountId.replaceAll('-','')).toString();
    await client.query("INSERT INTO kff.accounts(id,organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,$4,'site','inbox',$5,'ACTIVE',$6)",[accountId,scope.organization_id,scope.brand_id,value.name,accountNumber,value.is_synthetic]);
    const row=(await client.query<ChannelRow>('INSERT INTO kff.site_channels(id,organization_id,brand_id,account_id,name,is_synthetic,session_hours,reply_window_hours,sessions_per_minute,messages_per_minute,request_id,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',[id,scope.organization_id,scope.brand_id,accountId,value.name,value.is_synthetic,value.session_hours,value.reply_window_hours,value.sessions_per_minute,value.messages_per_minute,value.request_id,hash,scope.user_id])).rows[0];
    await audit(client,scope,'site_channel.created',id,{account_id:accountId,is_synthetic:value.is_synthetic,policy:{session_hours:value.session_hours,reply_window_hours:value.reply_window_hours}});
    return publicChannel(row);
  });
}
function publicChannel(row:ChannelRow):SiteChannel {
  return {id:row.id,name:row.name,account_id:row.account_id,state:row.state,version:row.version,is_synthetic:row.is_synthetic,session_hours:row.session_hours,reply_window_hours:row.reply_window_hours,sessions_per_minute:row.sessions_per_minute,messages_per_minute:row.messages_per_minute,created_at:row.created_at};
}
export async function controlSiteChannel(scope:Scope,id:string,input:z.infer<typeof channelControlInput>) {
  requireAdmin(scope);const value=channelControlInput.parse(input);
  return scoped(scope,async client=>{
    const row=(await client.query<ChannelRow>('SELECT * FROM kff.site_channels WHERE id=$1 FOR UPDATE',[id])).rows[0];
    requireCondition(row,'NOT_FOUND','咨询入口不存在',404);
    const old=(await client.query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='site_channel.controlled' AND details->>'request_id'=$2",[id,value.request_id])).rows[0];
    if(old){requireCondition(old.details.request_hash===digest(value),'IDEMPOTENCY_CONFLICT','控制请求内容已变化',409);return old.details.result as SiteChannel;}
    requireCondition(row.version===value.expected_version,'VERSION_CONFLICT','入口状态已变化，请刷新后重试',409);
    const updated=(await client.query<SiteChannel>('UPDATE kff.site_channels SET state=$1,version=version+1 WHERE id=$2 RETURNING '+channelColumns,[value.state,id])).rows[0];
    await audit(client,scope,'site_channel.controlled',id,{request_id:value.request_id,request_hash:digest(value),reason:value.reason,result:updated});return updated;
  });
}

// Only this minimal lookup precedes RLS. Tenant and actor are derived by the server, never from request fields.
async function channelScope(channelId:string,actorId=randomUUID()) {
  const row=(await query<{organization_id:string;brand_id:string}>('SELECT organization_id,brand_id FROM kff.site_channels WHERE id=$1',[channelId]))[0];
  requireCondition(row,'NOT_FOUND','咨询入口不存在',404);
  return {...row,user_id:actorId,role:'operator' as const};
}
export async function publicChatInfo(channelId:string) {
  return scoped(await channelScope(channelId),async client=>{
    const row=(await client.query<ChannelRow>('SELECT * FROM kff.site_channels WHERE id=$1',[channelId])).rows[0];
    requireCondition(row,'NOT_FOUND','咨询入口不存在',404);
    return {id:row.id,name:row.name,state:row.state,is_synthetic:row.is_synthetic,session_hours:row.session_hours,reply_window_hours:row.reply_window_hours};
  });
}
function checkToken(token:string|undefined){requireCondition(token&&/^[a-f0-9]{64}$/.test(token),'VISITOR_SESSION_REQUIRED','请先开始咨询，会话过期后需要重新开始',401);return token;}
async function session(client:PoolClient,channelId:string,token:string|undefined,lock:'SHARE'|'UPDATE') {
  const row=(await client.query<VisitorSession>('SELECT id,visitor_id,expires_at,revoked_at,message_bucket_at,message_bucket_count FROM kff.visitor_sessions WHERE channel_id=$1 AND token_hash=$2 FOR '+lock,[channelId,digest(checkToken(token))])).rows[0];
  const checkedAt=await now(client);
  requireCondition(row&&!row.revoked_at&&row.expires_at.getTime()>checkedAt.getTime(),'VISITOR_SESSION_REQUIRED','访客会话已过期或无效，请重新开始咨询',401);return row;
}
export async function beginVisitorSession(channelId:string,existingToken?:string) {
  const scope=await channelScope(channelId);
  return scoped(scope,async client=>{
    const channel=(await client.query<ChannelRow>('SELECT * FROM kff.site_channels WHERE id=$1 FOR UPDATE',[channelId])).rows[0];
    if(existingToken&&/^[a-f0-9]{64}$/.test(existingToken)){
      const old=(await client.query<VisitorSession>('SELECT id,visitor_id,expires_at,revoked_at,message_bucket_at,message_bucket_count FROM kff.visitor_sessions WHERE channel_id=$1 AND token_hash=$2 FOR SHARE',[channelId,digest(existingToken)])).rows[0];
      if(old&&!old.revoked_at&&old.expires_at>await now(client))return {token:existingToken,expires_at:old.expires_at.toISOString(),created:false};
    }
    const time=await now(client);
    requireCondition(channel.state==='ACTIVE','CHANNEL_PAUSED','此咨询入口已暂停，请稍后再试',409);
    const fresh=time.getTime()-channel.session_bucket_at.getTime()>=60000;
    const count=fresh?0:channel.session_bucket_count;
    requireCondition(count<channel.sessions_per_minute,'RATE_LIMITED','咨询入口暂时繁忙，请一分钟后重试',429);
    const token=randomBytes(32).toString('hex'),visitorId=randomUUID();
    const expires=new Date(time.getTime()+channel.session_hours*3600000);
    await client.query('UPDATE kff.site_channels SET session_bucket_at=$1,session_bucket_count=$2 WHERE id=$3',[fresh?time:channel.session_bucket_at,count+1,channelId]);
    await client.query('INSERT INTO kff.visitor_sessions(organization_id,brand_id,channel_id,visitor_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[scope.organization_id,scope.brand_id,channelId,visitorId,digest(token),time,expires]);
    await audit(client,{...scope,user_id:visitorId},'visitor.session_started',channelId,{actor_kind:'visitor',expires_at:expires.toISOString()});
    return {token,expires_at:expires.toISOString(),created:true};
  });
}
export async function endVisitorSession(channelId:string,token:string|undefined) {
  return scoped(await channelScope(channelId),async client=>{
    checkToken(token);
    await client.query('UPDATE kff.visitor_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE channel_id=$1 AND token_hash=$2',[channelId,digest(token!)]);
    return {ended:true};
  });
}
export async function visitorSessionStatus(channelId:string,token:string|undefined) {
  const scope=await channelScope(channelId);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return {active:false as const,expires_at:null};
  return scoped(scope,async client=>{
    const row=(await client.query<{expires_at:Date}>('SELECT expires_at FROM kff.visitor_sessions WHERE channel_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[channelId,digest(token)])).rows[0];
    return row?{active:true as const,expires_at:row.expires_at.toISOString()}:{active:false as const,expires_at:null};
  });
}

export async function receiveVisitorMessage(channelId:string,token:string|undefined,input:z.infer<typeof inboundMessageInput>,beforeCommit?:()=>Promise<void>) {
  const value=inboundMessageInput.parse(input);checkToken(token);const scope=await channelScope(channelId);
  return scoped(scope,async client=>{
    const channel=(await client.query<ChannelRow>('SELECT * FROM kff.site_channels WHERE id=$1 FOR UPDATE',[channelId])).rows[0];
    const visitor=await session(client,channelId,token,'UPDATE'),time=await now(client);
    const actor={...scope,user_id:visitor.visitor_id};
    const key=channelId+'/'+visitor.visitor_id+'/'+value.client_message_id;
    const hash=digest(value);
    const old=(await client.query("SELECT id,payload_hash FROM kff.inbound_events WHERE source_kind='site_chat' AND source_key=$1",[key])).rows[0];
    if(old){
      requireCondition(old.payload_hash===hash,'IDEMPOTENCY_CONFLICT','这条消息已保存为不同内容，请保留原文重试',409);
      const message=(await client.query<InboxMessage>('SELECT '+messageColumns+' FROM kff.messages WHERE inbound_event_id=$1',[old.id])).rows[0];
      requireCondition(message,'INBOUND_INCOMPLETE','消息记录不完整，需要管理员核对',409);return receipt(message);
    }
    requireCondition(channel.state==='ACTIVE','CHANNEL_PAUSED','此咨询入口已暂停，消息尚未保存',409);
    const channelFresh=time.getTime()-channel.message_bucket_at.getTime()>=60000;
    const visitorFresh=time.getTime()-visitor.message_bucket_at.getTime()>=60000;
    const channelCount=channelFresh?0:channel.message_bucket_count,visitorCount=visitorFresh?0:visitor.message_bucket_count;
    requireCondition(channelCount<channel.messages_per_minute&&visitorCount<20,'RATE_LIMITED','发送太快，请一分钟后使用原消息重试',429);
    const eventId=randomUUID();
    await client.query("INSERT INTO kff.inbound_events(id,organization_id,brand_id,source_kind,source_key,payload_hash,received_at) VALUES($1,$2,$3,'site_chat',$4,$5,$6)",[eventId,scope.organization_id,scope.brand_id,key,hash,time]);
    let identity=(await client.query('SELECT * FROM kff.customer_identities WHERE account_id=$1 AND channel=$2 AND remote_id=$3',[channel.account_id,'site_chat',visitor.visitor_id])).rows[0];
    if(!identity){
      const customer=(await client.query<Customer>('INSERT INTO kff.customers(organization_id,brand_id,display_name,first_inquiry_event_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *',[scope.organization_id,scope.brand_id,value.display_name,eventId,time])).rows[0];
      const target=(await client.query("INSERT INTO kff.contact_targets(organization_id,brand_id,account_id,channel,remote_id) VALUES($1,$2,$3,'site_chat',$4) ON CONFLICT(brand_id,account_id,channel,remote_id) DO UPDATE SET remote_id=EXCLUDED.remote_id RETURNING *",[scope.organization_id,scope.brand_id,channel.account_id,visitor.visitor_id])).rows[0];
      identity=(await client.query("INSERT INTO kff.customer_identities(organization_id,brand_id,customer_id,account_id,channel,remote_id,contact_target_id) VALUES($1,$2,$3,$4,'site_chat',$5,$6) RETURNING *",[scope.organization_id,scope.brand_id,customer.id,channel.account_id,visitor.visitor_id,target.id])).rows[0];
      await client.query('INSERT INTO kff.conversations(organization_id,brand_id,customer_id,identity_id,account_id,channel_id) VALUES($1,$2,$3,$4,$5,$6)',[scope.organization_id,scope.brand_id,customer.id,identity.id,channel.account_id,channelId]);
    }else{
      await client.query('UPDATE kff.customers SET updated_at=$1,version=version+1 WHERE id=$2',[time,identity.customer_id]);
    }
    const target=(await client.query('SELECT * FROM kff.contact_targets WHERE id=$1 FOR UPDATE',[identity.contact_target_id])).rows[0];
    // Receipt of a new inquiry never silently undoes a previous opt-out.
    const end=new Date(time.getTime()+channel.reply_window_hours*3600000).toISOString();
    const policy=contactPolicy.parse({basis_type:'inbound_inquiry',purpose:'customer_service',source_type:'owned_endpoint',source_ref:eventId,source_observed_at:time.toISOString(),source_use_status:'CONFIRMED',starts_at:time.toISOString(),expires_at:end,policy_ref:'kff.site-channel/'+channelId+'/v1',window_rule:'EXPLICIT_END',window_expires_at:end,evidence_note:'访客通过 KFF 自有会话提交主动咨询；仅适用于本次客户服务，不授予营销用途。'});
    const permission=(await client.query('INSERT INTO kff.contact_permissions(organization_id,brand_id,target_id,target_version,purpose,policy,policy_hash,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[scope.organization_id,scope.brand_id,target.id,target.version,'customer_service',policy,digest(policy),randomUUID(),digest({event_id:eventId,policy})])).rows[0];
    const conversation=(await client.query('UPDATE kff.conversations SET last_sequence=last_sequence+1,last_message_at=$1,reply_window_expires_at=$2 WHERE identity_id=$3 RETURNING id,last_sequence',[time,end,identity.id])).rows[0];
    const message=(await client.query<InboxMessage>("INSERT INTO kff.messages(organization_id,brand_id,conversation_id,inbound_event_id,sequence,direction,body,received_at,client_sent_at,contact_permission_id,client_display_name) VALUES($1,$2,$3,$4,$5,'INBOUND',$6,$7,$8,$9,$10) RETURNING "+messageColumns,[scope.organization_id,scope.brand_id,conversation.id,eventId,conversation.last_sequence,value.body,time,value.client_sent_at,permission.id,value.display_name])).rows[0];
    await client.query("INSERT INTO kff.customer_events(organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash,created_at) VALUES($1,$2,$3,'INQUIRY',$4,$5,$6,$7,$8)",[scope.organization_id,scope.brand_id,identity.customer_id,visitor.visitor_id,{actor_kind:'visitor',conversation_id:conversation.id,message_id:message.id,inbound_event_id:eventId,acquisition_source:'UNKNOWN'},randomUUID(),hash,time]);
    await client.query('UPDATE kff.site_channels SET message_bucket_at=$1,message_bucket_count=$2 WHERE id=$3',[channelFresh?time:channel.message_bucket_at,channelCount+1,channelId]);
    await client.query('UPDATE kff.visitor_sessions SET message_bucket_at=$1,message_bucket_count=$2 WHERE id=$3',[visitorFresh?time:visitor.message_bucket_at,visitorCount+1,visitor.id]);
    await audit(client,actor,'chat.inbound_stored',eventId,{actor_kind:'visitor',conversation_id:conversation.id,message_id:message.id,sequence:conversation.last_sequence,customer_id:identity.customer_id});
    if(beforeCommit)await beforeCommit();
    return receipt(message);
  });
}

async function readMessages(client:PoolClient,conversationId:string,input:z.input<typeof conversationPageInput>):Promise<MessagePage> {
  const page=conversationPageInput.parse(input);
  const rows=(await client.query<InboxMessage>('SELECT '+messageColumns+' FROM kff.messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[conversationId,Number(page.after),page.limit+1])).rows;
  const messages=rows.slice(0,page.limit);
  return {messages,next_after:String(messages.at(-1)?.sequence??page.after),has_more:rows.length>page.limit};
}
export async function visitorHistory(channelId:string,token:string|undefined,input:z.input<typeof conversationPageInput>={}) {
  checkToken(token);
  return scoped(await channelScope(channelId),async client=>{
    const visitor=await session(client,channelId,token,'SHARE');
    const conversation=(await client.query('SELECT v.id FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id WHERE v.channel_id=$1 AND i.channel=$2 AND i.remote_id=$3',[channelId,'site_chat',visitor.visitor_id])).rows[0];
    const page=conversation?await readMessages(client,conversation.id,input):{messages:[],next_after:'0',has_more:false};
    return {...page,expires_at:visitor.expires_at.toISOString()};
  });
}
export async function inboxWorkspace(scope:Scope) {
  return scoped(scope,async client=>({
    channels:(await client.query<SiteChannel>('SELECT '+channelColumns+' FROM kff.site_channels ORDER BY created_at DESC,id LIMIT 100')).rows,
    conversations:(await client.query<InboxConversation>('SELECT '+conversationColumns+conversationJoins+' ORDER BY v.last_message_at DESC,v.id LIMIT 200')).rows,
    counts:(await client.query('SELECT (SELECT count(*)::int FROM kff.customers) AS customers,(SELECT count(*)::int FROM kff.conversations) AS conversations,(SELECT count(*)::int FROM kff.messages) AS inbound_messages')).rows[0] as {customers:number;conversations:number;inbound_messages:number},
    outbound_available:false as const,
  }));
}
export async function inboxConversation(scope:Scope,id:string,input:z.input<typeof conversationPageInput>={}) {
  return scoped(scope,async client=>{
    const conversation=(await client.query<InboxConversation>('SELECT '+conversationColumns+conversationJoins+' WHERE v.id=$1',[id])).rows[0];
    requireCondition(conversation,'NOT_FOUND','会话不存在',404);
    return {conversation,...await readMessages(client,id,input),outbound_available:false as const};
  });
}
export async function customerWorkspace(scope:Scope) {
  return scoped(scope,async client=>({
    customers:(await client.query<Customer>('SELECT * FROM kff.customers ORDER BY updated_at DESC,id LIMIT 200')).rows,
    members:(await client.query<{user_id:string;role:string}>('SELECT user_id,role FROM kff.memberships ORDER BY role,user_id')).rows,
  }));
}
export async function customerDetail(scope:Scope,id:string) {
  return scoped(scope,async client=>{
    const customer=(await client.query<Customer>('SELECT * FROM kff.customers WHERE id=$1',[id])).rows[0];
    requireCondition(customer,'NOT_FOUND','客户不存在',404);
    const events=(await client.query('SELECT id,event_type,actor_id,details,created_at FROM kff.customer_events WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',[id])).rows;
    const identities=(await client.query<{id:string;account_id:string;channel:string;remote_id:string;contact_target_id:string}>('SELECT id,account_id,channel,remote_id,contact_target_id FROM kff.customer_identities WHERE customer_id=$1 ORDER BY created_at,id',[id])).rows;
    const conversations=(await client.query<InboxConversation>('SELECT '+conversationColumns+conversationJoins+' WHERE v.customer_id=$1 ORDER BY v.last_message_at DESC,v.id',[id])).rows;
    const orders=(await client.query<{id:string;state:string;currency:string;total_minor:string}>('SELECT id,state,snapshot->>\'currency\' AS currency,snapshot->>\'total_minor\' AS total_minor FROM kff.orders WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100',[id])).rows;
    await audit(client,scope,'customer.detail_viewed',id);
    return {customer,events,identities,conversations,orders,acquisition_source:'UNKNOWN' as const,verified_payment:false as const};
  });
}
async function previousCustomerRequest(client:PoolClient,id:string,requestId:string,hash:string) {
  const old=(await client.query('SELECT customer_id,details,event_type FROM kff.customer_events WHERE request_id=$1',[requestId])).rows[0];
  if(!old)return null;
  requireCondition(old.customer_id===id&&old.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','同一请求已经用于不同客户或内容',409);return old;
}
export async function updateCustomer(scope:Scope,id:string,input:z.infer<typeof customerUpdateInput>) {
  requireWrite(scope);const value=customerUpdateInput.parse(input);const hash=digest({customer_id:id,...value});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer-request/'+scope.brand_id+'/'+value.request_id]);
    const old=await previousCustomerRequest(client,id,value.request_id,hash);if(old)return old.details.result as Customer;
    const customer=(await client.query<Customer>('SELECT * FROM kff.customers WHERE id=$1 FOR UPDATE',[id])).rows[0];
    requireCondition(customer,'NOT_FOUND','客户不存在',404);
    requireCondition(customer.version===value.expected_version,'VERSION_CONFLICT','客户有新消息或档案已更新，请刷新后重新核对',409);
    if(value.owner_user_id){
      const member=(await client.query("SELECT user_id FROM kff.memberships WHERE user_id=$1 AND role IN ('admin','operator')",[value.owner_user_id])).rows[0];
      requireCondition(member,'FORBIDDEN_SCOPE','负责人必须是本品牌有处理权限的成员',403);
    }
    if(value.stage==='OPTED_OUT'){
      const targets=(await client.query('SELECT t.id,t.opted_out FROM kff.contact_targets t JOIN kff.customer_identities i ON i.contact_target_id=t.id WHERE i.customer_id=$1 ORDER BY t.id FOR UPDATE OF t',[id])).rows;
      for(const target of targets)if(!target.opted_out){
        await client.query('UPDATE kff.contact_targets SET opted_out=true,opted_out_at=clock_timestamp(),version=version+1 WHERE id=$1',[target.id]);
        await audit(client,scope,'contact.opted_out',target.id,{customer_id:id,reason:value.reason,request_id:value.request_id});
      }
    }
    // Changing a customer stage away from OPTED_OUT never restores permission; new explicit consent is required.
    const result=(await client.query<Customer>('UPDATE kff.customers SET display_name=$1,owner_user_id=$2,stage=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$4 RETURNING *',[value.display_name,value.owner_user_id,value.stage,id])).rows[0];
    const details={request_hash:hash,reason:value.reason,before:{display_name:customer.display_name,owner_user_id:customer.owner_user_id,stage:customer.stage,version:customer.version},result};
    await client.query("INSERT INTO kff.customer_events(organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'PROFILE_UPDATED',$4,$5,$6,$7)",[scope.organization_id,scope.brand_id,id,scope.user_id,details,value.request_id,hash]);
    await audit(client,scope,'customer.profile_updated',id,{version:result.version,request_id:value.request_id});return result;
  });
}
export async function addCustomerNote(scope:Scope,id:string,input:z.infer<typeof customerNoteInput>) {
  requireWrite(scope);const value=customerNoteInput.parse(input);const hash=digest({customer_id:id,...value});
  return scoped(scope,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer-request/'+scope.brand_id+'/'+value.request_id]);
    const old=await previousCustomerRequest(client,id,value.request_id,hash);if(old)return old.details.result as {id:string};
    requireCondition((await client.query('SELECT id FROM kff.customers WHERE id=$1',[id])).rowCount,'NOT_FOUND','客户不存在',404);
    const result={id:randomUUID()};
    await client.query("INSERT INTO kff.customer_events(id,organization_id,brand_id,customer_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,$4,'NOTE',$5,$6,$7,$8)",[result.id,scope.organization_id,scope.brand_id,id,scope.user_id,{text:value.text,request_hash:hash,result},value.request_id,hash]);
    await audit(client,scope,'customer.note_added',id,{event_id:result.id});return result;
  });
}
