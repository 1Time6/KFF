import {closePool,query} from '../../packages/database/src/index';
import {AppError} from '../../packages/core/src/index';
import {processRefundLedger} from '../../packages/core/src/refund-worker';
import type {StripeFinancialGateway} from '../../packages/core/src/stripe-financial-gateway';
const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name)||!process.send)throw new Error('Isolated refund subprocess required');
let sequence=0;const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>();
process.on('message',(message:{id:number;value?:unknown;error?:{code:string}})=>{const callback=pending.get(message.id);if(!callback)return;pending.delete(message.id);if(message.error)callback.reject(new AppError(message.error.code,'Synthetic parent provider error',503));else callback.resolve(message.value);});
const remote=(method:string,args:unknown[])=>new Promise<unknown>((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send!({id,method,args});});
const gateway={isSynthetic:true,...Object.fromEntries(['identity','retrievePayment','createRefund','retrieveRefund','listRefunds','retrieveDispute','listDisputes'].map(method=>[method,(...args:unknown[])=>remote(method,args)]))} as StripeFinancialGateway;
try{await processRefundLedger(process.argv[2],async()=>gateway);}finally{await closePool();process.disconnect();}
