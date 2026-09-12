import Stripe from 'stripe';
import type {StripeConnection} from '../../contracts/src/payment';
import {AppError,requireCondition} from './index';
import {stripeSecrets,STRIPE_API_VERSION} from './stripe-gateway';
import {stripeFinancialPaymentSchema,stripeRefundSchema,stripeDisputeSchema,type StripeFinancialPayment,type StripeRefund,type StripeDispute} from './stripe-financial-contract';
export interface StripeFinancialGateway {isSynthetic:boolean;identity:()=>Promise<{id:string}>;retrievePayment:(id:string)=>Promise<StripeFinancialPayment>;createRefund:(input:Stripe.RefundCreateParams,key:string)=>Promise<StripeRefund>;retrieveRefund:(id:string)=>Promise<StripeRefund>;listRefunds:(paymentId:string,cursor?:string)=>Promise<{data:StripeRefund[];has_more:boolean}>;retrieveDispute:(id:string)=>Promise<StripeDispute>;listDisputes:(paymentId:string,cursor?:string)=>Promise<{data:StripeDispute[];has_more:boolean}>}
export type StripeFinancialGatewayFactory=(connection:StripeConnection)=>Promise<StripeFinancialGateway>;
export const stripeFinancialGateway:StripeFinancialGatewayFactory=async connection=>{
 requireCondition(!connection.is_synthetic,'SYNTHETIC_DRIVER_REQUIRED','合成财务连接不能访问 Stripe',403);const secrets=stripeSecrets(connection);
 return stripeFinancialSdkGateway(new Stripe(secrets.api_key,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:0,timeout:15000,telemetry:false}));
};
export function stripeFinancialSdkGateway(client:Stripe,isSynthetic=false):StripeFinancialGateway{
 async function call<T>(action:()=>Promise<T>){try{return await action();}catch(error){if(error instanceof AppError)throw error;if(error instanceof Stripe.errors.StripeInvalidRequestError)throw new AppError('STRIPE_REQUEST_REJECTED','Stripe 拒绝了此退款请求，请核对原对象及额度',409);if(error instanceof Stripe.errors.StripeAuthenticationError||error instanceof Stripe.errors.StripePermissionError)throw new AppError('STRIPE_AUTH_REQUIRED','Stripe 财务查询或退款权限未配置',503);throw new AppError('STRIPE_UNAVAILABLE','Stripe 财务请求暂未完成，保留原请求核对',503);}}
 return {isSynthetic,identity:()=>call(async()=>({id:(await client.accounts.retrieveCurrent()).id})),
 retrievePayment:id=>call(async()=>stripeFinancialPaymentSchema.parse(await client.paymentIntents.retrieve(id,{expand:['latest_charge']}))),
 createRefund:(input,key)=>call(async()=>stripeRefundSchema.parse(await client.refunds.create(input,{idempotencyKey:key}))),retrieveRefund:id=>call(async()=>stripeRefundSchema.parse(await client.refunds.retrieve(id))),
 listRefunds:(paymentId,cursor)=>call(async()=>{const page=await client.refunds.list({payment_intent:paymentId,limit:100,...(cursor?{starting_after:cursor}:{})});return {data:page.data.map(value=>stripeRefundSchema.parse(value)),has_more:page.has_more};}),
 retrieveDispute:id=>call(async()=>stripeDisputeSchema.parse(await client.disputes.retrieve(id))),
 listDisputes:(paymentId,cursor)=>call(async()=>{const page=await client.disputes.list({payment_intent:paymentId,limit:100,...(cursor?{starting_after:cursor}:{})});return {data:page.data.map(value=>stripeDisputeSchema.parse(value)),has_more:page.has_more};}),
 };
}
