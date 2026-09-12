import {sendConversationReply} from '../../packages/core/src/lead-reception';
import type {Scope} from '../../packages/contracts/src/index';
import type {replyInput} from '../../packages/contracts/src/lead';
import type {z} from 'zod';
process.once('message',async(value:{scope:Scope;conversation_id:string;input:z.infer<typeof replyInput>})=>{
  const barrier=async()=>{process.send?.({barrier:process.argv[2]});await new Promise(()=>{});};
  await sendConversationReply(value.scope,value.conversation_id,value.input,process.argv[2]==='before'?barrier:undefined);
  if(process.argv[2]==='after')await barrier();process.exit(0);
});
