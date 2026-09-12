import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {channelInput,inboundMessageInput,customerUpdateInput,conversationPageInput} from '../../packages/contracts/src/inbox';
it('rejects client-selected tenant, visitor, customer, permission and saved-message states',()=>{
  const input={client_message_id:randomUUID(),body:'Synthetic inquiry',display_name:null,client_sent_at:null};
  expect(inboundMessageInput.parse(input)).toEqual(input);
  for(const key of ['brand_id','visitor_id','customer_id','contact_permission_id','status','execution_authorized'])expect(inboundMessageInput.safeParse({...input,[key]:randomUUID()}).success).toBe(false);
  expect(inboundMessageInput.safeParse({...input,body:'   '}).success).toBe(false);expect(inboundMessageInput.safeParse({...input,body:'a'.repeat(5001)}).success).toBe(false);
});
it('requires explicit bounded channel policy and refuses unbounded history or missing customer versions',()=>{
  const channel={request_id:randomUUID(),name:'Owned inbox',is_synthetic:true,session_hours:168,reply_window_hours:24,sessions_per_minute:60,messages_per_minute:300};
  expect(channelInput.parse(channel)).toEqual(channel);
  for(const changes of [{session_hours:0},{session_hours:721},{reply_window_hours:169},{sessions_per_minute:1001},{messages_per_minute:0},{reply_window_hours:undefined}])expect(channelInput.safeParse({...channel,...changes}).success).toBe(false);
  expect(conversationPageInput.parse({after:'0',limit:'100'})).toEqual({after:'0',limit:100});
  for(const input of [{after:'-1'},{after:'1e8'},{limit:1000},{customer_id:randomUUID()}])expect(conversationPageInput.safeParse(input).success).toBe(false);
  expect(customerUpdateInput.safeParse({request_id:randomUUID(),display_name:null,owner_user_id:null,stage:'NEW_INQUIRY',reason:'Missing version'}).success).toBe(false);
});
