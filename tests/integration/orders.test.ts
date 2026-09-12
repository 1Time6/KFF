import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import type {Scope} from '../../packages/contracts/src/index';
import type {productVersionInput,OrderPreview} from '../../packages/contracts/src/order';
import type {z} from 'zod';
import {createSiteChannel,beginVisitorSession,receiveVisitorMessage,inboxConversation,updateCustomer} from '../../packages/core/src/inbox';
import {saveProductVersion,controlProduct,commerceWorkspace,productHistory,previewOrder,confirmOrder,ownedOrderDetail,cancelOwnedOrder,orderTotal} from '../../packages/core/src/orders';
import {digest} from '../../packages/core/src/index';
const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
function productInput(changes:Partial<z.infer<typeof productVersionInput>>={}):z.infer<typeof productVersionInput>{return {request_id:randomUUID(),sku:'SYN-'+randomUUID().slice(0,8),name:'Synthetic independent service',currency:'USD',minor_unit_exponent:2,precision_source:'Explicit synthetic currency test definition',unit_amount_minor:'1250',delivery_scope:'One owned synthetic report',terms:'Synthetic contract; no actual purchase',...changes};}
async function product(changes:Partial<z.infer<typeof productVersionInput>>={}){const input=productInput(changes),saved=await saveProductVersion(scope,input);const current=await controlProduct(scope,saved.product_id,{request_id:randomUUID(),expected_version:1,state:'ACTIVE',reason:'Approved synthetic product definition'});return {input,id:saved.product_id,version:current.version};}
async function customer(){const channel=await createSiteChannel(scope,{request_id:randomUUID(),name:'Synthetic order inquiry',is_synthetic:true,session_hours:1,reply_window_hours:1,sessions_per_minute:10,messages_per_minute:30});const visitor=await beginVisitorSession(channel.id);const receipt=await receiveVisitorMessage(channel.id,visitor.token,{client_message_id:randomUUID(),body:'Synthetic purchase inquiry',display_name:'Synthetic buyer',client_sent_at:null});const conversation=(await inboxConversation(scope,receipt.message.conversation_id)).conversation;return {id:conversation.customer_id,conversation_id:conversation.id};}
function confirmation(preview:OrderPreview){return {request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.snapshot_hash,confirmed_total_minor:preview.snapshot.total_minor,currency:preview.snapshot.currency,confirmation:'CREATE_THIS_ORDER' as const};}
async function orderPreview(){const buyer=await customer(),item=await product();const preview=await previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:buyer.conversation_id,items:[{product_id:item.id,quantity:3}]});return {buyer,item,preview};}
beforeAll(async()=>{const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated database required');await migrate();await seed();});
beforeEach(async()=>{await query('TRUNCATE kff.stripe_connections,kff.products,kff.orders,kff.order_previews,kff.commerce_currencies CASCADE');});afterAll(closePool);
it('saves draft product versions once, requires explicit activation, and retains old price and terms',async()=>{
  const input=productInput(),results=await Promise.all(Array.from({length:5},()=>saveProductVersion(scope,input)));expect(new Set(results.map(row=>row.product_id)).size).toBe(1);const id=results[0].product_id;
  expect((await productHistory(scope,id)).product.state).toBe('DRAFT');const buyer=await customer();await expect(previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:id,quantity:1}]})).rejects.toMatchObject({code:'PRODUCT_UNAVAILABLE'});
  const active=await controlProduct(scope,id,{request_id:randomUUID(),expected_version:1,state:'ACTIVE',reason:'Review synthetic terms'});await saveProductVersion(scope,{...input,request_id:randomUUID(),expected_version:active.version,unit_amount_minor:'9999',terms:'Revised synthetic terms'},id);
  const history=await productHistory(scope,id);expect(history.versions.map(row=>row.unit_amount_minor)).toEqual(['9999','1250']);expect(history.product.state).toBe('DRAFT');await expect(query("UPDATE kff.product_versions SET terms='changed' WHERE id=$1",[history.versions[1].id])).rejects.toThrow('IMMUTABLE_OWNED_RECORD');
});
it('confirms one immutable standalone order under concurrent duplicate requests and keeps payment unverified',async()=>{
  const {preview}=await orderPreview(),input=confirmation(preview),results=await Promise.all(Array.from({length:6},()=>confirmOrder(scope,input)));expect(new Set(results.map(row=>row.id)).size).toBe(1);const order=results[0];expect(order.state).toBe('OPEN');expect(order.payment_state).toBe('UNVERIFIED');expect(order.snapshot.total_minor).toBe('3750');expect(orderTotal(order.snapshot)).toBe('3750');
  const detail=await ownedOrderDetail(scope,order.id);expect(detail.events).toHaveLength(1);expect(detail.verified_revenue).toBe(false);expect(detail.payments_connected).toBe(false);
  await expect(query("UPDATE kff.orders SET snapshot='{}' WHERE id=$1",[order.id])).rejects.toThrow('IMMUTABLE_ORDER_SNAPSHOT');await expect(query("UPDATE kff.orders SET payment_state='PAID' WHERE id=$1",[order.id])).rejects.toThrow('ORDER_TRANSITION_DENIED');
  await expect(confirmOrder(scope,{...input,confirmed_total_minor:'0'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await expect(confirmOrder(scope,confirmation(preview))).rejects.toMatchObject({code:'PREVIEW_ALREADY_CONFIRMED'});
});
it('invalidates unconfirmed old prices and preserves the original order after a product price revision',async()=>{
  const {preview,item,buyer}=await orderPreview(),original=await confirmOrder(scope,confirmation(preview));const pending=await previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:item.id,quantity:1}]});
  await saveProductVersion(scope,{...item.input,request_id:randomUUID(),expected_version:item.version,unit_amount_minor:'7777'},item.id);await expect(confirmOrder(scope,confirmation(pending))).rejects.toMatchObject({code:'PRICE_PREVIEW_STALE'});
  expect((await ownedOrderDetail(scope,original.id)).order.snapshot.lines[0].unit_amount_minor).toBe('1250');expect((await productHistory(scope,item.id)).product.definition.unit_amount_minor).toBe('7777');
});
it('rejects paused products, changed customers and another customer conversation without guessing a relationship',async()=>{
  const {preview,item,buyer}=await orderPreview(),other=await customer();await expect(previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:other.conversation_id,items:[{product_id:item.id,quantity:1}]})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await updateCustomer(scope,buyer.id,{request_id:randomUUID(),expected_version:1,display_name:'Changed buyer',owner_user_id:null,stage:'IN_PROGRESS',reason:'Synthetic name correction'});await expect(confirmOrder(scope,confirmation(preview))).rejects.toMatchObject({code:'CUSTOMER_PREVIEW_STALE'});
  const next=await previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:item.id,quantity:1}]});await controlProduct(scope,item.id,{request_id:randomUUID(),expected_version:item.version,state:'ARCHIVED',reason:'Retire synthetic product'});await expect(confirmOrder(scope,confirmation(next))).rejects.toMatchObject({code:'PRICE_PREVIEW_STALE'});
});
it('retains exact integer arithmetic for zero and large totals, refusing overflow and mixed currencies',async()=>{
  const buyer=await customer(),large=await product({unit_amount_minor:'999999999999999'}),zero=await product({unit_amount_minor:'0'}),other=await product({currency:'JPY',minor_unit_exponent:0,unit_amount_minor:'100'});
  const preview=await previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:large.id,quantity:1000},{product_id:zero.id,quantity:1}]});expect(preview.snapshot.total_minor).toBe('999999999999999000');expect(preview.snapshot.lines[1].line_total_minor).toBe('0');
  const second=await product({unit_amount_minor:'999999999999999'});await expect(previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:large.id,quantity:1000},{product_id:second.id,quantity:1000}]})).rejects.toMatchObject({code:'ORDER_AMOUNT_LIMIT'});
  await expect(previewOrder(scope,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:large.id,quantity:1},{product_id:other.id,quantity:1}]})).rejects.toMatchObject({code:'CURRENCY_MISMATCH'});
  await expect(saveProductVersion(scope,productInput({minor_unit_exponent:3}))).rejects.toMatchObject({code:'CURRENCY_PRECISION_CONFLICT'});expect((await commerceWorkspace(scope)).products).toHaveLength(4);
});
it('rejects fake totals, mismatched hashes, expired evidence and preview reassignment',async()=>{
  const {preview}=await orderPreview();for(const changes of [{confirmed_total_minor:'1'},{currency:'JPY'},{preview_hash:'a'.repeat(64)}])await expect(confirmOrder(scope,{...confirmation(preview),...changes})).rejects.toMatchObject({code:'ORDER_CONFIRMATION_MISMATCH'});
  const expired=randomUUID();await query("INSERT INTO kff.order_previews(id,organization_id,brand_id,customer_id,snapshot,snapshot_hash,request_id,request_hash,created_by,created_at,expires_at) SELECT $1,organization_id,brand_id,customer_id,snapshot,snapshot_hash,$2,request_hash,created_by,now()-interval '2 days',now()-interval '1 day' FROM kff.order_previews WHERE id=$3",[expired,randomUUID(),preview.id]);await expect(confirmOrder(scope,{...confirmation(preview),preview_id:expired})).rejects.toMatchObject({code:'PREVIEW_EXPIRED'});
  const original=confirmation(preview);await confirmOrder(scope,original);await expect(confirmOrder(scope,{...original,preview_id:expired})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('rechecks preview expiry after waiting for a locked product',async()=>{
  const {preview,item}=await orderPreview(),short=randomUUID();await query("INSERT INTO kff.order_previews(id,organization_id,brand_id,customer_id,snapshot,snapshot_hash,request_id,request_hash,created_by,expires_at) SELECT $1,organization_id,brand_id,customer_id,snapshot,snapshot_hash,$2,request_hash,created_by,clock_timestamp()+interval '350 milliseconds' FROM kff.order_previews WHERE id=$3",[short,randomUUID(),preview.id]);
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});const holder=scoped(scope,async client=>{await client.query('SELECT id FROM kff.products WHERE id=$1 FOR UPDATE',[item.id]);ready();await gate;});await locked;
  const confirming=expect(confirmOrder(scope,{...confirmation(preview),preview_id:short})).rejects.toMatchObject({code:'PREVIEW_EXPIRED'});try{await delay(450);}finally{release();await holder;}await confirming;
});
it('enforces role and tenant access for product, preview, order and staff operations',async()=>{
  const {preview,item,buyer}=await orderPreview(),order=await confirmOrder(scope,confirmation(preview)),viewer={...scope,role:'viewer' as const},other={...scope,brand_id:randomUUID()};
  await expect(saveProductVersion({...scope,role:'operator'},productInput())).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(confirmOrder(viewer,confirmation(preview))).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(cancelOwnedOrder(viewer,order.id,{request_id:randomUUID(),expected_version:1,reason:'No viewer write'})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  await expect(productHistory(other,item.id)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(ownedOrderDetail(other,order.id)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(previewOrder(other,{request_id:randomUUID(),customer_id:buyer.id,conversation_id:null,items:[{product_id:item.id,quantity:1}]})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});
  for(const table of ['commerce_currencies','products','product_versions','order_previews','orders','order_events'])expect(await scoped(other,async client=>(await client.query('SELECT * FROM kff.'+table)).rows)).toEqual([]);
});
it('allows one audited cancellation and never edits historical totals or reopens an order',async()=>{
  const {preview}=await orderPreview(),order=await confirmOrder(scope,confirmation(preview)),input={request_id:randomUUID(),expected_version:1,reason:'Cancel a synthetic unconnected order'};
  const canceled=await cancelOwnedOrder(scope,order.id,input);expect(canceled.state).toBe('CANCELED');expect((await cancelOwnedOrder(scope,order.id,input)).id).toBe(order.id);const detail=await ownedOrderDetail(scope,order.id);expect(detail.events).toHaveLength(2);expect(detail.order.snapshot_hash).toBe(digest(preview.snapshot));
  await expect(cancelOwnedOrder(scope,order.id,{...input,request_id:randomUUID()})).rejects.toMatchObject({code:'ORDER_STATE_CHANGED'});await expect(query("UPDATE kff.orders SET state='OPEN',version=version+1 WHERE id=$1",[order.id])).rejects.toThrow('ORDER_TRANSITION_DENIED');
});
