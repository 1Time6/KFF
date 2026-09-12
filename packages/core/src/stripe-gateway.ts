import Stripe from 'stripe';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {runtimeDir} from '@kff/database';
import type {StripeConnection} from '../../contracts/src/payment';
import type {OrderSnapshot} from '../../contracts/src/order';
import {AppError,requireCondition} from './index';

export const STRIPE_API_VERSION='2026-08-26.dahlia' as const;
export const stripeEventTypes=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'] as const;
const metadata=z.object({kff_order_id:z.string().max(200).optional(),kff_checkout_id:z.string().max(200).optional(),kff_brand_id:z.string().max(200).optional(),kff_snapshot_hash:z.string().max(200).optional()});
export const stripeSessionSchema=z.object({id:z.string().regex(/^cs_[A-Za-z0-9_]{1,200}$/),object:z.literal('checkout.session'),mode:z.string(),livemode:z.boolean(),amount_total:z.number().int().safe().nonnegative().nullable(),currency:z.string().nullable(),client_reference_id:z.string().nullable(),metadata:metadata.nullable(),status:z.string().nullable(),payment_status:z.string(),payment_intent:z.union([z.string().regex(/^pi_[A-Za-z0-9]{1,200}$/),z.object({id:z.string().regex(/^pi_[A-Za-z0-9]{1,200}$/)})]).nullable(),url:z.string().max(4096).nullable().optional()});
export const stripeIntentSchema=z.object({id:z.string().regex(/^pi_[A-Za-z0-9]{1,200}$/),object:z.literal('payment_intent'),livemode:z.boolean(),amount:z.number().int().safe().nonnegative(),amount_received:z.number().int().safe().nonnegative(),currency:z.string(),status:z.string(),metadata});
export type StripeSession=z.infer<typeof stripeSessionSchema>;
export type StripeIntent=z.infer<typeof stripeIntentSchema>;
export interface StripeGateway {isSynthetic:boolean;identity:()=>Promise<{id:string;currencies:string[]}>;createSession:(input:Stripe.Checkout.SessionCreateParams,key:string)=>Promise<StripeSession>;retrieveSession:(id:string)=>Promise<StripeSession>;retrieveIntent:(id:string)=>Promise<StripeIntent>}
export type StripeGatewayFactory=(connection:StripeConnection)=>Promise<StripeGateway>;
const secretsSchema=z.object({organization_id:z.string().uuid(),brand_id:z.string().uuid(),stripe_account_id:z.string().regex(/^acct_[A-Za-z0-9]+$/),api_key:z.string().regex(/^[sr]k_(test|live)_[A-Za-z0-9]{8,}$/),webhook_secrets:z.array(z.string().regex(/^whsec_[A-Za-z0-9]{8,}$/)).min(1).max(3)}).strict();
export function stripeSecrets(connection:Pick<StripeConnection,'credential_ref'|'mode'|'organization_id'|'brand_id'|'stripe_account_id'>){
  const ref=connection.credential_ref;let source:unknown;
  // Production vaults can inject these private variables. The local file is ignored by Git.
  if(process.env[ref+'_API_KEY']||process.env[ref+'_WEBHOOK_SECRETS'])source={organization_id:process.env[ref+'_ORGANIZATION_ID'],brand_id:process.env[ref+'_BRAND_ID'],stripe_account_id:process.env[ref+'_ACCOUNT_ID'],api_key:process.env[ref+'_API_KEY'],webhook_secrets:process.env[ref+'_WEBHOOK_SECRETS']?.split(',').map(value=>value.trim())};
  else {const file=path.join(runtimeDir,'stripe-secrets.json');if(existsSync(file)){try{source=JSON.parse(readFileSync(file,'utf8'))[ref];}catch{throw new AppError('STRIPE_CREDENTIALS_UNCONFIGURED','Stripe 私密配置无法读取',503);}}}
  const result=secretsSchema.safeParse(source);requireCondition(result.success,'STRIPE_CREDENTIALS_UNCONFIGURED','Stripe 测试密钥及 Webhook 签名密钥尚未配置',503);
  requireCondition(result.data.organization_id===connection.organization_id&&result.data.brand_id===connection.brand_id&&result.data.stripe_account_id===connection.stripe_account_id,'FORBIDDEN_SCOPE','Stripe 凭据未授权给此品牌及商户',403);
  requireCondition(result.data.api_key.startsWith(connection.mode==='TEST'?'rk_test_':'rk_live_')||result.data.api_key.startsWith(connection.mode==='TEST'?'sk_test_':'sk_live_'),'STRIPE_MODE_MISMATCH','Stripe 密钥与连接模式不匹配',503);return result.data;
}
function stripeFailure(error:unknown):never {
  if(error instanceof AppError)throw error;
  if(error instanceof Stripe.errors.StripeInvalidRequestError)throw new AppError('STRIPE_REQUEST_REJECTED','Stripe 拒绝了此支付请求，请核对金额、币种和账号配置');
  if(error instanceof Stripe.errors.StripeAuthenticationError||error instanceof Stripe.errors.StripePermissionError)throw new AppError('STRIPE_AUTH_REQUIRED','Stripe 密钥无效或缺少所需权限',503);
  throw new AppError('STRIPE_UNAVAILABLE','Stripe 查询暂未完成，已保留原支付请求',503);
}
export const stripeGateway:StripeGatewayFactory=async connection=>{
  requireCondition(!connection.is_synthetic,'SYNTHETIC_DRIVER_REQUIRED','合成连接不能访问 Stripe',403);
  const secrets=stripeSecrets(connection),client=new Stripe(secrets.api_key,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:0,timeout:15000,telemetry:false});
  return stripeSdkGateway(connection,client);
};
export function stripeSdkGateway(connection:StripeConnection,client:Stripe,isSynthetic=false):StripeGateway {
  async function call<T>(fn:()=>Promise<T>){try{return await fn();}catch(error){return stripeFailure(error);}}
  return {isSynthetic,identity:()=>call(async()=>{const account=await client.accounts.retrieveCurrent();requireCondition(account.id===connection.stripe_account_id&&account.country,'STRIPE_ACCOUNT_MISMATCH','Stripe 密钥不属于配置的商户账号',403);const spec=await client.countrySpecs.retrieve(account.country);return {id:account.id,currencies:spec.supported_payment_currencies};}),
    createSession:(input,key)=>call(async()=>stripeSessionSchema.parse(await client.checkout.sessions.create(input,{idempotencyKey:key}))),
    retrieveSession:id=>call(async()=>stripeSessionSchema.parse(await client.checkout.sessions.retrieve(id))),
    retrieveIntent:id=>call(async()=>stripeIntentSchema.parse(await client.paymentIntents.retrieve(id))),
  };
}
// Stripe charge units (not payout units). ISK/UGX retain two API decimals, always whole major units.
const zeroDecimals=new Set('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF'.split(' '));
export function validateStripeAmount(snapshot:OrderSnapshot){
  const exponent=zeroDecimals.has(snapshot.currency)?0:2;
  requireCondition(snapshot.minor_unit_exponent===exponent,'STRIPE_PRECISION_MISMATCH','订单精度与 Stripe 该币种的收款单位不一致');
  const total=BigInt(snapshot.total_minor);requireCondition(total>0n&&total<=BigInt(Number.MAX_SAFE_INTEGER),'STRIPE_AMOUNT_UNSUPPORTED','此金额不能作为 Stripe 单次支付金额');
  requireCondition(!['ISK','UGX'].includes(snapshot.currency)||snapshot.lines.every(line=>BigInt(line.unit_amount_minor)%100n===0n),'STRIPE_FRACTION_UNSUPPORTED','此币种在 Stripe 中不支持不足一个主单位的价格');
}
export function stripeCheckoutRequest(snapshot:OrderSnapshot,orderId:string,checkoutId:string,brandId:string,snapshotHash:string):Stripe.Checkout.SessionCreateParams {
  validateStripeAmount(snapshot);const origin=new URL(process.env.KFF_APP_ORIGIN??'http://127.0.0.1:3000');
  requireCondition(!origin.username&&!origin.password&&(origin.protocol==='https:'||(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname))),'INVALID_APP_ORIGIN','支付返回地址必须是已配置的 HTTPS 站点或本机地址',503);
  const values={kff_order_id:orderId,kff_checkout_id:checkoutId,kff_brand_id:brandId,kff_snapshot_hash:snapshotHash};
  const suffix=Array.from(randomBytes(8),byte=>String.fromCharCode(97+byte%26)).join('');
  return {mode:'payment',ui_mode:'hosted_page',client_reference_id:orderId,metadata:values,payment_intent_data:{metadata:values},integration_identifier:'kff-owned-checkout-'+suffix,
    success_url:origin.origin+'/payment-return',cancel_url:origin.origin+'/payment-return?canceled=1',adaptive_pricing:{enabled:false},automatic_tax:{enabled:false},allow_promotion_codes:false,
    line_items:snapshot.lines.map(line=>({price_data:{currency:snapshot.currency.toLowerCase(),unit_amount:Number(line.unit_amount_minor),product_data:{name:line.name}},quantity:line.quantity})),
  };
}
export function verifyStripeWebhook(connection:StripeConnection,raw:Buffer,signature:string|null,receivedAt=Date.now()){
  requireCondition(raw.length>0&&raw.length<=524288,'INVALID_INPUT','支付回调内容超出限制',413);
  requireCondition(signature&&signature.length<=4096,'STRIPE_SIGNATURE_INVALID','Stripe 回调签名无效',400);
  const secrets=stripeSecrets(connection);const client=new Stripe(secrets.api_key,{apiVersion:STRIPE_API_VERSION});let verified:Stripe.Event|undefined;
  for(const secret of secrets.webhook_secrets){try{verified=client.webhooks.constructEvent(raw,signature,secret,300,undefined,receivedAt);break;}catch{/* Never expose the raw payload or signing material. */}}
  requireCondition(verified,'STRIPE_SIGNATURE_INVALID','Stripe 回调签名无效',400);
  const times=signature.split(',').filter(part=>part.startsWith('t=')),timestamp=Number(times[0]?.slice(2));requireCondition(times.length===1&&Number.isSafeInteger(timestamp)&&timestamp<=Math.floor(receivedAt/1000)+300,'STRIPE_SIGNATURE_INVALID','Stripe 回调时间无效',400);
  const event=verified as Stripe.Event&{account?:string;context?:string};
  requireCondition(typeof event.type==='string'&&event.type.length<=200&&/^evt_[A-Za-z0-9]{1,200}$/.test(event.id)&&Number.isSafeInteger(event.created)&&event.created>0&&event.created<=253402300799,'STRIPE_EVENT_INVALID','Stripe 事件标识无效');
  requireCondition(event.livemode===(connection.mode==='LIVE')&&!event.account&&!event.context,'STRIPE_MODE_MISMATCH','Stripe 回调的模式或账号范围不匹配',400);
  requireCondition(event.api_version===STRIPE_API_VERSION,'STRIPE_EVENT_VERSION_MISMATCH','Stripe Webhook API 版本与本连接不一致',400);
  const supported=(stripeEventTypes as readonly string[]).includes(event.type);
  const parsed=supported?stripeSessionSchema.safeParse(event.data.object):null;requireCondition(!parsed||parsed.success,'STRIPE_EVENT_INVALID','Stripe 回调对象格式无效');
  const session=parsed?.success?{...parsed.data,url:undefined}:null;
  return {id:event.id,type:event.type,created:event.created,livemode:event.livemode,api_version:event.api_version,session};
}
export type VerifiedStripeEvent=ReturnType<typeof verifyStripeWebhook>;
export function safeCheckoutUrl(value:string|null|undefined){if(!value)return null;const url=new URL(value);requireCondition(url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.port&&!url.username&&!url.password,'STRIPE_URL_INVALID','Stripe 返回了未配置的支付域名',409);return url.href;}
