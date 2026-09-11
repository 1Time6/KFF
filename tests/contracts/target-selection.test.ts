import {expect,it} from 'vitest';
import {targetPreviewInput,targetSnapshotInput,collectionFilterSchema} from '../../packages/contracts/src/target-selection';
const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input={request_id:uuid,query_id:uuid,mode:'ALL_FILTERED',filter:{},purpose:'data_review',fields:['message']};
it('requires current-page evidence and exact per-row observation references for manual selection',()=>{
  expect(targetPreviewInput.safeParse(input).success).toBe(true);expect(targetPreviewInput.safeParse({...input,mode:'CURRENT_PAGE'}).success).toBe(false);
  expect(targetPreviewInput.safeParse({...input,mode:'CURRENT_PAGE',page_hash:'a'.repeat(64)}).success).toBe(true);
  expect(targetPreviewInput.safeParse({...input,mode:'MANUAL',result_ids:[uuid]}).success).toBe(false);
  expect(targetPreviewInput.safeParse({...input,mode:'MANUAL',result_ids:[uuid],observations:[{result_id:uuid,observation_id:uuid}]}).success).toBe(true);
  expect(targetPreviewInput.safeParse({...input,result_ids:[uuid]}).success).toBe(false);
});
it('limits filter fields, counts, cursors and snapshot confirmation to explicit bounded inputs',()=>{
  expect(collectionFilterSchema.safeParse({min_reactions:-1}).success).toBe(false);expect(collectionFilterSchema.safeParse({sql:'SELECT *'}).success).toBe(false);
  expect(targetPreviewInput.safeParse({...input,after:'9999999999999999999'}).success).toBe(false);expect(targetPreviewInput.safeParse({...input,fields:['message','message']}).success).toBe(false);
  expect(targetSnapshotInput.safeParse({request_id:uuid,preview_id:uuid,preview_hash:'a'.repeat(64),title:'Saved set',confirmed_included_count:1,confirmed_excluded_count:0,definition:{targets:[]}}).success).toBe(false);
});
