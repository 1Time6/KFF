import {randomUUID} from 'node:crypto';
import {localConfig,query,closePool} from '../../packages/database/src/index';
import {localIds} from '../../scripts/seed';
import {createSiteChannel,beginVisitorSession,receiveVisitorMessage,inboxConversation} from '../../packages/core/src/inbox';
import {saveProductVersion,controlProduct,previewOrder,confirmOrder} from '../../packages/core/src/orders';
import {registerStripeConnection,controlStripeConnection} from '../../packages/core/src/payments';
import {processStripeCheckout} from '../../packages/core/src/payment-worker';
import type {PaymentCheckout} from '../../packages/contracts/src/payment';
import Stripe from 'stripe';
import {StripeFixture} from './stripe-fixture';
const url=new URL(process.env.DATABASE_URL??localConfig().database_url);if(process.env.KFF_LOCAL_PAYMENT_UI_FIXTURE!=='1'||process.env.KFF_ENABLE_LIVE==='true'||url.hostname!=='127.0.0.1'||url.pathname!=='/kff'||url.href!==new URL(localConfig().database_url).href)throw new Error('Local synthetic payment UI fixture required');
const scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin' as const},mode=process.argv[2];
try{
 if(mode==='prepare'){
  const fixture=new StripeFixture(),connection=await registerStripeConnection(scope,{request_id:randomUUID(),name:'Stripe 界面合成验证 '+randomUUID().slice(0,6),stripe_account_id:fixture.accountId,mode:'TEST',credential_ref:'KFF_STRIPE_UI_'+randomUUID().slice(0,8).toUpperCase()},fixture.factory);
  const channel=await createSiteChannel(scope,{request_id:randomUUID(),name:'Synthetic Stripe UI inquiry',is_synthetic:true,session_hours:1,reply_window_hours:1,sessions_per_minute:10,messages_per_minute:20}),visitor=await beginVisitorSession(channel.id),receipt=await receiveVisitorMessage(channel.id,visitor.token,{client_message_id:randomUUID(),body:'Synthetic Stripe UI inquiry',display_name:'支付界面合成客户',client_sent_at:null}),customer=(await inboxConversation(scope,receipt.message.conversation_id)).conversation.customer_id;
  const product=await saveProductVersion(scope,{request_id:randomUUID(),sku:'PAY-UI-'+randomUUID().slice(0,8),name:'合成报告服务',currency:'USD',minor_unit_exponent:2,precision_source:'Synthetic USD precision fixture',unit_amount_minor:'2500',delivery_scope:'一份合成报告，仅用于界面验证',terms:'本地合成数据，无真实收款或交付'});await controlProduct(scope,product.product_id,{request_id:randomUUID(),expected_version:1,state:'ACTIVE',reason:'Reviewed synthetic UI product'});
  const preview=await previewOrder(scope,{request_id:randomUUID(),customer_id:customer,conversation_id:null,items:[{product_id:product.product_id,quantity:1}]}),order=await confirmOrder(scope,{request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.snapshot_hash,confirmed_total_minor:'2500',currency:'USD',confirmation:'CREATE_THIS_ORDER'});console.log(JSON.stringify({order_id:order.id,connection_id:connection.id}));
 }else if(mode==='open'||mode==='paid'){
  const id=process.argv[3];if(!id||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Fixture checkout ID required');const checkout=(await query<PaymentCheckout&{stripe_account_id:string;is_synthetic:boolean;mode:string}>('SELECT p.*,c.stripe_account_id,c.is_synthetic,c.mode FROM kff.payment_checkouts p JOIN kff.stripe_connections c ON c.id=p.connection_id WHERE p.id=$1',[id]))[0];if(!checkout||!checkout.is_synthetic||checkout.mode!=='TEST'||checkout.brand_id!==scope.brand_id)throw new Error('Synthetic checkout required');
  const fixture=new StripeFixture();fixture.accountId=checkout.stripe_account_id;const session=await fixture.createSession(checkout.provider_request as Stripe.Checkout.SessionCreateParams,'kff-checkout-'+id);
  if(checkout.provider_session_id){fixture.sessions.delete(session.id);session.id=checkout.provider_session_id;session.url='https://checkout.stripe.com/c/pay/'+session.id;fixture.sessions.set(session.id,session);fixture.requests.get('kff-checkout-'+id)!.id=session.id;}
  if(mode==='paid')fixture.pay(session.id);await processStripeCheckout(id,fixture.factory);if(mode==='paid'){const connection=(await query('SELECT version FROM kff.stripe_connections WHERE id=$1',[checkout.connection_id]))[0];await controlStripeConnection(scope,checkout.connection_id,{request_id:randomUUID(),expected_version:connection.version,outbound_enabled:false,reason:'Synthetic browser check completed'});}console.log(JSON.stringify({processed:true}));
 }else throw new Error('Unknown fixture action');
}finally{await closePool();}
