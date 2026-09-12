import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {PoolClient} from 'pg';
import {scoped} from '@kff/database';
import type {Scope} from '@kff/contracts';
import {productVersionInput,productControlInput,orderPreviewInput,orderConfirmInput,orderCancelInput,orderSnapshotSchema,type CatalogProduct,type Product,type ProductVersion,type OrderPreview,type OwnedOrder,type OrderSnapshot} from '../../contracts/src/order';
import {audit,requireAdmin,requireWrite} from './service';
import {digest,requireCondition} from './index';

const productSelect="SELECT p.*,jsonb_build_object('id',v.id,'product_id',v.product_id,'version_number',v.version_number,'name',v.name,'currency',v.currency,'minor_unit_exponent',v.minor_unit_exponent,'precision_source',v.precision_source,'unit_amount_minor',v.unit_amount_minor::text,'delivery_scope',v.delivery_scope,'terms',v.terms,'created_at',v.created_at) AS definition FROM kff.products p JOIN kff.product_versions v ON v.id=p.current_version_id";
const orderColumns='id,customer_id,conversation_id,state,payment_state,version,snapshot,snapshot_hash,created_at';
async function requestLock(client:PoolClient,scope:Scope,group:string,requestId:string){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[group+'/'+scope.brand_id+'/'+requestId]);}
export async function saveProductVersion(scope:Scope,input:z.infer<typeof productVersionInput>,productId?:string){
  requireAdmin(scope);const value=productVersionInput.parse(input),hash=digest({product_id:productId??null,input:value});
  requireCondition(productId?value.expected_version!==undefined:value.expected_version===undefined,'INVALID_INPUT','修改商品需要当前版本；新增商品不填写旧版本');
  return scoped(scope,async client=>{
    await requestLock(client,scope,'product-version',value.request_id);
    const prior=(await client.query('SELECT id,product_id,request_hash FROM kff.product_versions WHERE request_id=$1',[value.request_id])).rows[0];
    if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求已用于不同商品或版本',409);return {product_id:prior.product_id as string,version_id:prior.id as string};}
    let product:Product;
    if(productId){
      product=(await client.query<Product>('SELECT * FROM kff.products WHERE id=$1 FOR UPDATE',[productId])).rows[0];requireCondition(product,'NOT_FOUND','商品不存在',404);
      requireCondition(product.version===value.expected_version,'VERSION_CONFLICT','商品已变化，请刷新后重新核对',409);requireCondition(product.sku===value.sku,'PRODUCT_IDENTITY_IMMUTABLE','商品 SKU 不可修改；不同商品需新建');
    }else product=(await client.query<Product>('INSERT INTO kff.products(organization_id,brand_id,sku) VALUES($1,$2,$3) RETURNING *',[scope.organization_id,scope.brand_id,value.sku])).rows[0];
    // Precision is an explicit brand registry. No floating point or provider-dependent implicit conversion.
    await client.query('INSERT INTO kff.commerce_currencies(organization_id,brand_id,currency,minor_unit_exponent,precision_source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(brand_id,currency) DO NOTHING',[scope.organization_id,scope.brand_id,value.currency,value.minor_unit_exponent,value.precision_source]);
    const precision=(await client.query('SELECT * FROM kff.commerce_currencies WHERE currency=$1',[value.currency])).rows[0];
    requireCondition(precision.minor_unit_exponent===value.minor_unit_exponent,'CURRENCY_PRECISION_CONFLICT','此品牌已登记该币种的其他精度，不能混用',409);
    const number=(await client.query('SELECT COALESCE(max(version_number),0)+1 AS next FROM kff.product_versions WHERE product_id=$1',[product.id])).rows[0].next;
    const version=(await client.query<ProductVersion>('INSERT INTO kff.product_versions(organization_id,brand_id,product_id,version_number,name,currency,minor_unit_exponent,precision_source,unit_amount_minor,delivery_scope,terms,request_id,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',[scope.organization_id,scope.brand_id,product.id,number,value.name,value.currency,value.minor_unit_exponent,precision.precision_source,value.unit_amount_minor,value.delivery_scope,value.terms,value.request_id,hash,scope.user_id])).rows[0];
    await client.query("UPDATE kff.products SET current_version_id=$1,state='DRAFT',version=version+$2 WHERE id=$3",[version.id,productId?1:0,product.id]);
    await audit(client,scope,'product.version_created',product.id,{version_id:version.id,version_number:number,request_id:value.request_id});return {product_id:product.id,version_id:version.id};
  });
}
export async function controlProduct(scope:Scope,id:string,input:z.infer<typeof productControlInput>){
  requireAdmin(scope);const value=productControlInput.parse(input),hash=digest({id,input:value});
  return scoped(scope,async client=>{
    await requestLock(client,scope,'product-control',value.request_id);
    const prior=(await client.query("SELECT details FROM kff.audit_events WHERE event_type='product.controlled' AND details->>'request_id'=$1",[value.request_id])).rows[0];
    if(prior){requireCondition(prior.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','此控制请求已经用于其他商品或内容',409);return prior.details.result as Product;}
    const product=(await client.query<Product>('SELECT * FROM kff.products WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(product,'NOT_FOUND','商品不存在',404);
    requireCondition(product.version===value.expected_version,'VERSION_CONFLICT','商品状态或版本已变化',409);
    const result=(await client.query<Product>('UPDATE kff.products SET state=$1,version=version+1 WHERE id=$2 RETURNING *',[value.state,id])).rows[0];
    await audit(client,scope,'product.controlled',id,{request_id:value.request_id,request_hash:hash,reason:value.reason,version_id:product.current_version_id,result});return result;
  });
}
export async function commerceWorkspace(scope:Scope){
  return scoped(scope,async client=>({
    products:(await client.query<CatalogProduct>(productSelect+' ORDER BY p.created_at DESC,p.id LIMIT 200')).rows,
    orders:(await client.query<OwnedOrder>('SELECT '+orderColumns+' FROM kff.orders ORDER BY created_at DESC,id LIMIT 200')).rows,
    customers:(await client.query<{id:string;display_name:string|null}>('SELECT id,display_name FROM kff.customers ORDER BY updated_at DESC,id LIMIT 200')).rows,
    currencies:(await client.query<{currency:string;minor_unit_exponent:number;precision_source:string}>('SELECT currency,minor_unit_exponent,precision_source FROM kff.commerce_currencies ORDER BY currency')).rows,
    payments_connected:Boolean((await client.query('SELECT 1 FROM kff.stripe_connections LIMIT 1')).rowCount),
  }));
}
export async function productHistory(scope:Scope,id:string){
  return scoped(scope,async client=>{
    const product=(await client.query<CatalogProduct>(productSelect+' WHERE p.id=$1',[id])).rows[0];requireCondition(product,'NOT_FOUND','商品不存在',404);
    const versions=(await client.query<ProductVersion>('SELECT id,product_id,version_number,name,currency,minor_unit_exponent,precision_source,unit_amount_minor::text,delivery_scope,terms,created_at FROM kff.product_versions WHERE product_id=$1 ORDER BY version_number DESC',[id])).rows;return {product,versions};
  });
}
export async function previewOrder(scope:Scope,input:z.infer<typeof orderPreviewInput>){
  requireWrite(scope);const value=orderPreviewInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    await requestLock(client,scope,'order-preview',value.request_id);
    const previous=(await client.query<OrderPreview & {request_hash:string}>('SELECT id,snapshot,snapshot_hash,expires_at,request_hash FROM kff.order_previews WHERE request_id=$1',[value.request_id])).rows[0];
    if(previous){requireCondition(previous.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同订单预览',409);return {id:previous.id,snapshot:previous.snapshot,snapshot_hash:previous.snapshot_hash,expires_at:previous.expires_at};}
    const products=(await client.query<CatalogProduct>(productSelect+' WHERE p.id=ANY($1::uuid[]) ORDER BY p.id FOR SHARE OF p',[value.items.map(item=>item.product_id)])).rows;
    requireCondition(products.length===value.items.length,'FORBIDDEN_SCOPE','商品不存在或不属于当前品牌',403);
    requireCondition(products.every(product=>product.state==='ACTIVE'),'PRODUCT_UNAVAILABLE','订单包含尚未启用或已停用的商品',409);
    const first=products[0].definition;
    requireCondition(products.every(product=>product.definition.currency===first.currency&&product.definition.minor_unit_exponent===first.minor_unit_exponent),'CURRENCY_MISMATCH','一笔订单只能使用同一币种和精度');
    const customer=(await client.query('SELECT id,display_name,version FROM kff.customers WHERE id=$1 FOR SHARE',[value.customer_id])).rows[0];requireCondition(customer,'NOT_FOUND','客户不存在',404);
    if(value.conversation_id)requireCondition((await client.query('SELECT id FROM kff.conversations WHERE id=$1 AND customer_id=$2',[value.conversation_id,value.customer_id])).rowCount,'FORBIDDEN_SCOPE','来源会话不属于所选客户',403);
    let total=0n;
    const lines=value.items.map(item=>{const product=products.find(row=>row.id===item.product_id)!;const version=product.definition;const amount=BigInt(version.unit_amount_minor)*BigInt(item.quantity);total+=amount;return {product_id:product.id,product_version_id:version.id,product_version_number:version.version_number,product_state_version:product.version,sku:product.sku,name:version.name,unit_amount_minor:version.unit_amount_minor,quantity:item.quantity,line_total_minor:amount.toString(),delivery_scope:version.delivery_scope,terms:version.terms};});
    requireCondition(total<=999999999999999999n,'ORDER_AMOUNT_LIMIT','订单总额超过当前支持范围');
    const time=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const snapshot=orderSnapshotSchema.parse({schema_version:'kff.order.v1',customer_id:customer.id,customer_version:customer.version,customer_display_name:customer.display_name,conversation_id:value.conversation_id,currency:first.currency,minor_unit_exponent:first.minor_unit_exponent,precision_source:first.precision_source,lines,total_minor:total.toString(),price_scope:'EXPLICIT_LINE_TOTALS',created_at:time.toISOString()});
    const preview=(await client.query<OrderPreview>('INSERT INTO kff.order_previews(organization_id,brand_id,customer_id,snapshot,snapshot_hash,request_id,request_hash,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,snapshot,snapshot_hash,expires_at',[scope.organization_id,scope.brand_id,customer.id,snapshot,digest(snapshot),value.request_id,hash,scope.user_id,time,new Date(time.getTime()+900000)])).rows[0];
    await audit(client,scope,'order.previewed',preview.id,{customer_id:customer.id,snapshot_hash:preview.snapshot_hash});return preview;
  });
}
async function validateSnapshot(client:PoolClient,preview:OrderPreview & {customer_id:string}){
  const snapshot=orderSnapshotSchema.parse(preview.snapshot);
  requireCondition(digest(snapshot)===preview.snapshot_hash&&snapshot.customer_id===preview.customer_id,'SNAPSHOT_CHANGED','订单预览摘要不匹配',409);
  requireCondition(orderTotal(snapshot)===snapshot.total_minor&&snapshot.lines.every(line=>(BigInt(line.unit_amount_minor)*BigInt(line.quantity)).toString()===line.line_total_minor),'ORDER_AMOUNT_MISMATCH','订单项目和总额不一致',409);
  const products=(await client.query<Product>('SELECT * FROM kff.products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[snapshot.lines.map(line=>line.product_id)])).rows;
  for(const line of snapshot.lines){const product=products.find(item=>item.id===line.product_id);requireCondition(product&&product.state==='ACTIVE'&&product.current_version_id===line.product_version_id&&product.version===line.product_state_version,'PRICE_PREVIEW_STALE','商品报价或状态已变化，请重新预览',409);}
  const customer=(await client.query('SELECT version FROM kff.customers WHERE id=$1 FOR SHARE',[snapshot.customer_id])).rows[0];
  requireCondition(customer&&customer.version===snapshot.customer_version,'CUSTOMER_PREVIEW_STALE','客户有新消息或档案已变化，请重新预览',409);
  const time=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  requireCondition(new Date(preview.expires_at)>time,'PREVIEW_EXPIRED','订单预览已到期，请重新预览',409);
  return snapshot;
}
export async function confirmOrder(scope:Scope,input:z.infer<typeof orderConfirmInput>){
  requireWrite(scope);const value=orderConfirmInput.parse(input),hash=digest(value);
  return scoped(scope,async client=>{
    await requestLock(client,scope,'order-confirm',value.request_id);
    const prior=(await client.query<{id:string;request_hash:string}>('SELECT id,request_hash FROM kff.orders WHERE request_id=$1',[value.request_id])).rows[0];
    if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','此请求已用于不同订单确认',409);return (await client.query<OwnedOrder>('SELECT '+orderColumns+' FROM kff.orders WHERE id=$1',[prior.id])).rows[0];}
    // Previews are immutable and have no UPDATE grant. Serialize consumers without granting mutation rights.
    await requestLock(client,scope,'order-preview-consumer',value.preview_id);
    const preview=(await client.query<OrderPreview & {customer_id:string}>('SELECT * FROM kff.order_previews WHERE id=$1',[value.preview_id])).rows[0];requireCondition(preview,'NOT_FOUND','订单预览不存在',404);
    requireCondition(value.preview_hash===preview.snapshot_hash&&value.confirmed_total_minor===preview.snapshot.total_minor&&value.currency===preview.snapshot.currency,'ORDER_CONFIRMATION_MISMATCH','确认金额、币种或快照与预览不一致');
    const existing=(await client.query<OwnedOrder>('SELECT '+orderColumns+' FROM kff.orders WHERE preview_id=$1',[preview.id])).rows[0];
    requireCondition(!existing,'PREVIEW_ALREADY_CONFIRMED','此预览已经生成订单，请从订单列表查看',409);
    const snapshot=await validateSnapshot(client,preview);
    const order=(await client.query<OwnedOrder>('INSERT INTO kff.orders(organization_id,brand_id,customer_id,conversation_id,preview_id,snapshot,snapshot_hash,request_id,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING '+orderColumns,[scope.organization_id,scope.brand_id,snapshot.customer_id,snapshot.conversation_id,preview.id,snapshot,preview.snapshot_hash,value.request_id,hash,scope.user_id])).rows[0];
    await client.query("INSERT INTO kff.order_events(organization_id,brand_id,order_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'CREATED',$4,$5,$6,$7)",[scope.organization_id,scope.brand_id,order.id,scope.user_id,{snapshot_hash:order.snapshot_hash},randomUUID(),hash]);
    await audit(client,scope,'order.created',order.id,{customer_id:order.customer_id,preview_id:preview.id,snapshot_hash:order.snapshot_hash});return order;
  });
}
export async function ownedOrderDetail(scope:Scope,id:string){
  return scoped(scope,async client=>{
    const order=(await client.query<OwnedOrder>('SELECT '+orderColumns+' FROM kff.orders WHERE id=$1',[id])).rows[0];requireCondition(order,'NOT_FOUND','订单不存在',404);
    requireCondition(digest(order.snapshot)===order.snapshot_hash,'SNAPSHOT_CHANGED','订单记录摘要不匹配',409);
    const events=(await client.query<{id:string;event_type:string;details:{reason?:string};created_at:string}>('SELECT id,event_type,details,created_at FROM kff.order_events WHERE order_id=$1 ORDER BY created_at,id',[id])).rows;
    const paymentsConnected=Boolean((await client.query('SELECT 1 FROM kff.stripe_connections LIMIT 1')).rowCount);
    const pending=Boolean((await client.query("SELECT 1 FROM kff.payment_checkouts WHERE order_id=$1 AND state NOT IN ('EXPIRED','FAILED')",[id])).rowCount);
    return {order,events,payments_connected:paymentsConnected,verified_revenue:order.payment_state==='VERIFIED_PAID',can_cancel:order.state==='OPEN'&&order.payment_state==='UNVERIFIED'&&!pending};
  });
}
export async function cancelOwnedOrder(scope:Scope,id:string,input:z.infer<typeof orderCancelInput>){
  requireWrite(scope);const value=orderCancelInput.parse(input),hash=digest({id,input:value});
  return scoped(scope,async client=>{
    await requestLock(client,scope,'order-cancel',value.request_id);
    const prior=(await client.query('SELECT order_id,request_hash,details FROM kff.order_events WHERE request_id=$1',[value.request_id])).rows[0];
    if(prior){requireCondition(prior.order_id===id&&prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','取消请求已用于不同订单或内容',409);return prior.details.result as OwnedOrder;}
    const order=(await client.query<OwnedOrder>('SELECT '+orderColumns+' FROM kff.orders WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(order,'NOT_FOUND','订单不存在',404);
    requireCondition(order.version===value.expected_version&&order.state==='OPEN'&&order.payment_state==='UNVERIFIED','ORDER_STATE_CHANGED','订单状态已变化，请重新核对',409);
    requireCondition(!(await client.query("SELECT 1 FROM kff.payment_checkouts WHERE order_id=$1 AND state NOT IN ('EXPIRED','FAILED')",[id])).rowCount,'PAYMENT_ALREADY_PENDING','订单已有支付请求，请先核对原支付结果',409);
    const result=(await client.query<OwnedOrder>("UPDATE kff.orders SET state='CANCELED',version=version+1 WHERE id=$1 RETURNING "+orderColumns,[id])).rows[0];
    await client.query("INSERT INTO kff.order_events(organization_id,brand_id,order_id,event_type,actor_id,details,request_id,request_hash) VALUES($1,$2,$3,'CANCELED',$4,$5,$6,$7)",[scope.organization_id,scope.brand_id,id,scope.user_id,{reason:value.reason,result},value.request_id,hash]);
    await audit(client,scope,'order.canceled',id,{reason:value.reason,request_id:value.request_id});return result;
  });
}
export function orderTotal(snapshot:OrderSnapshot){return snapshot.lines.reduce((total,line)=>total+BigInt(line.unit_amount_minor)*BigInt(line.quantity),0n).toString();}
