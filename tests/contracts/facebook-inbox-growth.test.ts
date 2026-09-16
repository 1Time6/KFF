import {it,expect} from 'vitest';
import {isFacebookInboxExpansion} from '../../packages/adapters/src/facebook-inbox-dom';
const row=(message_id:string)=>({message_id,body:'Hello '+message_id,direction:'INBOUND' as const,display_name:'Customer',displayed_time:'15:37',has_attachment:false});
const page=(...ids:string[])=>({rows:ids.map(row),invalid:0});
it('permits deferred earlier or later rows only within the bounded page',()=>{
  expect(isFacebookInboxExpansion(page('3','4'),page('1','2','3','4'),10)).toBe(true);
  expect(isFacebookInboxExpansion(page('1','2'),page('1','2','3'),10)).toBe(true);
  expect(isFacebookInboxExpansion(page('3','4'),page('1','2','3','4'),3)).toBe(false);
});
it('rejects deleted, reordered, duplicated or unsupported rows',()=>{
  for(const after of [page('1','2'),page('3','2','1'),page('1','2','2'),{...page('1','2','3'),invalid:1},page('1','3','4')])expect(isFacebookInboxExpansion(page('1','2'),after,10)).toBe(false);
});
it('rejects changes to existing message content, direction, sender or time labels',()=>{
  for(const patch of [{body:'Edited'},{direction:'OUTBOUND' as const},{display_name:null},{displayed_time:'15:38'},{has_attachment:true}]){
    const after=page('1','2','3');after.rows[0]={...after.rows[0],...patch} as typeof after.rows[number];
    expect(isFacebookInboxExpansion(page('1','2'),after,10)).toBe(false);
  }
});
