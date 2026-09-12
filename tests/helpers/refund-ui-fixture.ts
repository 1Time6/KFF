import {randomUUID} from 'node:crypto';
import {localConfig,query,closePool} from '../../packages/database/src/index';
import {localIds} from '../../scripts/seed';
import {queueStripeCheckout,controlStripeConnection,paymentWorkspace} from '../../packages/core/src/payments';
import {ownedOrderDetail} from '../../packages/core/src/orders';
import {processStripeCheckout} from '../../packages/core/src/payment-worker';
import {processRefundLedger} from '../../packages/core/src/refund-worker';
import {financialWorkspace} from '../../packages/core/src/refunds';
import type {StripeIntent} from '../../packages/core/src/stripe-gateway';
import type {StripeRefund,StripeDispute} from '../../packages/core/src/stripe-financial-contract';
import {StripeFixture} from './stripe-fixture';
import {StripeFinancialFixture} from './stripe-financial-fixture';
const url=new URL(process.env.DATABASE_URL??localConfig().database_url);if(process.env.KFF_LOCAL_REFUND_UI_FIXTURE!=='1'||process.env.KFF_ENABLE_LIVE==='true'||url.hostname!=='127.0.0.1'||url.pathname!=='/kff'||url.href!==new URL(localConfig().database_url).href)throw new Error('Local synthetic refund UI fixture required');
const scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin' as const},mode=process.argv[2],id=process.argv[3];if(!id||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Fixture ID required');
try{
 if(mode==='prepare'){
  const connectionId=process.argv[4],connection=(await query('SELECT * FROM kff.stripe_connections WHERE id=$1',[connectionId]))[0];if(!connection?.is_synthetic||connection.mode!=='TEST'||connection.brand_id!==scope.brand_id)throw new Error('Synthetic connection required');const order=(await ownedOrderDetail(scope,id)).order,fixture=new StripeFixture();fixture.accountId=connection.stripe_account_id;
  const checkout=await queueStripeCheckout(scope,id,{request_id:randomUUID(),connection_id:connectionId,expected_version:order.version,snapshot_hash:order.snapshot_hash,confirmation:'CREATE_STRIPE_CHECKOUT'});await processStripeCheckout(checkout.id,fixture.factory);const sessionId=(await paymentWorkspace(scope,id)).checkouts[0].provider_session_id!;fixture.pay(sessionId);await processStripeCheckout(checkout.id,fixture.factory);const payment=(await paymentWorkspace(scope,id)).verified[0],finance=new StripeFinancialFixture(fixture.accountId,fixture.intents.get(payment.provider_intent_id)!);await processRefundLedger(payment.id,finance.factory);console.log(JSON.stringify({payment_id:payment.id,order_id:id}));
 }else{
  const payment=(await query<{id:string;connection_id:string;proof:{intent:StripeIntent};stripe_account_id:string;is_synthetic:boolean;mode:string;brand_id:string}>('SELECT p.*,c.stripe_account_id FROM kff.verified_payments p JOIN kff.stripe_connections c ON c.id=p.connection_id WHERE p.id=$1',[id]))[0];if(!payment?.is_synthetic||payment.mode!=='TEST'||payment.brand_id!==scope.brand_id)throw new Error('Synthetic payment required');const finance=new StripeFinancialFixture(payment.stripe_account_id,payment.proof.intent);
  for(const row of await query<{proof:StripeRefund}>('SELECT proof FROM kff.stripe_refunds WHERE payment_id=$1',[id]))finance.refunds.set(row.proof.id,row.proof);for(const row of await query<{proof:StripeDispute}>('SELECT proof FROM kff.stripe_disputes WHERE payment_id=$1',[id]))finance.disputes.set(row.proof.id,row.proof);
  if(mode==='succeeded')for(const refund of finance.refunds.values())if(refund.status==='pending')refund.status='succeeded';
  if(!['process','succeeded','finish'].includes(mode))throw new Error('Unknown fixture action');if(mode==='finish'){const connection=(await query('SELECT version FROM kff.stripe_connections WHERE id=$1',[payment.connection_id]))[0];await controlStripeConnection(scope,payment.connection_id,{request_id:randomUUID(),expected_version:connection.version,outbound_enabled:false,reason:'Synthetic refund browser verification complete'});}else await processRefundLedger(payment.id,finance.factory);console.log(JSON.stringify(await financialWorkspace(scope,id)));
 }
}finally{await closePool();}
