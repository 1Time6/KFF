import {receiveVisitorMessage} from '../../packages/core/src/inbox';
import type {InboundMessageInput} from '../../packages/contracts/src/inbox';
const boundary=process.argv[2];
const input=await new Promise<{channel_id:string;token:string;message:InboundMessageInput}>(resolve=>process.once('message',value=>resolve(value as {channel_id:string;token:string;message:InboundMessageInput})));
function hold(){process.send?.({barrier:boundary});return new Promise<void>(()=>{setInterval(()=>{},1000);});}
await receiveVisitorMessage(input.channel_id,input.token,input.message,boundary==='before'?hold:undefined);
if(boundary==='after')await hold();
