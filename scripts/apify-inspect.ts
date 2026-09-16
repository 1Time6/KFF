import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {apifyConnection} from '../packages/adapters/src/apify-connection';
import {readBoundedJson} from '../packages/adapters/src/source-http';
import {projectRoot} from '@kff/database';

const connection=apifyConnection();if(!connection)throw new Error('Apify connection missing');
const get=async(resource:string)=>readBoundedJson(await fetch('https://api.apify.com/v2/'+resource,{headers:{Authorization:'Bearer '+connection.token},redirect:'error',signal:AbortSignal.timeout(15000)}));
const user=(await get('users/me')) as {data:{id:string;username:string}};
if(user.data.id!==connection.user_id)throw new Error('Apify account mismatch');
const names=['apify/facebook-comments-scraper','apify/instagram-comment-scraper','apify/facebook-posts-scraper','apify/instagram-hashtag-scraper','scraper_one/facebook-posts-search'];
const actors=[];
for(const name of names){
  const result=await get('actors/'+name.replace('/','~')) as {data:{id:string;name:string;username:string;isPublic:boolean}};
  if(result.data.username+'/'+result.data.name!==name)throw new Error('Actor mismatch');
  actors.push({name,id:result.data.id,is_public:result.data.isPublic,store_url:'https://apify.com/'+name,api_path:'/v2/actors/'+name.replace('/','~')+'/runs'});
}
const evidence={checked_at:new Date().toISOString(),account_verified:true,username:user.data.username,actors,actor_runs_started:0,real_comments_ingested:0,kff_ingestion:'CODE_CONTRACT_ONLY',credentials_included:false};
await mkdir(path.join(projectRoot,'docs/evidence'),{recursive:true});await writeFile(path.join(projectRoot,'docs/evidence/apify-connection.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
