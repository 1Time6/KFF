import {claimReception,receptionContext,completeReception} from '../../packages/core/src/reception-worker';
import {localReceptionRules} from '../../packages/adapters/src/reception-model';
const barrier=async()=>{process.send?.({barrier:process.argv[2]});await new Promise(()=>{});};
const claim=(await claimReception())!;
const decision=await localReceptionRules.decide(await receptionContext(claim));
await completeReception(claim,decision,'LOCAL_RULES',process.argv[2]==='before'?barrier:undefined);
if(process.argv[2]==='after')await barrier();
process.exit(0);
