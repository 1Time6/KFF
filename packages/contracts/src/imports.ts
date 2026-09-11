import { z } from 'zod';
import { collectionField, collectionFieldValue } from './collection';

export const importLimits = { file_bytes: 8 * 1024 * 1024, rows: 1000, columns: 32, sheets: 5, cell_characters: 5000, parser_ms: 15000 } as const;
const fieldList = z.array(collectionField).min(1).max(5).refine(items => new Set(items).size === items.length, '字段不能重复');
export const importUploadInput = z.object({
  request_id: z.string().uuid(), account_id: z.string().uuid(), title: z.string().trim().min(1).max(120),
  filename: z.string().min(1).max(120).regex(/^[^\\/\x00-\x1f:]+\.(csv|xlsx)$/i),
  format: z.enum(['csv','xlsx']), encoding: z.enum(['utf-8','gb18030','utf-16le']),
  source_namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  source_description: z.string().trim().min(5).max(500), purpose: z.literal('data_review'),
  processing_basis: z.string().trim().min(5).max(500), export_fields: fieldList,
  original_access: z.enum(['owner_admin','brand']), original_retention_days: z.number().int().min(1).max(30),
  retention_days: z.number().int().min(1).max(30),
  display_timezone: z.string().refine(value => /^(UTC|[A-Za-z_]+\/[A-Za-z0-9_+/-]+)$/.test(value) && (() => { try { new Intl.DateTimeFormat('en',{timeZone:value}).format(); return true; } catch { return false; } })(), '需使用 IANA 时区'),
}).strict().refine(value => value.filename.toLowerCase().endsWith('.' + value.format), '扩展名和格式不一致');
export const importMappingInput = z.object({
  request_id: z.string().uuid(), sheet: z.number().int().min(0).max(4), header_row: z.number().int().min(1).max(20),
  source_object_id: z.number().int().min(0).max(31),
  fields: z.partialRecord(collectionField, z.number().int().min(0).max(31)),
  kind_columns: z.partialRecord(collectionField, z.number().int().min(0).max(31)).default({}),
  text_encoding: z.enum(['plain','kff-apostrophe-v1']).default('plain'),
}).strict().refine(value => Object.keys(value.fields).length > 0, '至少映射一个数据字段')
  .refine(value => Object.keys(value.kind_columns).every(key => key in value.fields), '状态列必须匹配数据字段')
  .refine(value => { const columns = [value.source_object_id,...Object.values(value.fields),...Object.values(value.kind_columns)]; return new Set(columns).size === columns.length; }, '映射列不能重复');
export const importConfirmationInput = z.object({ request_id: z.string().uuid(), preview_id: z.string().uuid(), preview_hash: z.string().regex(/^[a-f0-9]{64}$/), excluded_error_rows: z.number().int().min(0).max(1000), confirm_valid_rows: z.literal(true) }).strict();
export const collectionExportInput = z.object({ format: z.enum(['csv','xlsx']), fields: fieldList, result_ids: z.array(z.string().uuid()).min(1).max(1000).refine(items => new Set(items).size === items.length).optional(),target_snapshot_id:z.string().uuid().optional() }).strict().refine(value=>!value.result_ids||!value.target_snapshot_id,'快照导出不能混入当前结果选择');
export const importCellSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('text'),value:z.string().max(5000)}).strict(),
  z.object({type:z.literal('number'),value:z.number().finite()}).strict(),
  z.object({type:z.literal('blank')}).strict(),
  z.object({type:z.literal('invalid'),reason:z.enum(['FORMULA_CELL','UNSUPPORTED_CELL'])}).strict(),
]);
export const parsedImportSchema = z.object({ sheets: z.array(z.object({name:z.string().max(80),rows:z.array(z.array(importCellSchema).max(32)).min(1).max(1021)}).strict()).min(1).max(5) }).strict();
export const importRecordSchema = z.object({row_number:z.number().int().positive(),source_object_id:z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),fields:z.partialRecord(collectionField,collectionFieldValue)}).strict();
export type ImportUpload = z.infer<typeof importUploadInput>;
export type ImportMapping = z.infer<typeof importMappingInput>;
export type ParsedImport = z.infer<typeof parsedImportSchema>;
export type ImportCell = z.infer<typeof importCellSchema>;
export type ImportRecord = z.infer<typeof importRecordSchema>;
export interface ImportRowPreview { row_number:number; source_object_id:string|null; errors:string[]; duplicate_in_file:boolean; record:ImportRecord|null }
export interface ManualImportSnapshot {
  schema_version:'kff.manual-import.v1'; source_type:'MANUAL_IMPORT'; source_key:string; source_version:'manual-file-v1';
  account_id:string; title:string; fields:z.infer<typeof collectionField>[]; export_fields:z.infer<typeof collectionField>[];
  display_timezone:string; allowed_purposes:['data_review']; import_id:string; source_description:string; processing_basis:string;
  file_hash:string; preview_hash:string; coverage:'UPLOADED_ROWS_ONLY'; original_rows:number; excluded_error_rows:number;
}
