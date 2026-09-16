import {z} from 'zod';
import {collectionField,type CollectionRecord} from './collection';

export const collectionFilterSchema=z.object({
  id_prefix:z.string().max(160).default(''),message_contains:z.string().max(100).default(''),author_id:z.string().max(160).default(''),
  min_reactions:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  field_states:z.partialRecord(collectionField,z.enum(['VALUE','DISPLAYED_TIME','NULL','NOT_RETURNED','HIDDEN'])).default({}),
}).strict();
export const targetSelectionMode=z.enum(['CURRENT_PAGE','MANUAL','ALL_FILTERED']);
export const targetPreviewInput=z.object({
  request_id:z.string().uuid(),query_id:z.string().uuid(),mode:targetSelectionMode,
  filter:collectionFilterSchema,
  after:z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=9223372036854775807n).default('0'),
  page_size:z.number().int().min(1).max(100).default(25),
  result_ids:z.array(z.string().uuid()).max(1000).refine(values=>new Set(values).size===values.length).default([]),
  observations:z.array(z.object({result_id:z.string().uuid(),observation_id:z.string().uuid()}).strict()).max(1000).default([]),
  page_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  purpose:z.enum(['software_verification','data_review','marketing','customer_service']),
  fields:z.array(collectionField).min(1).max(5).refine(values=>new Set(values).size===values.length),
}).strict().refine(value=>value.mode==='MANUAL'?value.result_ids.length>0 && value.observations.length===value.result_ids.length && new Set(value.observations.map(row=>row.result_id)).size===value.result_ids.length && value.observations.every(row=>value.result_ids.includes(row.result_id)):value.result_ids.length===0 && value.observations.length===0,'仅手选模式传入明确对象及观察版本')
  .refine(value=>value.mode!=='CURRENT_PAGE'||value.page_hash!==null,'当前页需要所见页面摘要');
export const targetSnapshotInput=z.object({request_id:z.string().uuid(),preview_id:z.string().uuid(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().trim().min(1).max(120),confirmed_included_count:z.number().int().min(0).max(1000),confirmed_excluded_count:z.number().int().min(0).max(1000)}).strict();
export type CollectionFilter=z.infer<typeof collectionFilterSchema>;
export type TargetPreviewInput=z.infer<typeof targetPreviewInput>;
export interface FrozenCollectionTarget {
  result_id:string;observation_id:string;source_object_id:string;source_key:string;object_version:number;evidence_hash:string;
  observed_at:string;expires_at:string;allowed_purposes:string[];disposition:'INCLUDED'|'EXCLUDED';reason_codes:string[];
  source_url:string;fields:CollectionRecord['fields'];
}
export const targetRevokeInput=z.object({request_id:z.string().uuid(),expected_version:z.number().int().positive(),reason:z.string().trim().min(5).max(300)}).strict();
