import {spawn,execFileSync,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,readdirSync,realpathSync} from 'node:fs';
import {createServer,createConnection,type Server} from 'node:net';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs,parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {z} from 'zod';
import {localSupervisionProtocol} from '../packages/contracts/src/local-supervision';
import {saveRuntimeJson as save} from './local-runtime-state';

const root=realpathSync(process.cwd()),directory=path.join(root,'.kff','local-runtime');
const configFile=path.join(root,'.kff','local-runtime.json'),stateFile=path.join(directory,'state.json'),controlFile=path.join(directory,'control.json');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const read=(file:string)=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const pipe=process.platform==='win32'?'\\\\.\\pipe\\kff-runtime-'+hash(root.toLowerCase()).slice(0,24):path.join(directory,'control.sock');
const {positionals,values}=parseArgs({allowPositionals:true,options:{'agent-release':{type:'string'},discovery:{type:'boolean'},inbox:{type:'boolean'},live:{type:'boolean'}}});
const command=positionals[0]??'status';
if(positionals.length>1||!['configure','run','status','stop','recover'].includes(command))throw Error('Use local-runtime.ts configure|run|status|stop|recover');
const configSchema=z.object({schema:z.literal('kff.local-runtime.v1'),agent_release:z.string(),discovery_enabled:z.boolean(),browser_inbox_enabled:z.boolean(),live_sending_enabled:z.boolean(),build_id:z.string(),build_sha256:z.string().length(64)}).strict();
type Config=z.infer<typeof configSchema>;
type Component={pid:number|null;state:string;exit_code?:number|null};
type State={runtime_id:string;pid:number;phase:string;updated_at:string;app_origin:string;release_id:string;database_owned:boolean;components:Record<string,Component>;error?:string};
async function request(action:'status'|'stop'|'recover'){
 const control=z.object({token:z.string().uuid()}).parse(read(controlFile));
 return await new Promise<State>((resolve,reject)=>{
  const socket=createConnection(pipe);let buffer='';socket.setTimeout(4000);
  socket.on('connect',()=>socket.write(JSON.stringify({token:control.token,action})+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536){socket.destroy();reject(Error('Invalid runtime response'));}else if(buffer.includes('\n')){try{const result=JSON.parse(buffer.split('\n')[0]);socket.end();resolve(result);}catch{socket.destroy();reject(Error('Invalid runtime response'));}}});
  socket.on('timeout',()=>socket.destroy(Error('Runtime control timed out')));socket.on('error',reject);
 });
}
function verifyBuild(config?:Config){
 const check=read(path.join(root,'.kff/checks/build.json'));
 if(check.exit_code!==0||check.changed_during_check.length)throw Error('Run a successful current build first');
 for(const [file,digest] of Object.entries(check.source_hashes)){
  if((/^(apps|packages|scripts)\//.test(file)||['package.json','pnpm-lock.yaml','tsconfig.json'].includes(file))&&hash(readFileSync(path.join(root,file)))!==digest)throw Error('Build is stale: '+file);
 }
 const buildFile=path.join(root,'apps/web/.next-production/BUILD_ID'),buildId=readFileSync(buildFile,'utf8').trim(),buildHash=hash(readFileSync(buildFile));
 if(config&&(config.build_id!==buildId||config.build_sha256!==buildHash))throw Error('Prepared build changed; configure the runtime again');
 return {build_id:buildId,build_sha256:buildHash};
}
function verifyAgent(release:string){
 if(!path.isAbsolute(release)||realpathSync(release)===root)throw Error('A verified installed Agent release is required');
 const manifest=read(path.join(release,'release.json'));
 if(manifest.local_supervision_protocol!==localSupervisionProtocol)throw Error('Agent does not support graceful local supervision');
 execFileSync(path.join(release,'node.exe'),[path.join(release,'agent-launch.mjs'),'verify'],{cwd:release,windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const [file,digest] of Object.entries(manifest.source_hashes))if(/^(apps\/agent|packages\/contracts|packages\/adapters)\//.test(file)&&hash(readFileSync(path.join(root,file)))!==digest)throw Error('Installed Agent differs from the current source: '+file);
 return manifest.release_id as string;
}
if(command==='configure'){
 if(existsSync(controlFile)){let active=false;try{await request('status');active=true;}catch{}if(active)throw Error('Stop the existing runtime before changing its configuration');}
 if(!values['agent-release'])throw Error('--agent-release requires an installed release directory');
 const release=realpathSync(values['agent-release']);verifyAgent(release);const build=verifyBuild();
 mkdirSync(directory,{recursive:true});if(existsSync(configFile))writeFileSync(path.join(directory,'config-before-'+Date.now()+'.json'),readFileSync(configFile),{flag:'wx',mode:0o600});
 const config:Config={schema:'kff.local-runtime.v1',agent_release:release,discovery_enabled:values.discovery??false,browser_inbox_enabled:values.inbox??false,live_sending_enabled:values.live??false,...build};save(configFile,config);console.log(JSON.stringify({configured:true,...config}));
}else if(command!=='run'){
 try{console.log(JSON.stringify(await request(command==='stop'?'stop':command==='recover'?'recover':'status')));}
 catch{
  const previous=existsSync(stateFile)?read(stateFile):null;
  let pidAlive=false;if(previous?.pid)try{process.kill(previous.pid,0);pidAlive=true;}catch{}
  console.log(JSON.stringify({phase:previous?.phase==='STOPPED'?'STOPPED':pidAlive?'CONTROL_UNAVAILABLE':'NOT_RUNNING',owner_process_alive:pidAlive,last_state:previous}));
  if(command!=='status'||pidAlive)process.exitCode=1;
 }
}else{
 if(existsSync(path.join(root,'.kff/upgrade-in-progress.json')))throw Error('UPGRADE_INCOMPLETE: inspect the preserved upgrade record before starting');
 const config=configSchema.parse(read(configFile));verifyBuild(config);const releaseId=verifyAgent(config.agent_release);
 const local=read(path.join(root,'.kff/local-config.json')),pairing=read(path.join(root,'.kff/agent-config.json'));
 const receptionEnvFile=path.join(root,'.kff/reception-ai.env');
 if(existsSync(receptionEnvFile)){
  const receptionEnv=parseEnv(readFileSync(receptionEnvFile,'utf8'));
  for(const key of ['KFF_RECEPTION_AI_URL','KFF_RECEPTION_AI_KEY','KFF_RECEPTION_AI_MODEL'])if(process.env[key]===undefined&&receptionEnv[key]!==undefined)process.env[key]=receptionEnv[key];
 }
 if(pairing.controller_origin!=='http://127.0.0.1:3000')throw Error('This local runtime requires the existing local controller pairing');
 const dbUrl=new URL(local.database_url);if(dbUrl.hostname!=='127.0.0.1'||dbUrl.pathname!=='/kff')throw Error('This launcher only manages the configured local KFF database');
 const origin=pairing.controller_origin;Object.assign(process.env,{KFF_ROOT:root,DATABASE_URL:local.database_url,KFF_AUTH_MODE:'local',KFF_APP_ORIGIN:origin,KFF_ENABLE_LIVE:String(config.live_sending_enabled),KFF_ENABLE_DISCOVERY:String(config.discovery_enabled),KFF_ENABLE_BROWSER_INBOX:String(config.browser_inbox_enabled),NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'});
 mkdirSync(directory,{recursive:true});const token=randomUUID(),state:State={runtime_id:randomUUID(),pid:process.pid,phase:'STARTING',updated_at:new Date().toISOString(),app_origin:origin,release_id:releaseId,database_owned:false,components:{}};
 const children=new Map<string,ChildProcess>();let shutdown:Promise<void>|undefined,recovering:Promise<void>|undefined,stopping=false,started=false,infrastructureReady=false;
 let database:Awaited<ReturnType<typeof import('./existing-database').startExistingDatabase>>|undefined,fixture:Awaited<ReturnType<typeof import('./fixture-server').startFixtureServer>>|undefined;
 const update=()=>{state.updated_at=new Date().toISOString();save(stateFile,state);};
 async function drain(name:string){
  const child=children.get(name);if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  if(!child.connected)throw Error(name+' is alive without its supervision channel; inspect before stopping');
  child.send({protocol:localSupervisionProtocol,command:'drain'});
  // An observation timeout never terminates an accepted action or releases its guardian.
  while(child.exitCode===null&&child.signalCode===null)await delay(250);
  if(state.components[name].state!=='DRAINED')throw Error(name+' exited without a graceful drain acknowledgement');
 }
 async function stop(){
  stopping=true;state.phase='DRAINING_WORKER';update();await drain('worker');
  state.phase='DRAINING_AGENT';update();await drain('agent');
  if(children.has('agent')){
   const client=new pg.Client({connectionString:local.database_url,connectionTimeoutMillis:2000});await client.connect();
   try{const pending=(await client.query("SELECT (SELECT count(*)::int FROM kff.agent_commands WHERE claimed_at IS NOT NULL AND quiesced_at IS NULL) actions,(SELECT count(*)::int FROM kff.environment_commands WHERE state IN ('RUNNING','QUARANTINED')) environments")).rows[0];if(pending.actions||pending.environments)throw Error('Original browser closures are unresolved; controller remains running');}finally{await client.end();}
  }
  if(recovering)await recovering;
  state.phase='STOPPING_WEB';update();const web=children.get('web');if(web&&web.exitCode===null&&web.signalCode===null){web.kill('SIGTERM');while(web.exitCode===null&&web.signalCode===null)await delay(100);}
  await fixture?.close();if(database)await database.stop();state.phase='STOPPED';state.components.database={pid:null,state:database?'STOPPED':'EXTERNAL_UNCHANGED'};update();clearInterval(heartbeat);
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
 const server:Server=createServer(socket=>{
  let text='';socket.setTimeout(3000,()=>socket.destroy());socket.on('data',chunk=>{
   text+=chunk;if(text.length>1024){socket.destroy();return;}if(!text.includes('\n'))return;
   try{const input=z.object({token:z.string().uuid(),action:z.enum(['status','stop','recover'])}).strict().parse(JSON.parse(text.split('\n')[0]));if(!timingSafeEqual(Buffer.from(input.token),Buffer.from(token))){socket.destroy();return;}
    if(input.action==='recover'&&!recovering){if(!started||stopping&&!['DRAINING_WORKER','DRAINING_AGENT','STOP_BLOCKED'].includes(state.phase)){socket.end(JSON.stringify({...state,error:'Startup or final shutdown is in progress'})+'\n');return;}recovering=recover().catch(error=>{state.phase=stopping?'STOP_BLOCKED':'DEGRADED';state.error=error instanceof Error?error.message:'Recovery failed';update();}).finally(()=>{recovering=undefined;});}
    if(input.action==='stop'&&recovering){socket.end(JSON.stringify({...state,error:'Recovery is still in progress; inspect status before stopping'})+'\n');return;}
    if(input.action==='stop'&&!shutdown){if(!started){socket.end(JSON.stringify({...state,error:'Startup has not completed; inspect its current state'})+'\n');return;}shutdown=stop().catch(error=>{state.phase='STOP_BLOCKED';state.error=error instanceof Error?error.message:'Stop failed';update();shutdown=undefined;});}
    socket.end(JSON.stringify(state)+'\n');
   }catch{socket.destroy();}
  });
 });
 server.maxConnections=10;await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
 const previous:State|null=existsSync(stateFile)?read(stateFile):null;
 if(previous)writeFileSync(path.join(directory,'previous-'+state.runtime_id+'.json'),JSON.stringify(previous,null,2)+'\n',{flag:'wx',mode:0o600});
 save(controlFile,{token});update();const heartbeat=setInterval(update,2000);
 const agentEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|Path|SystemRoot|SYSTEMROOT|COMSPEC|ComSpec|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|KFF_ROOT|KFF_ENABLE_LIVE|KFF_ENABLE_DISCOVERY|KFF_ENABLE_BROWSER_INBOX|KFF_FACEBOOK_GRAPH_VERSION|KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY|PLAYWRIGHT_BROWSERS_PATH|NODE_ENV)$/.test(key)||/^(FACEBOOK|INSTAGRAM)_[A-Z0-9_]+$/.test(key)||/^KFF_BROWSER_PROXY_[A-Z0-9_]+$/.test(key)));
 function launch(name:string,executable:string,args:string[],ipc:boolean){
  const log=openSync(path.join(directory,state.runtime_id+'-'+name+'.log'),'a',0o600);
  const options:SpawnOptions={cwd:root,env:name==='agent'?{...agentEnv(),NODE_ENV:'production'}:{...process.env,KFF_LOCAL_RUNTIME_ID:state.runtime_id},windowsHide:true,stdio:ipc?['ignore',log,log,'ipc']:['ignore',log,log]};
  const child=spawn(executable,args,options);closeSync(log);children.set(name,child);state.components[name]={pid:child.pid??null,state:'STARTING'};
  child.on('message',message=>{if(children.get(name)===child&&typeof message==='object'&&message&&'protocol'in message&&message.protocol===localSupervisionProtocol&&'state'in message&&['RUNNING','DRAINING','DRAINED','STOPPED'].includes(String(message.state))){state.components[name].state=String(message.state);update();}});
  child.on('error',()=>{state.components[name].state='FAILED';state.phase='DEGRADED';state.error=name+' failed to start';update();});
  child.on('exit',code=>{if(state.components[name].state!=='DRAINED')state.components[name].state='EXITED';state.components[name].exit_code=code;if(!stopping){state.phase='DEGRADED';state.error=name+' exited; original journals are retained';}update();});update();return child;
 }
 const alive=(name:string)=>{const child=children.get(name);return Boolean(child&&child.pid&&child.exitCode===null&&child.signalCode===null);};
 async function startWeb(){
  const web=launch('web',process.execPath,['--import',pathToFileURL(path.join(root,'scripts/local-web-lifecycle.mjs')).href,path.join(root,'node_modules/next/dist/bin/next'),'start','apps/web','--hostname','127.0.0.1','--port','3000'],true);
  for(let end=Date.now()+60000;Date.now()<end&&alive('web');){try{const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(2000)});const body=await response.json();if(response.ok&&body.runtime_id===state.runtime_id&&children.get('web')===web){state.components.web.state='RUNNING';update();return;}}catch{}await delay(500);}
  throw Error('The selected web process did not become ready');
 }
 async function recover(){
  // Restart only children whose original process handle confirms exit. Never replace a live process.
  if(!infrastructureReady)throw Error('Database, schema or local services did not pass startup checks; stop and inspect before restarting');
  if(!stopping)state.phase='RECOVERING';delete state.error;update();verifyBuild(config);verifyAgent(config.agent_release);
  if(!alive('web'))await startWeb();
  else {const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(3000)});if(!response.ok||(await response.json()).runtime_id!==state.runtime_id)throw Error('Web process is still alive but not healthy; preserve it for inspection');}
  if(stopping)return;
  if(!alive('worker'))launch('worker',process.execPath,['--import','tsx',path.join(root,'apps/worker/src/main.ts')],true);
  if(!alive('agent'))launch('agent',path.join(config.agent_release,'node.exe'),[path.join(config.agent_release,'agent-launch.mjs'),'start','--data-root',root],true);
  for(let end=Date.now()+30000;Date.now()<end&&['worker','agent'].some(name=>alive(name)&&state.components[name]?.state!=='RUNNING');)await delay(250);
  if(!['worker','agent'].every(name=>alive(name)&&state.components[name]?.state==='RUNNING'))throw Error('Worker or Agent did not acknowledge recovery; original journals are retained');
  state.phase='RUNNING';delete state.error;update();
 }
 try{
  if(previous&&previous.phase!=='STOPPED'){
   const isAlive=(pid:number|null)=>{if(!Number.isSafeInteger(pid)||!pid||pid<1)return false;try{process.kill(pid,0);return true;}catch{return false;}};
   if(isAlive(previous.pid))throw Error('The previous supervisor process is still alive; preserve it for inspection');
   state.phase='RECOVERING';update();
   const pending=()=>Object.entries(previous.components).filter(([name,component])=>name!=='database'&&isAlive(component.pid)).map(([name])=>name);
   for(let end=Date.now()+60000;pending().length&&Date.now()<end;)await delay(500);
   if(pending().length)throw Error('Previous components are still closing: '+pending().join(', '));
  }
  const portProbe=createServer();await new Promise<void>((resolve,reject)=>{portProbe.once('error',reject);portProbe.listen(3000,'127.0.0.1',()=>portProbe.close(()=>resolve()));});
  const probe=new pg.Client({connectionString:local.database_url,connectionTimeoutMillis:2000});
  try{await probe.connect();}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ECONNREFUSED'))throw Error('Configured database is unavailable; existing data was not changed');if(!existsSync(path.join(root,'.kff/postgres/PG_VERSION')))throw Error('Existing database files are required; initialize separately');database=await(await import('./existing-database')).startExistingDatabase(path.join(root,'.kff/postgres'),Number(dbUrl.port),path.join(directory,state.runtime_id+'-postgres.log'));state.database_owned=true;}finally{await probe.end().catch(()=>{});}
  const client=new pg.Client({connectionString:local.database_url});await client.connect();try{
   const location=(await client.query("SELECT current_setting('data_directory') directory,current_setting('port') port")).rows[0];
   if(realpathSync(location.directory).toLowerCase()!==realpathSync(path.join(root,'.kff/postgres')).toLowerCase()||Number(location.port)!==Number(dbUrl.port))throw Error('Connected database directory or port differs from the selected local data');
   const migrations=(await client.query('SELECT version,sha256 FROM kff.schema_migrations ORDER BY version')).rows;const files=readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
   if(migrations.length!==files.length||files.some((file,i)=>migrations[i].version!==file||migrations[i].sha256!==hash(readFileSync(path.join(root,'supabase/migrations',file),'utf8').replace(/\r\n/g,'\n'))))throw Error('Database schema does not match this release; back up and migrate separately');
  }finally{await client.end();}
  state.components.database={pid:database?.pid??null,state:'CONNECTED'};fixture=await(await import('./fixture-server')).startFixtureServer();infrastructureReady=true;
  await startWeb();
  launch('worker',process.execPath,['--import','tsx',path.join(root,'apps/worker/src/main.ts')],true);
  launch('agent',path.join(config.agent_release,'node.exe'),[path.join(config.agent_release,'agent-launch.mjs'),'start','--data-root',root],true);
  for(let end=Date.now()+30000;Date.now()<end&&!['DEGRADED'].includes(state.phase)&&!['worker','agent'].every(n=>state.components[n]?.state==='RUNNING');)await delay(250);
  if(!['worker','agent'].every(n=>state.components[n]?.state==='RUNNING'))throw Error('Worker or Agent did not acknowledge startup');started=true;state.phase='RUNNING';update();
 }catch(error){state.phase='START_FAILED';state.error=error instanceof Error?error.message:'Startup failed';started=true;update();console.error(state.error);}
 process.on('SIGINT',()=>{if(!shutdown&&started)shutdown=stop().catch(error=>{state.phase='STOP_BLOCKED';state.error=String(error);update();shutdown=undefined;});});
 process.on('SIGTERM',()=>{if(!shutdown&&started)shutdown=stop().catch(error=>{state.phase='STOP_BLOCKED';state.error=String(error);update();shutdown=undefined;});});
}
