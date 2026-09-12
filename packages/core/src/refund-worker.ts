import {randomUUID} from 'node:crypto';
import type Stripe from 'stripe';
import {query,scoped} from '@kff/database';
import type {StripeConnection} from '../../contracts/src/payment';
import type {RefundLedger,RefundRequest} from '../../contracts/src/refund';
import {AppError,requireCondition} from './index';
import {privateStripeConnection,connectionScope,paymentOutboundScope} from './payments';
import {lockRefundLedger,refundBalance,assertRefundOutbound} from './refunds';
import {audit} from './service';
import {stripeFinancialGateway,type StripeFinancialGatewayFactory} from './stripe-financial-gateway';
import {captureFinancialSnapshot,applyFinancialSnapshot,validateRefundObject,validateRequestedRefund,type FinancialPayment,type FinancialEvent} from './refund-reconciliation';

function codeOf(error:unknown){return error instanceof AppError?error.code:'STRIPE_UNAVAILABLE';}
const temporary=new Set(['STRIPE_UNAVAILABLE','STRIPE_CREDENTIALS_UNCONFIGURED','STRIPE_AUTH_REQUIRED','FINANCIAL_BUSY','FINANCIAL_LEASE_LOST']);
export async function processRefundLedger(paymentId?:string,factory:StripeFinancialGatewayFactory=stripeFinancialGateway,options:{event?:FinancialEvent;allowCreate?:boolean}={}){
 const found=(await query<{payment_id:string;connection_id:string}>("SELECT l.payment_id,l.connection_id FROM kff.refund_ledgers l JOIN kff.stripe_connections c ON c.id=l.connection_id WHERE (l.lease_until IS NULL OR l.lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR l.payment_id=$1) AND ($1::uuid IS NOT NULL OR (NOT c.is_synthetic AND l.checks<8 AND l.next_check_at<=clock_timestamp())) ORDER BY l.next_check_at LIMIT 1",[paymentId??null]))[0];
 if(!found){if(options.event)throw new AppError('FINANCIAL_BUSY','原付款正在核对，事件保留等待',409);return false;}
 const connection=await privateStripeConnection(found.connection_id),scope=connectionScope(connection),token=randomUUID();
 const ledger=await scoped(scope,async client=>(await client.query<RefundLedger>("UPDATE kff.refund_ledgers SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',checks=checks+1 WHERE payment_id=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *",[found.payment_id,token])).rows[0]);
 if(!ledger){if(options.event)throw new AppError('FINANCIAL_BUSY','原付款已由其他处理者核对',409);return false;}
 let activeRequest:RefundRequest|undefined,definiteRejection=false;
 const renew=async()=>scoped(scope,async client=>{requireCondition((await client.query("UPDATE kff.refund_ledgers SET lease_until=clock_timestamp()+interval '90 seconds' WHERE payment_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",[ledger.payment_id,token])).rowCount,'FINANCIAL_LEASE_LOST','财务核验租约已经失效',409);if(options.event)requireCondition((await client.query("UPDATE kff.stripe_events SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND state='PROCESSING' AND lease_until>clock_timestamp()",[options.event.id,options.event.lease_token])).rowCount,'FINANCIAL_LEASE_LOST','财务事件租约已经失效',409);});
 try{
  const gateway=await factory(connection);requireCondition(gateway.isSynthetic===connection.is_synthetic,'STRIPE_MODE_MISMATCH','财务驱动与连接模式不匹配',403);await renew();requireCondition((await gateway.identity()).id===connection.stripe_account_id,'STRIPE_ACCOUNT_MISMATCH','Stripe 财务商户身份不匹配',403);
  const original=await scoped(scope,async client=>(await client.query<FinancialPayment>('SELECT p.*,c.snapshot_hash FROM kff.verified_payments p JOIN kff.payment_checkouts c ON c.id=p.checkout_id WHERE p.id=$1',[ledger.payment_id])).rows[0]);requireCondition(original,'NOT_FOUND','原付款凭据不存在',404);
  const known=async()=>scoped(scope,async client=>({refunds:(await client.query<{id:string}>('SELECT provider_refund_id AS id FROM kff.stripe_refunds WHERE payment_id=$1 UNION SELECT provider_refund_id AS id FROM kff.refund_requests WHERE payment_id=$1 AND provider_refund_id IS NOT NULL',[ledger.payment_id])).rows.map(row=>row.id),disputes:(await client.query<{id:string}>('SELECT provider_dispute_id AS id FROM kff.stripe_disputes WHERE payment_id=$1',[ledger.payment_id])).rows.map(row=>row.id)}));
  const snapshot=await captureFinancialSnapshot(gateway,original,connection,await known(),renew,options.event),applied=await applyFinancialSnapshot(connection,original,token,snapshot,options.event);
  if(!applied.blocked&&options.allowCreate!==false&&!options.event){
   const gate=await paymentOutboundScope(scope,async client=>{
    const currentConnection=(await client.query<StripeConnection>('SELECT * FROM kff.stripe_connections WHERE id=$1 FOR SHARE',[connection.id])).rows[0];const current=await lockRefundLedger(client,ledger.payment_id);
    requireCondition((await client.query('SELECT lease_token=$2 AND lease_until>clock_timestamp() AS valid FROM kff.refund_ledgers WHERE payment_id=$1',[ledger.payment_id,token])).rows[0].valid,'FINANCIAL_LEASE_LOST','退款提交租约已经失效',409);
    const request=(await client.query<RefundRequest>("SELECT * FROM kff.refund_requests WHERE payment_id=$1 AND state IN ('READY','SUBMITTING') AND provider_refund_id IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE",[ledger.payment_id])).rows[0];if(!request)return null;activeRequest=request;
    await assertRefundOutbound(client,currentConnection,request.created_by);const balance=await refundBalance(client,current);
    requireCondition(!current.refund_blocked&&!current.error_code,'REFUND_RECONCILIATION_REQUIRED','退款资格仍需核对',409);
    const available=BigInt(original.amount_minor)-BigInt(current.remote_reserved_minor)-(BigInt(balance.reserved_minor)-BigInt(request.amount_minor));requireCondition(available>=BigInt(request.amount_minor),'REFUND_AMOUNT_EXCEEDED','Stripe 当前可退额度已变化，保留申请等待处理',409);
    requireCondition((await client.query("SELECT submitted_at IS NULL OR submitted_at>clock_timestamp()-interval '23 hours' AS valid FROM kff.refund_requests WHERE id=$1",[request.id])).rows[0].valid,'STRIPE_IDEMPOTENCY_WINDOW_EXPIRED','原退款结果未知且已超过安全重试窗口，需要核对原请求',409);
    const updated=(await client.query<RefundRequest>("UPDATE kff.refund_requests SET state='SUBMITTING',submitted_at=coalesce(submitted_at,clock_timestamp()),error_code=NULL WHERE id=$1 RETURNING *",[request.id])).rows[0];if(!request.submitted_at)await audit(client,scope,'stripe.refund_submitting',request.id,{payment_id:original.id,amount_minor:request.amount_minor,mode:original.mode});return {request:updated,first:!request.submitted_at};
   });
   if(gate){activeRequest=gate.request;let refund;
    try{refund=await gateway.createRefund(gate.request.provider_request as Stripe.RefundCreateParams,'kff-refund-'+gate.request.id);}catch(error){definiteRejection=gate.first&&codeOf(error)==='STRIPE_REQUEST_REJECTED';throw error;}
    validateRefundObject(original,snapshot.payment.latest_charge!.id,refund);validateRequestedRefund(original,gate.request,refund);
    await scoped(scope,async client=>{await lockRefundLedger(client,original.id);requireCondition((await client.query('SELECT lease_token=$2 AND lease_until>clock_timestamp() AS valid FROM kff.refund_ledgers WHERE payment_id=$1',[original.id,token])).rows[0].valid,'FINANCIAL_LEASE_LOST','退款返回时租约已变化，保留原申请核对',409);await client.query('UPDATE kff.refund_requests SET provider_refund_id=$1 WHERE id=$2',[refund.id,gate.request.id]);});
    const latest=await captureFinancialSnapshot(gateway,original,connection,await known(),renew);await applyFinancialSnapshot(connection,original,token,latest);
   }
  }
  await scoped(scope,async client=>{await client.query("UPDATE kff.refund_ledgers l SET lease_token=NULL,lease_until=NULL,checks=0,next_check_at=CASE WHEN NOT l.refund_blocked AND EXISTS(SELECT 1 FROM kff.refund_requests r WHERE r.payment_id=l.payment_id AND r.state IN ('READY','SUBMITTING') AND r.provider_refund_id IS NULL) THEN clock_timestamp()+interval '1 second' ELSE clock_timestamp()+interval '15 minutes' END WHERE l.payment_id=$1 AND l.lease_token=$2",[ledger.payment_id,token]);});
 }catch(error){const code=codeOf(error),waiting=['STOP_REQUESTED','LIVE_DISABLED'].includes(code),retry=temporary.has(code)&&ledger.checks<8;
  await scoped(scope,async client=>{const owned=(await client.query('SELECT payment_id FROM kff.refund_ledgers WHERE payment_id=$1 AND lease_token=$2 FOR UPDATE',[ledger.payment_id,token])).rows[0];if(!owned)return;
   if(activeRequest&&!waiting&&!retry){await client.query("UPDATE kff.refund_requests SET state=CASE WHEN $2 THEN 'FAILED' ELSE 'NEEDS_HUMAN' END,error_code=$3 WHERE id=$1 AND state IN ('READY','SUBMITTING','NEEDS_HUMAN')",[activeRequest.id,definiteRejection,code]);}
   await client.query("UPDATE kff.refund_ledgers SET error_code=$1,checks=CASE WHEN $2 THEN 0 WHEN $3 THEN checks ELSE 8 END,version=version+1,lease_token=NULL,lease_until=NULL,next_check_at=clock_timestamp()+($4::text||' seconds')::interval WHERE payment_id=$5 AND lease_token=$6",[code,waiting,retry,waiting?60:Math.min(3600,2**ledger.checks*15),ledger.payment_id,token]);
   await audit(client,scope,'stripe.financial_check_failed',ledger.payment_id,{error_code:code,refund_request_id:activeRequest?.id??null,mode:connection.mode});});
  if(options.event)throw error;
 }
 return true;
}
export async function processFinancialStripeEvent(connection:StripeConnection,event:FinancialEvent,factory:StripeFinancialGatewayFactory=stripeFinancialGateway){
 const scope=connectionScope(connection),intent=event.financial.object.payment_intent,payment=await scoped(scope,async client=>(await client.query<{id:string}>('SELECT id FROM kff.verified_payments WHERE connection_id=$1 AND provider_intent_id=$2',[connection.id,intent])).rows[0]);
 if(!payment){await scoped(scope,async client=>{await client.query("UPDATE kff.stripe_events SET state='IGNORED',error_code='PAYMENT_NOT_OWNED_OR_UNVERIFIED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",[event.id,event.lease_token]);await audit(client,scope,'stripe.financial_event_unlinked',event.id,{reason:'Payment is not owned or not yet verified; payment verification creates its independent reconciliation ledger.'});});return;}
 await processRefundLedger(payment.id,factory,{event,allowCreate:false});
}
