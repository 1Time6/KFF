import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {projectRoot} from '@kff/database';
import {apifyConnection} from '../packages/adapters/src/apify-connection';
import {readBoundedJson} from '../packages/adapters/src/source-http';

// Explicit, bounded one-shot runs. A durable receipt prevents accidental paid POST retries.
const [command,label,inputFile]=process.argv.slice(2);
if(!['search','comments','status','results'].includes(command)||!label||!/^[a-z0-9-]{1,80}$/.test(label))throw new Error('Usage: apify-run.ts search|comments|status|results <unique-label> [input.json]');
const connection=apifyConnection();if(!connection)throw new Error('Apify connection missing');
const dir=path.join(projectRoot,'.kff','apify-runs');await mkdir(dir,{recursive:true});
const receiptPath=path.join(dir,label+'.json');
const api=async(resource:string,init:RequestInit={})=>{
  const response=await fetch('https://api.apify.com/v2/'+resource,{...init,headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
  return readBoundedJson(response);
};
const runSchema=z.object({id:z.string().regex(/^[A-Za-z0-9]{17}$/),actId:z.string(),userId:z.string(),status:z.string(),defaultDatasetId:z.string(),defaultKeyValueStoreId:z.string(),startedAt:z.string(),finishedAt:z.string().nullable().optional(),usageTotalUsd:z.number().optional(),statusMessage:z.string().optional(),chargedEventCounts:z.record(z.string(),z.number()).optional()});
if(command==='search'||command==='comments'){
  if(!inputFile)throw new Error('Input JSON file required');
  const source=JSON.parse(await readFile(inputFile,'utf8'));
  const input=command==='search'?z.object({query:z.string().min(1).max(100),resultsCount:z.number().int().min(1).max(20),searchType:z.enum(['top','latest'])}).strict().parse(source):z.object({startUrls:z.array(z.object({url:z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&['www.facebook.com','facebook.com'].includes(u.hostname)&&!u.port&&!u.username&&!u.password;})}).strict()).min(1).max(3),resultsLimit:z.number().int().min(1).max(20),includeNestedComments:z.literal(false),viewOption:z.enum(['RECENT_ACTIVITY','RANKED_THREADED','RANKED_UNFILTERED'])}).strict().parse(source);
  const actor=command==='search'?'scraper_one~facebook-posts-search':'apify~facebook-comments-scraper';
  const actorId=command==='search'?'TMBawM4LZpKN15DZX':'us5srxAYnsrkgUv2v';
  const maxTotalChargeUsd=command==='search'?0.15:0.30;
  const receipt={label,actor,actor_id:actorId,account_id:connection.user_id,input,max_total_charge_usd:maxTotalChargeUsd,requested_at:new Date().toISOString(),state:'SUBMISSION_PENDING'};
  await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  // Do not automatically retry this POST if the response is lost; reconcile the Apify run list.
  const raw=await api('actors/'+actor+'/runs?maxTotalChargeUsd='+maxTotalChargeUsd+'&timeout=240&waitForFinish=0&restartOnError=false',{method:'POST',body:JSON.stringify(input)});
  const run=runSchema.parse((raw as {data:unknown}).data);
  if(run.userId!==connection.user_id||run.actId!==actorId)throw new Error('Run ownership mismatch');
  await writeFile(receiptPath,JSON.stringify({...receipt,state:'SUBMITTED',run},null,2)+'\n');
  console.log(JSON.stringify({label,run_id:run.id,status:run.status,max_total_charge_usd:maxTotalChargeUsd}));
}else{
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  if(receipt.account_id!==connection.user_id||!receipt.run?.id)throw new Error('Missing verified run receipt; reconcile submission before retrying');
  const raw=await api('actor-runs/'+encodeURIComponent(receipt.run.id));
  const run=runSchema.parse((raw as {data:unknown}).data);
  if(run.userId!==connection.user_id||run.id!==receipt.run.id||run.actId!==receipt.actor_id)throw new Error('Run ownership mismatch');
  await writeFile(receiptPath,JSON.stringify({...receipt,checked_at:new Date().toISOString(),run},null,2)+'\n');
  if(command==='results'){
    if(run.status!=='SUCCEEDED')throw new Error('Run is not successful: '+run.status);
    const data=await api('datasets/'+run.defaultDatasetId+'/items?format=json&clean=false&limit=100');
    const rows=z.array(z.unknown()).max(100).parse(data);
    const resultPath=path.join(dir,label+'.items.json');
    await writeFile(resultPath,JSON.stringify(rows,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({label,run_id:run.id,status:run.status,items:rows.length,usage_total_usd:run.usageTotalUsd,result_path:resultPath}));
  }else console.log(JSON.stringify({label,run_id:run.id,status:run.status,message:run.statusMessage,usage_total_usd:run.usageTotalUsd,charged_event_counts:run.chargedEventCounts}));
}
