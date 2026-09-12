import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {query,scoped,transaction} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {stripeConnectionInput,checkoutInput,paymentRecheckInput,stripeConnectionControlInput,type StripeConnection,type PaymentCheckout,type VerifiedPayment} from '../../contracts/src/payment';
import {orderSnapshotSchema,type OwnedOrder} from '../../contracts/src/order';
import {audit,requireAdmin,requireWrite} from './service';
import {digest,requireCondition} from './index';
import {stripeGateway,stripeCheckoutRequest,verifyStripeWebhook,type StripeGatewayFactory} from './stripe-gateway';

export const publicCheckoutColumns='id,order_id,connection_id,state,snapshot_hash,amount_minor::text,currency,minor_unit_exponent,provider_session_id,provider_intent_id,checkout_url,error_code,created_at,submitted_at';
export function connectionScope(connection:StripeConnection):Scope{return {organization_id:connection.organization_id,brand_id:connection.brand_id,user_id:connection.created_by,role:'admin'};}
export async function paymentLock(client:PoolClient,brandId:string,key:string){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['payment/'+brandId+'/'+key]);}
export async function privateStripeConnection(id:string){const connection=(await query<StripeConnection>('SELECT * FROM kff.stripe_connections WHERE id=$1',[id]))[0];requireCondition(connection,'NOT_FOUND','支付连接不存在',404);return connection;}
export async function paymentOutboundScope<T>(scope:Scope,fn:(client:PoolClient)=>Promise<T>){return transaction(async client=>{
  // Organization control is read-only for kff_app. Lock only the explicit server-authenticated scope
  // before assuming that role, without granting business callers organization mutation privileges.
  const found=await client.query('SELECT b.id FROM kff.brands b JOIN kff.organizations o ON o.id=b.organization_id WHERE b.id=$1 AND o.id=$2 FOR SHARE OF b,o',[scope.brand_id,scope.organization_id]);requireCondition(found.rowCount,'FORBIDDEN_SCOPE','支付组织或品牌范围无效',403);
  await client.query("SELECT set_config('kff.organization_id',$1,true),set_config('kff.brand_id',$2,true),set_config('kff.user_id',$3,true)",[scope.organization_id,scope.brand_id,scope.user_id]);await client.query('SET LOCAL ROLE kff_app');return fn(client);
});}
export async function assertPaymentOutbound(client:PoolClient,connection:StripeConnection,actorId:string){
  const status=(await client.query('SELECT b.outbound_paused OR o.outbound_paused AS paused FROM kff.brands b JOIN kff.organizations o ON o.id=b.organization_id WHERE b.id=$1',[connection.brand_id])).rows[0];
  requireCondition(status&&!status.paused&&connection.outbound_enabled,'STOP_REQUESTED','组织、品牌或支付连接已暂停创建新支付',409);
  requireCondition(connection.mode==='TEST'||process.env.KFF_ENABLE_LIVE==='true','LIVE_DISABLED','真实 Stripe 收款尚未启用',409);
  requireCondition((await client.query("SELECT 1 FROM kff.memberships WHERE user_id=$1 AND role IN ('admin','operator')",[actorId])).rowCount,'FORBIDDEN_SCOPE','创建支付的人员已无此品牌操作权限',403);
}
export async function registerStripeConnection(scope:Scope,input:z.infer<typeof stripeConnectionInput>,factory:StripeGatewayFactory=stripeGateway){
  requireAdmin(scope);const value=stripeConnectionInput.parse(input),hash=digest(value);
  const prior=await scoped(scope,async client=>(await client.query<StripeConnection&{request_hash:string}>('SELECT * FROM kff.stripe_connections WHERE request_id=$1',[value.request_id])).rows[0]);
  if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同 Stripe 连接',409);return {id:prior.id};}
  const connection:StripeConnection={id:randomUUID(),organization_id:scope.organization_id,brand_id:scope.brand_id,name:value.name,stripe_account_id:value.stripe_account_id,mode:value.mode,credential_ref:value.credential_ref,is_synthetic:false,outbound_enabled:true,version:1,created_by:scope.user_id};
  const gateway=await factory(connection),identity=await gateway.identity();requireCondition(identity.id===value.stripe_account_id,'STRIPE_ACCOUNT_MISMATCH','Stripe 商户身份不匹配',403);
  requireCondition(!gateway.isSynthetic||value.mode==='TEST','STRIPE_MODE_MISMATCH','合成连接只能用于测试',403);connection.is_synthetic=gateway.isSynthetic;
  return scoped(scope,async client=>{
    await paymentLock(client,scope.brand_id,'connection/'+value.request_id);
    const old=(await client.query('SELECT id,request_hash FROM kff.stripe_connections WHERE request_id=$1',[value.request_id])).rows[0];if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同 Stripe 连接',409);return {id:old.id as string};}
    await client.query('INSERT INTO kff.stripe_connections(id,organization_id,brand_id,name,stripe_account_id,mode,credential_ref,is_synthetic,created_by,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[connection.id,scope.organization_id,scope.brand_id,value.name,value.stripe_account_id,value.mode,value.credential_ref,gateway.isSynthetic,scope.user_id,value.request_id,hash]);
    await audit(client,scope,'stripe.connection_registered',connection.id,{mode:value.mode,stripe_account_id:value.stripe_account_id,is_synthetic:gateway.isSynthetic});return {id:connection.id};
  });
}
export async function paymentWorkspace(scope:Scope,orderId?:string){return scoped(scope,async client=>{
  if(orderId)requireCondition((await client.query('SELECT id FROM kff.orders WHERE id=$1',[orderId])).rowCount,'NOT_FOUND','订单不存在',404);
  const connections=(await client.query<Pick<StripeConnection,'id'|'name'|'stripe_account_id'|'mode'|'is_synthetic'|'outbound_enabled'|'version'>>('SELECT id,name,stripe_account_id,mode,is_synthetic,outbound_enabled,version FROM kff.stripe_connections ORDER BY created_at DESC')).rows;
  const checkouts=(await client.query<PaymentCheckout>('SELECT '+publicCheckoutColumns+' FROM kff.payment_checkouts WHERE ($1::uuid IS NULL OR order_id=$1) ORDER BY created_at DESC,id LIMIT 100',[orderId??null])).rows;
  const verified=(await client.query<VerifiedPayment>('SELECT id,order_id,checkout_id,connection_id,provider_intent_id,mode,is_synthetic,amount_minor::text,currency,minor_unit_exponent,verified_at FROM kff.verified_payments WHERE ($1::uuid IS NULL OR order_id=$1) ORDER BY verified_at DESC LIMIT 100',[orderId??null])).rows;
  const events=(await client.query("SELECT e.id,e.connection_id,e.provider_event_id,e.event_type,e.state,e.error_code,e.received_at FROM kff.stripe_events e WHERE ($1::uuid IS NULL OR e.payload->'session'->'metadata'->>'kff_order_id'=$1::text) ORDER BY e.received_at DESC LIMIT 100",[orderId??null])).rows;
  return {provider:'stripe' as const,connections,checkouts,verified,events};
});}
export async function queueStripeCheckout(scope:Scope,orderId:string,input:z.infer<typeof checkoutInput>){
  requireWrite(scope);const value=checkoutInput.parse(input),hash=digest({order_id:orderId,input:value});
  return paymentOutboundScope(scope,async client=>{
    await paymentLock(client,scope.brand_id,'checkout-request/'+value.request_id);
    const prior=(await client.query<PaymentCheckout>('SELECT * FROM kff.payment_checkouts WHERE request_id=$1',[value.request_id])).rows[0];
    if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同支付内容',409);return {id:prior.id,state:prior.state};}
    const order=(await client.query<OwnedOrder>('SELECT * FROM kff.orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];requireCondition(order,'NOT_FOUND','订单不存在',404);
    const connection=(await client.query<StripeConnection>('SELECT * FROM kff.stripe_connections WHERE id=$1 FOR SHARE',[value.connection_id])).rows[0];requireCondition(connection,'NOT_FOUND','支付连接不存在',404);
    await assertPaymentOutbound(client,connection,scope.user_id);
    requireCondition(order.version===value.expected_version&&order.state==='OPEN'&&order.payment_state==='UNVERIFIED','ORDER_STATE_CHANGED','订单状态已经变化，不能创建支付',409);
    requireCondition(order.snapshot_hash===value.snapshot_hash&&digest(order.snapshot)===value.snapshot_hash,'SNAPSHOT_CHANGED','订单快照不匹配',409);
    requireCondition(!(await client.query("SELECT 1 FROM kff.payment_checkouts WHERE order_id=$1 AND state NOT IN ('EXPIRED','FAILED')",[orderId])).rowCount,'PAYMENT_ALREADY_PENDING','此订单已有支付请求，请查看或核对原请求',409);
    const snapshot=orderSnapshotSchema.parse(order.snapshot),total=snapshot.lines.reduce((sum,line)=>sum+BigInt(line.unit_amount_minor)*BigInt(line.quantity),0n);
    requireCondition(total.toString()===snapshot.total_minor,'ORDER_AMOUNT_MISMATCH','订单项目与总额不一致',409);
    const id=randomUUID(),request=stripeCheckoutRequest(snapshot,orderId,id,scope.brand_id,value.snapshot_hash);
    await client.query('INSERT INTO kff.payment_checkouts(id,organization_id,brand_id,order_id,connection_id,snapshot_hash,amount_minor,currency,minor_unit_exponent,provider_request,request_id,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,scope.organization_id,scope.brand_id,orderId,connection.id,value.snapshot_hash,snapshot.total_minor,snapshot.currency,snapshot.minor_unit_exponent,request,value.request_id,hash,scope.user_id]);
    await audit(client,scope,'stripe.checkout_queued',id,{order_id:orderId,mode:connection.mode,snapshot_hash:value.snapshot_hash});return {id,state:'READY' as const};
  });
}
export async function receiveStripeWebhook(connectionId:string,raw:Buffer,signature:string|null){
  const connection=await privateStripeConnection(connectionId),payload=verifyStripeWebhook(connection,raw,signature),hash=digest(payload),scope=connectionScope(connection);
  return scoped(scope,async client=>{
    await paymentLock(client,scope.brand_id,'event/'+connection.id+'/'+payload.id);
    const old=(await client.query('SELECT id,payload_hash FROM kff.stripe_events WHERE connection_id=$1 AND provider_event_id=$2',[connectionId,payload.id])).rows[0];
    if(old){requireCondition(old.payload_hash===hash,'IDEMPOTENCY_CONFLICT','同一 Stripe 事件的内容发生变化',409);return {receipt:'STORED' as const,duplicate:true};}
    const id=randomUUID(),inbound=randomUUID();
    await client.query("INSERT INTO kff.inbound_events(id,organization_id,brand_id,source_kind,source_key,payload_hash) VALUES($1,$2,$3,'stripe',$4,$5)",[inbound,scope.organization_id,scope.brand_id,connectionId+'/'+payload.id,hash]);
    await client.query('INSERT INTO kff.stripe_events(id,organization_id,brand_id,connection_id,inbound_event_id,provider_event_id,event_type,event_created_at,payload,payload_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,scope.organization_id,scope.brand_id,connectionId,inbound,payload.id,payload.type,new Date(payload.created*1000),payload,hash,payload.session?'PENDING':'IGNORED']);
    await audit(client,scope,'stripe.event_stored',id,{provider_event_id:payload.id,event_type:payload.type,mode:connection.mode});return {receipt:'STORED' as const,duplicate:false};
  });
}
export async function requestPaymentRecheck(scope:Scope,id:string,input:z.infer<typeof paymentRecheckInput>){
  requireWrite(scope);const value=paymentRecheckInput.parse(input),hash=digest({id,input:value});return scoped(scope,async client=>{
    await paymentLock(client,scope.brand_id,'recheck/'+value.request_id);const prior=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='stripe.recheck_requested' AND details->>'request_id'=$1",[value.request_id])).rows[0];if(prior){requireCondition(prior.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同核对',409);return {queued:true};}
    const checkout=(await client.query<PaymentCheckout>('SELECT * FROM kff.payment_checkouts WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(checkout,'NOT_FOUND','支付请求不存在',404);
    requireCondition(checkout.provider_session_id,'STRIPE_OBJECT_UNKNOWN','支付对象尚未确认；保留原请求等待核对',409);
    requireCondition(!['PAID','EXPIRED','FAILED'].includes(checkout.state),'PAYMENT_ALREADY_FINAL','此支付请求已有确定结果，请查看记录',409);
    // Rechecks only retrieve the known object. They can never create a second Checkout Session.
    await client.query("UPDATE kff.payment_checkouts SET state=CASE WHEN state='PAID' THEN state ELSE 'PENDING' END,next_check_at=clock_timestamp(),checks=0,error_code=NULL WHERE id=$1",[id]);
    await audit(client,scope,'stripe.recheck_requested',id,{request_id:value.request_id,request_hash:hash,reason:value.reason});return {queued:true};
  });
}
export async function controlStripeConnection(scope:Scope,id:string,input:z.infer<typeof stripeConnectionControlInput>){
  requireAdmin(scope);const value=stripeConnectionControlInput.parse(input),hash=digest({id,input:value});return scoped(scope,async client=>{
    await paymentLock(client,scope.brand_id,'control/'+value.request_id);const prior=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='stripe.connection_controlled' AND details->>'request_id'=$1",[value.request_id])).rows[0];if(prior){requireCondition(prior.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同连接控制',409);return prior.details.result as {id:string;version:number;outbound_enabled:boolean};}
    const connection=(await client.query<StripeConnection>('SELECT * FROM kff.stripe_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(connection,'NOT_FOUND','支付连接不存在',404);requireCondition(connection.version===value.expected_version,'VERSION_CONFLICT','支付连接状态已经变化',409);
    const result=(await client.query('UPDATE kff.stripe_connections SET outbound_enabled=$1,version=version+1 WHERE id=$2 RETURNING id,version,outbound_enabled',[value.outbound_enabled,id])).rows[0];
    await audit(client,scope,'stripe.connection_controlled',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,result});return result;
  });
}
