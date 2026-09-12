import {z} from 'zod';
import {minorAmount} from './cost';
const uuid=z.string().uuid();
export const productVersionInput=z.object({
  request_id:uuid,expected_version:z.number().int().positive().optional(),sku:z.string().trim().regex(/^[A-Za-z0-9._-]{1,80}$/),name:z.string().trim().min(1).max(120),
  currency:z.string().regex(/^[A-Z]{3}$/),minor_unit_exponent:z.number().int().min(0).max(6),precision_source:z.string().trim().min(5).max(300),unit_amount_minor:minorAmount,
  delivery_scope:z.string().trim().min(1).max(2000),terms:z.string().trim().min(1).max(4000),
}).strict();
export const productControlInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),state:z.enum(['ACTIVE','ARCHIVED']),reason:z.string().trim().min(1).max(300)}).strict();
export const orderPreviewInput=z.object({request_id:uuid,customer_id:uuid,conversation_id:uuid.nullable(),items:z.array(z.object({product_id:uuid,quantity:z.number().int().min(1).max(1000)}).strict()).min(1).max(50)}).strict().refine(value=>new Set(value.items.map(item=>item.product_id)).size===value.items.length,'同一商品只保留一行并填写数量');
export const orderConfirmInput=z.object({request_id:uuid,preview_id:uuid,preview_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed_total_minor:z.string().regex(/^(0|[1-9][0-9]{0,17})$/),currency:z.string().regex(/^[A-Z]{3}$/),confirmation:z.literal('CREATE_THIS_ORDER')}).strict();
export const orderCancelInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),reason:z.string().trim().min(1).max(500)}).strict();
export const orderLineSchema=z.object({product_id:uuid,product_version_id:uuid,product_version_number:z.number().int().positive(),product_state_version:z.number().int().positive(),sku:z.string(),name:z.string(),unit_amount_minor:minorAmount,quantity:z.number().int().min(1).max(1000),line_total_minor:z.string().regex(/^[0-9]{1,18}$/),delivery_scope:z.string(),terms:z.string()}).strict();
export const orderSnapshotSchema=z.object({schema_version:z.literal('kff.order.v1'),customer_id:uuid,customer_version:z.number().int().positive(),customer_display_name:z.string().nullable(),conversation_id:uuid.nullable(),currency:z.string().regex(/^[A-Z]{3}$/),minor_unit_exponent:z.number().int().min(0).max(6),precision_source:z.string(),lines:z.array(orderLineSchema).min(1).max(50),total_minor:z.string().regex(/^(0|[1-9][0-9]{0,17})$/),price_scope:z.literal('EXPLICIT_LINE_TOTALS'),created_at:z.string().datetime()}).strict();
export type OrderSnapshot=z.infer<typeof orderSnapshotSchema>;
export interface Product {id:string;sku:string;state:'DRAFT'|'ACTIVE'|'ARCHIVED';version:number;current_version_id:string;created_at:string}
export interface ProductVersion {id:string;product_id:string;version_number:number;name:string;currency:string;minor_unit_exponent:number;precision_source:string;unit_amount_minor:string;delivery_scope:string;terms:string;created_at:string}
export interface CatalogProduct extends Product {definition:ProductVersion}
export interface OrderPreview {id:string;snapshot:OrderSnapshot;snapshot_hash:string;expires_at:string}
export interface OwnedOrder {id:string;customer_id:string;conversation_id:string|null;state:'OPEN'|'CANCELED';payment_state:'UNVERIFIED'|'VERIFIED_TEST_PAID'|'VERIFIED_PAID';version:number;snapshot:OrderSnapshot;snapshot_hash:string;created_at:string}
export function displayMinor(value:string,exponent:number){if(!/^[0-9]+$/.test(value)||!Number.isInteger(exponent)||exponent<0||exponent>6)return '—';if(exponent===0)return value;const padded=value.padStart(exponent+1,'0');return padded.slice(0,-exponent)+'.'+padded.slice(-exponent);}
