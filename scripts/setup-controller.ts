import {existsSync,readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {initializeLocalConfig,transaction,closePool,projectRoot} from '../packages/database/src/index';
import {digest,hashPassword} from '../packages/core/src/index';
import {startDatabase} from './database';
import {migrate} from './migrate';
import {ensureBundledTemplates} from '../packages/core/src/templates';
import {registerFacebookContractEvidence} from './facebook-contract-evidence';

const {values}=parseArgs({options:{'database-port':{type:'string'}}}),root=realpathSync(projectRoot),data=path.join(root,'.kff'),port=Number(values['database-port']??55432);
if(process.platform!=='win32'||process.arch!=='x64'||root!==realpathSync(process.cwd())||process.env.DATABASE_URL||existsSync(data))throw Error('Fresh Windows installation required; existing data and external database overrides are refused');
const manifest=JSON.parse(readFileSync(path.join(root,'release.json'),'utf8'));
if(manifest.schema_version!=='kff.controller-release.v1'||!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid installation or database port');
for(const selected of [3000,port]){
 const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(selected,'127.0.0.1',()=>probe.close(()=>resolve()));});
}
const config=initializeLocalConfig();
if(port!==55432){const url=new URL(config.database_url);url.port=String(port);config.database_url=url.href;writeFileSync(path.join(data,'local-config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});}
let database:Awaited<ReturnType<typeof startDatabase>>|undefined;
try{
 database=await startDatabase(path.join(data,'postgres'),port);await migrate();
 // The shipped controller carries the contract reports and their test files; registering them here
 // is what lets a fresh installation attach local capability evidence without a developer checkout.
 // The document goes under the mutable .kff runtime directory: setup must not add files to the
 // release tree, because every later start re-verifies that tree against the release manifest.
 const contractEvidence=await registerFacebookContractEvidence(root,{documentPath:path.join(data,'evidence/facebook-contracts.json')});
 await transaction(async client=>{
  const organization='11111111-1111-4111-8111-111111111111',brand='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',agent='66666666-6666-4666-8666-666666666666';
  if((await client.query('SELECT id FROM kff.organizations LIMIT 1')).rowCount)throw Error('Existing organization refused');
  await client.query("INSERT INTO kff.organizations(id,name) VALUES($1,'KFF 本地工作区')",[organization]);
  await client.query("INSERT INTO kff.organization_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",[organization,user]);
  await client.query("INSERT INTO kff.brands(id,organization_id,name) VALUES($1,$2,'默认品牌')",[brand,organization]);
  await client.query("INSERT INTO kff.local_users(id,email,password_hash) VALUES($1,'operator@kff.local',$2)",[user,hashPassword(config.operator_password)]);
  await client.query("INSERT INTO kff.memberships(user_id,organization_id,brand_id,role) VALUES($1,$2,$3,'admin')",[user,organization,brand]);
  await client.query("INSERT INTO kff.agents(id,organization_id,brand_id,name,token_hash,status) VALUES($1,$2,$3,'本机 Agent',$4,'PAIRED')",[agent,organization,brand,digest(config.agent_token)]);
  await ensureBundledTemplates(client,{organization_id:organization,brand_id:brand,user_id:user,role:'admin'});
 });
 mkdirSync(path.join(data,'checks'),{recursive:true});writeFileSync(path.join(data,'checks/build.json'),readFileSync(path.join(root,'release-build.json')));
 execFileSync(process.execPath,['--import','tsx','scripts/local-runtime.ts','configure','--agent-release',path.join(root,'agent'),'--discovery','--inbox'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:process.env});
 writeFileSync(path.join(data,'本地登录.txt'),'地址：http://127.0.0.1:3000\n账号：operator@kff.local\n密码：'+config.operator_password+'\n仅用于这台本机，勿分享此文件。\n',{mode:0o600});
 console.log(JSON.stringify({configured:true,empty_workspace:true,synthetic_accounts_created:0,live_sending_enabled:false,contract_evidence:contractEvidence,login_file:path.join(data,'本地登录.txt')}));
}finally{await closePool();await database?.stop();}
