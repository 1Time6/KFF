import { importMappingInput, importRecordSchema, type ImportCell, type ImportMapping, type ParsedImport, type ImportRowPreview } from '../../contracts/src/imports';
import { collectionField, type CollectionRecord } from '../../contracts/src/collection';
import { requireCondition } from './index';

const empty:ImportCell = {type:'blank'};
function stringValue(cell:ImportCell, textEncoding:ImportMapping['text_encoding']):string {
  if (cell.type === 'invalid') throw new Error(cell.reason);
  if (cell.type === 'number') throw new Error('TEXT_REQUIRED');
  const value = cell.type === 'text' ? cell.value : '';
  if (textEncoding === 'plain') return value;
  if (!value.startsWith("'")) throw new Error('INVALID_TEXT_ESCAPE'); return value.slice(1);
}
export function mapImportRows(parsed:ParsedImport, input:ImportMapping):ImportRowPreview[] {
  const mapping = importMappingInput.parse(input); const sheet = parsed.sheets[mapping.sheet];
  requireCondition(sheet && sheet.rows.length > mapping.header_row && sheet.rows.length - mapping.header_row <= 1000, 'INVALID_MAPPING', '表头之后需要 1–1000 行数据');
  const header = sheet.rows[mapping.header_row - 1];
  const columns = [mapping.source_object_id,...Object.values(mapping.fields),...Object.values(mapping.kind_columns)];
  requireCondition(columns.every(index => index < header.length && header[index]?.type === 'text' && (header[index] as {value:string}).value.trim()), 'INVALID_MAPPING','映射列必须有文本表头');
  const marker = header.findIndex(cell => cell.type === 'text' && cell.value === '_kff_text_encoding');
  if (mapping.text_encoding === 'kff-apostrophe-v1') requireCondition(marker >= 0, 'INVALID_MAPPING','文件没有 KFF 文本编码标记');
  const seen = new Set<string>();
  return sheet.rows.slice(mapping.header_row).map((cells,index) => {
    const errors:string[] = []; let id:string|null = null; const fields:CollectionRecord['fields'] = {};
    if (mapping.text_encoding === 'kff-apostrophe-v1' && (cells[marker]?.type !== 'text' || (cells[marker] as {value:string}).value !== 'apostrophe-v1')) errors.push('INVALID_TEXT_ENCODING_MARKER');
    try { id = stringValue(cells[mapping.source_object_id] ?? empty,mapping.text_encoding); if (!/^[A-Za-z0-9_:-]{1,160}$/.test(id)) errors.push('source_object_id: INVALID_ID'); }
    catch (error) { errors.push('source_object_id: ' + (error as Error).message); }
    for (const key of collectionField.options) {
      const column = mapping.fields[key]; if (column === undefined) continue; const cell = cells[column] ?? empty;
      try {
        if (cell.type === 'invalid') throw new Error(cell.reason);
        const kindColumn = mapping.kind_columns[key]; let kind:string;
        if (kindColumn !== undefined) {
          kind = stringValue(cells[kindColumn] ?? empty,'plain'); if (!['VALUE','NULL','NOT_RETURNED','HIDDEN'].includes(kind)) throw new Error('INVALID_FIELD_KIND');
        } else kind = cell.type === 'blank' || cell.type === 'text' && cell.value === '' ? 'NULL' : 'VALUE';
        if (kind !== 'VALUE') { if (cell.type === 'number' || cell.type === 'text' && cell.value !== '') throw new Error('NONEMPTY_NULL_FIELD'); fields[key] = {kind:kind as 'NULL'|'NOT_RETURNED'|'HIDDEN'}; continue; }
        if (key === 'reaction_count' || key === 'comment_count') {
          const raw = cell.type === 'number' ? String(cell.value) : stringValue(cell,'plain');
          if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('INVALID_COUNT');
          fields[key] = {kind:'VALUE',value:Number(raw)};
        } else {
          const value = stringValue(cell,mapping.text_encoding);
          if (key === 'author_id' && !/^[A-Za-z0-9_:-]{1,160}$/.test(value)) throw new Error('INVALID_ID');
          if (key === 'created_time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new Error('UTC_TIMESTAMP_REQUIRED');
          if (key === 'created_time' && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,19) !== value.slice(0,19))) throw new Error('INVALID_TIMESTAMP');
          fields[key] = {kind:'VALUE',value};
        }
      } catch (error) { errors.push(key + ': ' + (error as Error).message); }
    }
    const duplicate = id !== null && seen.has(id); if (id && errors.length === 0) seen.add(id);
    const row = {row_number:mapping.header_row+index+1,source_object_id:id,errors,duplicate_in_file:duplicate,record:null as ImportRowPreview['record']};
    if (errors.length === 0) row.record = importRecordSchema.parse({row_number:row.row_number,source_object_id:id,fields});
    return row;
  });
}
