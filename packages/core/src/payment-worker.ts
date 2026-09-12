import {randomUUID} from 'node:crypto';
import Stripe from 'stripe';
import {z} from 'zod';
import {query,scoped} from '@kff/database';
import type {PaymentCheckout,StripeConnection,VerifiedPayment} from '../../contracts/src/payment';
import type {OwnedOrder} from '../../contracts/src/order';
import {AppError,requireCondition} from './index';
import {audit} from './service';
import {connectionScope,privateStripeConnection,assertPaymentOutbound,paymentOutboundScope} from './payments';
import {stripeGateway,safeCheckoutUrl,type StripeGatewayFactory,type StripeGateway,type StripeSession,type StripeIntent,type VerifiedStripeEvent} from './stripe-gateway';

interface EventJob {id:string;connection_id:string;payload:VerifiedStripeEvent;attempts:number;lease_token:string}
function intentId(session:StripeSession){return typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id??null;}
export function validatePaymentSession(checkout:PaymentCheckout,connection:StripeConnection,session:StripeSession){
  const data=session.metadata;
  requireCondition(session.mode==='payment'&&session.livemode===(connection.mode==='LIVE'),'STRIPE_MODE_MISMATCH','Stripe 支付模式不匹配',409);
  requireCondition(session.amount_total!==null&&String(session.amount_total)===checkout.amount_minor&&session.currency===checkout.currency.toLowerCase(),'STRIPE_AMOUNT_MISMATCH','Stripe 金额或币种与订单不一致',409);
  requireCondition(session.client_reference_id===checkout.order_id&&data?.kff_order_id===checkout.order_id&&data.kff_checkout_id===checkout.id&&data.kff_brand_id===checkout.brand_id&&data.kff_snapshot_hash===checkout.snapshot_hash,'STRIPE_OBJECT_MISMATCH','Stripe 对象与订单关联不一致',409);
  requireCondition(!checkout.provider_session_id||checkout.provider_session_id===session.id,'STRIPE_OBJECT_MISMATCH','Stripe Session 与已保存对象不一致',409);
  requireCondition(!checkout.provider_intent_id||checkout.provider_intent_id===intentId(session),'STRIPE_OBJECT_MISMATCH','Stripe PaymentIntent 与已保存对象不一致',409);
}
function validateIntent(checkout:PaymentCheckout,connection:StripeConnection,session:StripeSession,intent:StripeIntent){
  requireCondition(intent.id===intentId(session)&&intent.livemode===(connection.mode==='LIVE')&&intent.currency===checkout.currency.toLowerCase()&&String(intent.amount)===checkout.amount_minor,'STRIPE_OBJECT_MISMATCH','Stripe PaymentIntent 金额、币种或身份不一致',409);
  requireCondition(intent.metadata.kff_checkout_id===checkout.id&&intent.metadata.kff_order_id===checkout.order_id&&intent.metadata.kff_brand_id===checkout.brand_id&&intent.metadata.kff_snapshot_hash===checkout.snapshot_hash,'STRIPE_OBJECT_MISMATCH','Stripe PaymentIntent 元数据不匹配',409);
}
async function gatewayFor(connection:StripeConnection,factory:StripeGatewayFactory){const gateway=await factory(connection);requireCondition(gateway.isSynthetic===connection.is_synthetic,'STRIPE_MODE_MISMATCH','合成驱动和支付连接范围不一致',403);const identity=await gateway.identity();requireCondition(identity.id===connection.stripe_account_id,'STRIPE_ACCOUNT_MISMATCH','Stripe 商户身份不匹配',403);return {gateway,identity};}
async function retrieve(gateway:StripeGateway,id:string){const session=await gateway.retrieveSession(id),pi=intentId(session);return {session,intent:pi?await gateway.retrieveIntent(pi):null};}
async function applyObservation(connection:StripeConnection,checkoutId:string,session:StripeSession,intent:StripeIntent|null,event?:EventJob,checkoutToken?:string){
  const scope=connectionScope(connection);return scoped(scope,async client=>{
    if(event){const own=(await client.query("SELECT id FROM kff.stripe_events WHERE id=$1 AND state='PROCESSING' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE",[event.id,event.lease_token])).rows[0];if(!own)return false;}
    const reference=(await client.query<{order_id:string}>('SELECT order_id FROM kff.payment_checkouts WHERE id=$1',[checkoutId])).rows[0];requireCondition(reference,'STRIPE_OBJECT_MISMATCH','支付关联不存在',409);
    const order=(await client.query<OwnedOrder>('SELECT * FROM kff.orders WHERE id=$1 FOR UPDATE',[reference.order_id])).rows[0];
    const checkout=(await client.query<PaymentCheckout>('SELECT * FROM kff.payment_checkouts WHERE id=$1 FOR UPDATE',[checkoutId])).rows[0];
    if(checkoutToken){const live=(await client.query('SELECT lease_token=$2 AND lease_until>clock_timestamp() AS valid FROM kff.payment_checkouts WHERE id=$1',[checkoutId,checkoutToken])).rows[0];if(!live.valid)return false;}
    requireCondition(checkout.connection_id===connection.id,'STRIPE_OBJECT_MISMATCH','支付连接不匹配',409);validatePaymentSession(checkout,connection,session);
    if(event?.payload.session){validatePaymentSession(checkout,connection,event.payload.session);requireCondition(event.payload.session.id===session.id&&(!intentId(event.payload.session)||intentId(event.payload.session)===intentId(session)),'STRIPE_OBJECT_MISMATCH','回调对象与查询对象不一致',409);}
    if(intent)validateIntent(checkout,connection,session,intent);
    await client.query('UPDATE kff.payment_checkouts SET provider_session_id=$1,provider_intent_id=COALESCE(provider_intent_id,$2) WHERE id=$3',[session.id,intentId(session),checkout.id]);
    let state=checkout.state;
    if(session.payment_status==='paid'){
      requireCondition(session.status==='complete'&&intent?.status==='succeeded'&&String(intent.amount_received)===checkout.amount_minor,'STRIPE_PAYMENT_NOT_CONFIRMED','Stripe 尚未确认完整到账金额',409);
      requireCondition(order.state==='OPEN'&&order.snapshot_hash===checkout.snapshot_hash,'ORDER_STATE_CHANGED','订单状态与支付对象冲突',409);
      const proof={session:{id:session.id,status:session.status,payment_status:session.payment_status,amount_total:session.amount_total,currency:session.currency,livemode:session.livemode,metadata:session.metadata},intent,account_id:connection.stripe_account_id};
      await client.query("INSERT INTO kff.verified_payments(organization_id,brand_id,order_id,checkout_id,connection_id,provider_intent_id,provider_session_id,mode,is_synthetic,amount_minor,currency,minor_unit_exponent,source_event_id,verified_via,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING",[scope.organization_id,scope.brand_id,order.id,checkout.id,connection.id,intent.id,session.id,connection.mode,connection.is_synthetic,checkout.amount_minor,checkout.currency,checkout.minor_unit_exponent,event?.id??null,event?'WEBHOOK_AND_QUERY':'SERVER_QUERY',proof]);
      const receipt=(await client.query<VerifiedPayment>('SELECT * FROM kff.verified_payments WHERE order_id=$1',[order.id])).rows[0];requireCondition(receipt&&receipt.checkout_id===checkout.id&&receipt.provider_intent_id===intent.id,'STRIPE_DUPLICATE_PAYMENT_OBJECT','支付对象已关联其他记录，需要人工核对',409);
      if(order.payment_state==='UNVERIFIED'){const paymentState=connection.mode==='LIVE'&&!connection.is_synthetic?'VERIFIED_PAID':'VERIFIED_TEST_PAID';await client.query('UPDATE kff.orders SET payment_state=$1,version=version+1 WHERE id=$2',[paymentState,order.id]);await audit(client,scope,'stripe.payment_verified',order.id,{payment_id:receipt.id,checkout_id:checkout.id,mode:connection.mode,is_synthetic:connection.is_synthetic,source_event_id:event?.id??null});}
      state='PAID';
    }else if(checkout.state!=='PAID'){
      requireCondition(session.payment_status==='unpaid','STRIPE_PAYMENT_NOT_CONFIRMED','无收款支付不能记为已付款',409);
      if(session.status==='expired'){requireCondition(!intent||intent.status!=='succeeded','STRIPE_PAYMENT_NOT_CONFIRMED','过期会话与付款状态冲突',409);state='EXPIRED';}
      else if(session.status==='open')state='OPEN';
      else if(session.status==='complete')state=intent?.status==='canceled'||(event?.payload.type==='checkout.session.async_payment_failed'&&intent?.status==='requires_payment_method')?'FAILED':'PENDING';
      else throw new AppError('STRIPE_PAYMENT_NOT_CONFIRMED','Stripe 会话状态无法确认',409);
    }
    const url=state==='OPEN'?safeCheckoutUrl(session.url):null;
    await client.query("UPDATE kff.payment_checkouts SET state=$1,checkout_url=$2,error_code=NULL,checks=0,next_check_at=clock_timestamp()+interval '15 minutes',lease_token=NULL,lease_until=NULL WHERE id=$3",[state,url,checkout.id]);
    if(event)await client.query("UPDATE kff.stripe_events SET state='PROCESSED',error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[event.id]);
    return true;
  });
}
function failureCode(error:unknown){return error instanceof AppError?error.code:'STRIPE_UNAVAILABLE';}
function isRetryable(code:string){return ['STRIPE_UNAVAILABLE','STRIPE_CREDENTIALS_UNCONFIGURED','STRIPE_AUTH_REQUIRED'].includes(code);}
export async function processStripeCheckout(id?:string,factory:StripeGatewayFactory=stripeGateway){
  const rows=await query<{id:string;connection_id:string}>("SELECT p.id,p.connection_id FROM kff.payment_checkouts p JOIN kff.stripe_connections c ON c.id=p.connection_id WHERE p.state IN ('READY','CREATING','OPEN','PENDING') AND (p.lease_until IS NULL OR p.lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR p.id=$1) AND ($1::uuid IS NOT NULL OR (p.next_check_at<=clock_timestamp() AND NOT c.is_synthetic)) ORDER BY p.next_check_at LIMIT 1",[id??null]);if(!rows[0])return false;
  const connection=await privateStripeConnection(rows[0].connection_id),scope=connectionScope(connection),token=randomUUID();
  const claimed=await scoped(scope,async client=>(await client.query<PaymentCheckout>("UPDATE kff.payment_checkouts SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',checks=checks+1 WHERE id=$1 AND state IN ('READY','CREATING','OPEN','PENDING') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *",[rows[0].id,token])).rows[0]);if(!claimed)return false;
  let definiteNoCreation=false;
  try{
    const {gateway,identity}=await gatewayFor(connection,factory);let session:StripeSession,intent:StripeIntent|null;
    if(claimed.provider_session_id)({session,intent}=await retrieve(gateway,claimed.provider_session_id));
    else {
      if(!identity.currencies.includes(claimed.currency.toLowerCase())){definiteNoCreation=!claimed.submitted_at;throw new AppError('STRIPE_CURRENCY_UNSUPPORTED','此 Stripe 商户所在地区不支持订单币种');}
      const canSubmit=await paymentOutboundScope(scope,async client=>{
        const current=(await client.query<StripeConnection>('SELECT * FROM kff.stripe_connections WHERE id=$1 FOR SHARE',[connection.id])).rows[0];await assertPaymentOutbound(client,current,claimed.created_by);
        const lease=(await client.query("SELECT lease_token=$2 AND lease_until>clock_timestamp() AS valid,submitted_at IS NULL OR submitted_at>clock_timestamp()-interval '23 hours' AS within_window FROM kff.payment_checkouts WHERE id=$1 FOR UPDATE",[claimed.id,token])).rows[0];if(!lease.valid)return false;
        requireCondition(lease.within_window,'STRIPE_IDEMPOTENCY_WINDOW_EXPIRED','原支付结果未知且已超过安全重试窗口，需要人工核对',409);
        await client.query("UPDATE kff.payment_checkouts SET state='CREATING',submitted_at=COALESCE(submitted_at,clock_timestamp()) WHERE id=$1",[claimed.id]);return true;
      });if(!canSubmit)return false;
      try{session=await gateway.createSession(claimed.provider_request as Stripe.Checkout.SessionCreateParams,'kff-checkout-'+claimed.id);}
      catch(error){definiteNoCreation=!claimed.submitted_at&&failureCode(error)==='STRIPE_REQUEST_REJECTED';throw error;}
      // Attach only a verified object; a crash or lost response retries the identical immutable request/key.
      validatePaymentSession(claimed,connection,session);const pi=intentId(session);intent=pi?await gateway.retrieveIntent(pi):null;
    }
    await applyObservation(connection,claimed.id,session,intent,undefined,token);
  }catch(error){
    const code=failureCode(error),waiting=['STOP_REQUESTED','LIVE_DISABLED'].includes(code),retry=waiting||(isRetryable(code)&&claimed.checks<8);
    await scoped(scope,async client=>{await client.query("UPDATE kff.payment_checkouts SET state=CASE WHEN state='PAID' THEN state WHEN $3 THEN state WHEN $4 THEN 'FAILED' ELSE 'NEEDS_HUMAN' END,error_code=$5,next_check_at=clock_timestamp()+($6::text||' seconds')::interval,checks=CASE WHEN $7 THEN 0 ELSE checks END,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",[claimed.id,token,retry,definiteNoCreation,code,waiting?60:Math.min(3600,2**claimed.checks*15),waiting]);if(claimed.error_code!==code)await audit(client,scope,'stripe.checkout_check_failed',claimed.id,{error_code:code});});
  }
  return true;
}
export async function processStripeEvent(id?:string,factory:StripeGatewayFactory=stripeGateway){
  const rows=await query<{id:string;connection_id:string}>("SELECT e.id,e.connection_id FROM kff.stripe_events e JOIN kff.stripe_connections c ON c.id=e.connection_id WHERE e.state IN ('PENDING','PROCESSING') AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR e.id=$1) AND ($1::uuid IS NOT NULL OR (e.next_attempt_at<=clock_timestamp() AND NOT c.is_synthetic)) ORDER BY e.next_attempt_at LIMIT 1",[id??null]);if(!rows[0])return false;
  const connection=await privateStripeConnection(rows[0].connection_id),scope=connectionScope(connection),token=randomUUID();
  const event=await scoped(scope,async client=>(await client.query<EventJob>("UPDATE kff.stripe_events SET state='PROCESSING',lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 WHERE id=$1 AND state IN ('PENDING','PROCESSING') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *",[rows[0].id,token])).rows[0]);if(!event)return false;
  try{
    const session=event.payload.session,checkoutId=session?.metadata?.kff_checkout_id;requireCondition(session&&z.string().uuid().safeParse(checkoutId).success,'STRIPE_OBJECT_MISMATCH','回调没有有效的 KFF 支付关联',409);
    const checkout=await scoped(scope,async client=>(await client.query<PaymentCheckout>('SELECT * FROM kff.payment_checkouts WHERE id=$1 AND connection_id=$2',[checkoutId,connection.id])).rows[0]);requireCondition(checkout,'STRIPE_OBJECT_MISMATCH','回调未关联到此连接的 KFF 支付请求',409);
    validatePaymentSession(checkout,connection,session);const {gateway}=await gatewayFor(connection,factory),latest=await retrieve(gateway,session.id);
    await applyObservation(connection,checkout.id,latest.session,latest.intent,event);
  }catch(error){const code=failureCode(error),retry=isRetryable(code)&&event.attempts<8;await scoped(scope,async client=>{await client.query('UPDATE kff.stripe_events SET state=$3,error_code=$4,next_attempt_at=clock_timestamp()+($5::text||\' seconds\')::interval,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[event.id,token,retry?'PENDING':isRetryable(code)?'NEEDS_HUMAN':'REJECTED',code,Math.min(3600,2**event.attempts*15)]);await audit(client,scope,'stripe.event_check_failed',event.id,{error_code:code});});}
  return true;
}
