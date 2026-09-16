import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {projectRoot} from '@kff/database';

const connectionSchema=z.object({token:z.string().min(20),user_id:z.string().regex(/^[A-Za-z0-9]{17}$/)});
export function apifyConnection(){
  if(process.env.APIFY_API_TOKEN||process.env.APIFY_USER_ID){
    const parsed=connectionSchema.safeParse({token:process.env.APIFY_API_TOKEN,user_id:process.env.APIFY_USER_ID});
    return parsed.success?parsed.data:null;
  }
  if(process.env.KFF_AUTH_MODE!=='local')return null;
  const file=path.join(projectRoot,'.kff','apify-connection.json');
  if(!existsSync(file))return null;
  try{const parsed=connectionSchema.safeParse(JSON.parse(readFileSync(file,'utf8')));return parsed.success?parsed.data:null;}catch{return null;}
}
