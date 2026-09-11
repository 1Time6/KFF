import {expect,it} from 'vitest';
import {importUploadInput,importMappingInput,collectionExportInput} from '../../packages/contracts/src/imports';
import {mapImportRows} from '../../packages/core/src/import-mapping';

it('rejects duplicate or unbound mapping columns and unsupported export fields',()=>{
  const mapping={request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sheet:0,header_row:1,source_object_id:0,fields:{message:1},kind_columns:{},text_encoding:'plain'};
  expect(importMappingInput.safeParse({...mapping,fields:{message:0}}).success).toBe(false);expect(importMappingInput.safeParse({...mapping,kind_columns:{author_id:2}}).success).toBe(false);
  expect(collectionExportInput.safeParse({format:'csv',fields:['credential_ref']}).success).toBe(false);expect(collectionExportInput.safeParse({format:'csv',fields:['message','message']}).success).toBe(false);
});
it('rejects local paths, executable formats and unbounded retention in upload metadata',()=>{
  const valid={request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',account_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',title:'Input',filename:'sample.csv',format:'csv',encoding:'utf-8',source_namespace:'owned-source',source_description:'Owned synthetic sample',processing_basis:'Software verification fixture',purpose:'data_review',export_fields:['message'],original_access:'owner_admin',original_retention_days:7,retention_days:7,display_timezone:'UTC'};
  expect(importUploadInput.safeParse(valid).success).toBe(true);for(const filename of ['../sample.csv','C:\\sample.csv','sample.xlsx.exe','bad\nname.csv'])expect(importUploadInput.safeParse({...valid,filename}).success).toBe(false);
  expect(importUploadInput.safeParse({...valid,retention_days:31}).success).toBe(false);expect(importUploadInput.safeParse({...valid,format:'xlsm'}).success).toBe(false);
});
it('requires an explicit KFF CSV marker and preserves literal apostrophes with one decoding pass',()=>{
  const value={request_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sheet:0,header_row:1,source_object_id:0,fields:{message:1},kind_columns:{},text_encoding:'kff-apostrophe-v1' as const};
  const parsed={sheets:[{name:'CSV',rows:[['id','text','_kff_text_encoding'],["'0001","''=text",'apostrophe-v1']].map(row=>row.map(value=>({type:'text' as const,value})))}]};
  expect(mapImportRows(parsed,value)[0].record?.fields.message).toEqual({kind:'VALUE',value:"'=text"});
  parsed.sheets[0].rows[1][2].value='untrusted';expect(mapImportRows(parsed,value)[0].errors).toContain('INVALID_TEXT_ENCODING_MARKER');
});
