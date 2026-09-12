import {z} from 'zod';
const money=z.number().int().safe(),amount=money.nonnegative(),text=z.string().max(200),timestamp=z.number().int().positive().max(253402300799);
const id=(prefix:string)=>z.string().regex(new RegExp('^('+prefix+')_[A-Za-z0-9]{1,200}$'));
const reference=(prefix:string)=>z.union([id(prefix),z.object({id:id(prefix)})]).transform(value=>typeof value==='string'?value:value.id);
export const refundMetadata=z.object({kff_refund_request_id:text.optional(),kff_payment_id:text.optional(),kff_order_id:text.optional(),kff_brand_id:text.optional()});
export const stripeRefundSchema=z.object({id:id('re|pyr'),object:z.literal('refund'),amount:amount.positive(),currency:z.string().regex(/^[a-z]{3}$/),payment_intent:reference('pi').nullable(),charge:reference('ch|py').nullable(),created:timestamp,status:z.string().max(80).nullable(),metadata:refundMetadata.nullable(),failure_reason:text.nullable().optional(),balance_transaction:reference('txn').nullable(),failure_balance_transaction:reference('txn').nullable().optional()});
export const stripeBalanceSchema=z.object({id:id('txn'),object:z.literal('balance_transaction'),amount:money,fee:money,net:money,currency:z.string().regex(/^[a-z]{3}$/),type:text,created:timestamp});
export const stripeDisputeSchema=z.object({id:id('dp'),object:z.literal('dispute'),amount,currency:z.string().regex(/^[a-z]{3}$/),payment_intent:reference('pi').nullable(),charge:reference('ch|py'),created:timestamp,livemode:z.boolean(),status:text,reason:text,is_charge_refundable:z.boolean(),balance_transactions:z.array(stripeBalanceSchema).max(100)});
export const stripeChargeSchema=z.object({id:id('ch|py'),object:z.literal('charge'),amount,amount_captured:amount,amount_refunded:amount,currency:z.string().regex(/^[a-z]{3}$/),payment_intent:reference('pi').nullable(),livemode:z.boolean(),paid:z.boolean(),captured:z.boolean(),disputed:z.boolean(),status:text});
export const stripeFinancialPaymentSchema=z.object({id:id('pi'),object:z.literal('payment_intent'),amount,amount_received:amount,currency:z.string().regex(/^[a-z]{3}$/),livemode:z.boolean(),status:text,metadata:z.object({kff_checkout_id:text.optional(),kff_order_id:text.optional(),kff_brand_id:text.optional(),kff_snapshot_hash:text.optional()}),latest_charge:stripeChargeSchema.nullable()});
export type StripeRefund=z.infer<typeof stripeRefundSchema>;
export type StripeDispute=z.infer<typeof stripeDisputeSchema>;
export type StripeFinancialPayment=z.infer<typeof stripeFinancialPaymentSchema>;
export type StripeFinancialObject={kind:'refund';object:StripeRefund}|{kind:'dispute';object:StripeDispute}|{kind:'charge';object:z.infer<typeof stripeChargeSchema>};
export const stripeFinancialEventTypes=['refund.created','refund.updated','refund.failed','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'] as const;
export function parseFinancialEvent(type:string,value:unknown):StripeFinancialObject|null{
 if(type.startsWith('refund.'))return {kind:'refund',object:stripeRefundSchema.parse(value)};
 if(type.startsWith('charge.dispute.'))return {kind:'dispute',object:stripeDisputeSchema.parse(value)};
 if(type==='charge.refunded')return {kind:'charge',object:stripeChargeSchema.parse(value)};return null;
}
