import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {replyInput} from '../../packages/contracts/src/lead';
const base=()=>({request_id:randomUUID(),expected_version:1,body:'',refer_whatsapp:true});
it('keeps ordinary invitations compatible and preserves an explicit original correction reference',()=>{
 expect(replyInput.parse(base()).corrects_referral_id).toBeUndefined();
 const id=randomUUID();expect(replyInput.parse({...base(),corrects_referral_id:id}).corrects_referral_id).toBe(id);
});
it('does not allow a correction reference on an ordinary message or an invalid referral identifier',()=>{
 expect(()=>replyInput.parse({...base(),body:'Hello',refer_whatsapp:false,corrects_referral_id:randomUUID()})).toThrow();
 expect(()=>replyInput.parse({...base(),corrects_referral_id:'another-conversation'})).toThrow();
});
