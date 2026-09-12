import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
const schema=z.object({agent_id:z.string().uuid(),organization_id:z.string().uuid(),brand_id:z.string().uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),controller_origin:z.string().url()}).strict();
export function loadAgentConfiguration(root:string,environment:Readonly<Record<string,string|undefined>>=process.env){
  const base=path.join(root,'.kff'),defaultFile=path.join(base,'agent-config.json'),file=environment.KFF_AGENT_CONFIG_FILE?path.resolve(root,environment.KFF_AGENT_CONFIG_FILE):defaultFile;
  const configured=schema.parse(JSON.parse(readFileSync(file,'utf8'))),isDefault=existsSync(defaultFile)&&schema.parse(JSON.parse(readFileSync(defaultFile,'utf8'))).agent_id===configured.agent_id;
  const controller=new URL(environment.KFF_APP_ORIGIN??configured.controller_origin);
  if(controller.origin!==controller.href.replace(/\/$/,'')||controller.username||controller.password||!(controller.protocol==='https:'||(controller.protocol==='http:'&&controller.hostname==='127.0.0.1')))throw new Error('INVALID_CONTROLLER_ORIGIN');
  // Same Agent identity shares one journal/lock even when its pairing file is copied.
  return {runtimeDir:isDefault?base:path.join(base,'agent-instances',configured.agent_id),agentConfig:{...configured,token:environment.KFF_AGENT_CONFIG_FILE?configured.token:environment.KFF_AGENT_TOKEN??configured.token,controller_origin:controller.origin}};
}
