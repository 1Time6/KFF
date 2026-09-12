import {receiveFacebookEvent} from '../../packages/core/src/facebook-inbound';
import {closePool} from '../../packages/database/src/index';
import type {Scope} from '../../packages/contracts/src/index';
import type {FacebookEvent} from '../../packages/contracts/src/lead';
process.once('message',async(value:{scope:Scope;account_id:string;event:FacebookEvent})=>{
  const barrier=async()=>{process.send?.({barrier:process.argv[2]});await new Promise(()=>{});};
  await receiveFacebookEvent(value.scope,value.account_id,value.event,process.argv[2]==='before'?barrier:undefined);
  if(process.argv[2]==='after')await barrier();await closePool();process.exit(0);
});
