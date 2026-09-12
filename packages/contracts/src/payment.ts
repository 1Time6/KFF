import {z} from 'zod';
const uuid=z.string().uuid();
export const stripeConnectionInput=z.object({request_id:uuid,name:z.string().trim().min(1).max(80),stripe_account_id:z.string().regex(/^acct_[A-Za-z0-9]{1,100}$/),mode:z.enum(['TEST','LIVE']),credential_ref:z.string().regex(/^KFF_STRIPE_[A-Z0-9_]{1,40}$/)}).strict();
export const checkoutInput=z.object({request_id:uuid,connection_id:uuid,expected_version:z.number().int().positive(),snapshot_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.literal('CREATE_STRIPE_CHECKOUT')}).strict();
export const paymentRecheckInput=z.object({request_id:uuid,reason:z.string().trim().min(1).max(300)}).strict();
export const stripeConnectionControlInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),outbound_enabled:z.boolean(),reason:z.string().trim().min(1).max(300)}).strict();
export type PaymentMode='TEST'|'LIVE';
export type CheckoutState='READY'|'CREATING'|'OPEN'|'PENDING'|'PAID'|'EXPIRED'|'FAILED'|'NEEDS_HUMAN';
export interface StripeConnection {id:string;organization_id:string;brand_id:string;name:string;stripe_account_id:string;mode:PaymentMode;credential_ref:string;is_synthetic:boolean;outbound_enabled:boolean;version:number;created_by:string}
export interface PaymentCheckout {id:string;organization_id:string;brand_id:string;order_id:string;connection_id:string;state:CheckoutState;snapshot_hash:string;amount_minor:string;currency:string;minor_unit_exponent:number;provider_session_id:string|null;provider_intent_id:string|null;checkout_url:string|null;error_code:string|null;created_at:string;submitted_at:string|null;next_check_at:string;lease_token:string|null;lease_until:string|null;checks:number;created_by:string;request_id:string;request_hash:string;provider_request:Record<string,unknown>}
export interface VerifiedPayment {id:string;order_id:string;checkout_id:string;connection_id:string;provider_intent_id:string;mode:PaymentMode;is_synthetic:boolean;amount_minor:string;currency:string;minor_unit_exponent:number;verified_at:string}
