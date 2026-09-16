import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {verifyControllerRelease} from './controller-release.mjs';
import {startExistingDatabase} from './existing-database.ts';
import {saveRuntimeJson} from './local-runtime-state.ts';
import {query,closePool} from '../packages/database/src/index.ts';
import {migrate} from './migrate.ts';
import {digest} from '../packages/core/src/index.ts';
import {adapterImplementationDigest} from '../packages/core/src/artifacts.ts';
import {attachLocalEvidence} from '../packages/core/src/capabilities.ts';

const {values}=parseArgs({options:{from:{type:'string'},'database-port':{type:'string'}}});
const root=realpathSync(fileURLToPath(new URL('../',import.meta.url))),data=path.join(root,'.kff');
if(process.platform!=='win32'||process.arch!=='x64'||realpathSync(process.cwd())!==root||process.env.KFF_ROOT&&realpathSync(process.env.KFF_ROOT)!==root||process.env.DATABASE_URL||!values.from||existsSync(data))throw Error('NEW_UPGRADE_TARGET_REQUIRED');
const source=realpathSync(path.resolve(values.from)),sourceData=path.join(source,'.kff');
const same=(a,b)=>a.toLowerCase()===b.toLowerCase(),inside=(a,b)=>b.toLowerCase().startsWith(a.toLowerCase()+path.sep);
if(same(root,source)||inside(root,source)||inside(source,root)||!existsSync(sourceData)||!same(realpathSync(sourceData),sourceData)||!/^[A-Za-z0-9: _./\\-]+$/.test(data))throw Error('UPGRADE_PATH_INVALID');
const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const checksum=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const locks=[];let database,record,marker;
async function lockRuntime(directory){
 const pipe='\\\\.\\pipe\\kff-runtime-'+createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0,24);
 // End with a non-JSON line so older request clients reject promptly instead of
 // waiting forever on a clean disconnect without an end handler.
 const server=createServer(socket=>{
  socket.on('error',()=>socket.destroy());
  socket.setTimeout(5000,()=>socket.destroy());
  socket.once('data',()=>socket.end('UPGRADE_MAINTENANCE\n'));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});locks.push(server);
}
const require=createRequire(import.meta.url),embeddedRequire=createRequire(require.resolve('embedded-postgres'));
const pgCtl=(await import(pathToFileURL(embeddedRequire.resolve('@embedded-postgres/windows-x64')).href)).pg_ctl;
const ctl=args=>new Promise((resolve,reject)=>{const child=spawn(pgCtl,args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>resolve(code??-1));});
async function stoppedSource(){
 const stateFile=path.join(sourceData,'local-runtime/state.json');
 if(existsSync(stateFile)&&read(stateFile).phase!=='STOPPED'||existsSync(path.join(sourceData,'upgrade-in-progress.json')))throw Error('STOP_OLD_CONTROLLER_FIRST');
 const pgData=path.join(sourceData,'postgres');
 if(!same(realpathSync(pgData),pgData)||readFileSync(path.join(pgData,'PG_VERSION'),'utf8').trim()!=='17'||['postmaster.pid','standby.signal','recovery.signal'].some(name=>existsSync(path.join(pgData,name)))||await ctl(['status','-D',pgData])!==3)throw Error('STOPPED_POSTGRES_17_REQUIRED');
}
function inventory(directory){
 const files=[];
 function walk(dir,prefix=''){
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const file=path.join(dir,entry.name),relative=prefix+entry.name;
   if(entry.isSymbolicLink()||!same(realpathSync(file),file))throw Error('UPGRADE_DATA_LINK_NOT_ALLOWED');
   if(entry.isDirectory())walk(file,relative+'/');
   else{if(!lstatSync(file).isFile()||['owner.lock','process.lock'].includes(entry.name))throw Error('UPGRADE_DATA_NOT_QUIESCENT');files.push({path:relative,bytes:lstatSync(file).size});}
  }
 }
 walk(directory);return files;
}
async function parallel(items,work){let cursor=0;const results=await Promise.allSettled(Array.from({length:4},async()=>{while(cursor<items.length)await work(items[cursor++]);}));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}
const stage=(phase,details={})=>{Object.assign(record,{phase,updated_at:new Date().toISOString()},details);saveRuntimeJson(marker,record);console.log(JSON.stringify({stage:phase,...details}));};
try{
 // The same control-pipe locks used by old/new launchers prevent either supervisor starting during the copy.
 await lockRuntime(source);await lockRuntime(root);await stoppedSource();
 const oldRelease=(await verifyControllerRelease(source,false)).manifest,nextRelease=(await verifyControllerRelease(root)).manifest;
 const a=oldRelease.version.split('.').map(Number),b=nextRelease.version.split('.').map(Number),difference=b.findIndex((v,i)=>v!==a[i]);
 if(a.some(v=>!Number.isSafeInteger(v))||b.some(v=>!Number.isSafeInteger(v))||difference<0||b[difference]<a[difference])throw Error('NEWER_CONTROLLER_RELEASE_REQUIRED');
 const oldSettings=read(path.join(sourceData,'local-runtime.json')),local=read(path.join(sourceData,'local-config.json')),pairing=read(path.join(sourceData,'agent-config.json'));
 if(oldSettings.schema!=='kff.local-runtime.v1'||oldSettings.live_sending_enabled!==false||!same(realpathSync(oldSettings.agent_release),path.join(source,'agent'))||pairing.controller_origin!=='http://127.0.0.1:3000')throw Error('PAUSED_LOCAL_CONTROLLER_CONFIGURATION_REQUIRED');
 const url=new URL(local.database_url),port=Number(values['database-port']??url.port);
 if(url.hostname!=='127.0.0.1'||url.pathname!=='/kff'||url.search||url.hash||!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('LOCAL_DATABASE_CONFIGURATION_REQUIRED');
 const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
 await stoppedSource();const files=inventory(sourceData);
 mkdirSync(data);marker=path.join(data,'upgrade-in-progress.json');
 record={schema_version:'kff.controller-upgrade.v1',id:randomUUID(),pid:process.pid,source,source_release:oldRelease.release_id,target:root,target_release:nextRelease.release_id,started_at:new Date().toISOString(),source_preserved:true};stage('COPYING');
 // Preserve empty PostgreSQL directories as well as files. Nothing in the old installation is written.
 function directories(from,to){for(const entry of readdirSync(from,{withFileTypes:true}))if(entry.isDirectory()){const child=path.join(to,entry.name);mkdirSync(child);directories(path.join(from,entry.name),child);}}
 directories(sourceData,data);
 await parallel(files,async entry=>{const from=path.join(sourceData,entry.path),to=path.join(data,entry.path);await copyFile(from,to,constants.COPYFILE_EXCL);const [original,copied]=await Promise.all([checksum(from),checksum(to)]);if(original!==copied||lstatSync(to).size!==entry.bytes)throw Error('UPGRADE_COPY_MISMATCH');entry.sha256=original;});
 await stoppedSource();if(JSON.stringify(inventory(sourceData))!==JSON.stringify(files.map(({path,bytes})=>({path,bytes}))))throw Error('UPGRADE_SOURCE_CHANGED');
 await parallel(files,async entry=>{if(await checksum(path.join(sourceData,entry.path))!==entry.sha256)throw Error('UPGRADE_SOURCE_CHANGED');});
 stage('COPY_VERIFIED',{copied_files:files.length,copied_bytes:files.reduce((n,f)=>n+f.bytes,0)});
 url.port=String(port);local.database_url=url.href;saveRuntimeJson(path.join(data,'local-config.json'),local);
 database=await startExistingDatabase(path.join(data,'postgres'),port,path.join(data,'upgrade-postgres.log'));
 const location=(await query("SELECT current_setting('data_directory') directory,current_setting('port') port")).at(0);
 if(!same(realpathSync(location.directory),path.join(data,'postgres'))||Number(location.port)!==port)throw Error('UPGRADE_DATABASE_IDENTITY_MISMATCH');
 // Only a stopped, paused workspace can be cut over; no pending execution is silently discarded.
 const pending=await query("SELECT 1 FROM kff.agent_commands WHERE quiesced_at IS NULL UNION ALL SELECT 1 FROM kff.environment_commands WHERE closed_at IS NULL UNION ALL SELECT 1 FROM kff.resource_leases WHERE quarantined OR holder_attempt_id IS NOT NULL OR holder_control_id IS NOT NULL UNION ALL SELECT 1 FROM kff.jobs WHERE state IN ('READY','LEASED') UNION ALL SELECT 1 FROM kff.acquisition_monitors WHERE state<>'PAUSED' UNION ALL SELECT 1 FROM kff.browser_inbox_monitors WHERE state<>'PAUSED' OR scan_requested OR current_task_id IS NOT NULL");
 if(pending.length)throw Error('PAUSE_AND_FINISH_OLD_WORK_FIRST');
 const paired=(await query('SELECT token_hash FROM kff.agents WHERE id=$1 AND organization_id=$2 AND brand_id=$3',[pairing.agent_id,pairing.organization_id,pairing.brand_id])).at(0);
 if(!paired||paired.token_hash!==digest(pairing.token))throw Error('UPGRADE_PAIRING_MISMATCH');
 const before=await query('SELECT version,sha256,applied_at FROM kff.schema_migrations ORDER BY version');
 const migrations=readdirSync(path.join(root,'supabase/migrations')).filter(name=>name.endsWith('.sql')).sort();
 for(const row of before)if(!migrations.includes(row.version)||digest(readFileSync(path.join(root,'supabase/migrations',row.version),'utf8').replaceAll('\r\n','\n'))!==row.sha256)throw Error('UPGRADE_MIGRATION_HISTORY_MISMATCH');
 stage('MIGRATING');await migrate();
 const artifact=read(path.join(root,'docs/evidence/facebook-contracts.json')),hash=adapterImplementationDigest(root,'facebook');
 if(artifact.kind!=='CODE_CONTRACT_ONLY'||artifact.implementation_digest!==hash||artifact.exit_code!==0||!artifact.test_count)throw Error('CURRENT_ADAPTER_EVIDENCE_REQUIRED');
 await query('INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[hash,artifact.adapter_version,artifact.source_hashes,artifact.test_count,artifact.command,artifact.ended_at,artifact]);
 const capabilities=await query("SELECT id,mode,evidence_state,implementation_digest FROM kff.capabilities WHERE organization_id=$1 AND brand_id=$2 AND NOT is_synthetic AND mode='CONTROLLED_PILOT' AND evidence_state='IMPLEMENTED_TEST_ONLY'",[pairing.organization_id,pairing.brand_id]);
 const changed=capabilities.filter(c=>c.implementation_digest!==hash);
 if(changed.length){
  const admins=await query("SELECT m.user_id FROM kff.memberships m JOIN kff.local_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.brand_id=$2 AND m.role='admin' AND u.email='operator@kff.local'",[pairing.organization_id,pairing.brand_id]);
  if(admins.length!==1)throw Error('PAIRED_BRAND_LOCAL_ADMIN_REQUIRED');
  const scope={organization_id:pairing.organization_id,brand_id:pairing.brand_id,user_id:admins[0].user_id,role:'admin'};
  for(const capability of changed)await attachLocalEvidence(scope,capability.id);
 }
 mkdirSync(path.join(data,'checks'),{recursive:true});writeFileSync(path.join(data,'checks/build.json'),readFileSync(path.join(root,'release-build.json')));
 const args=['--import','tsx','scripts/local-runtime.ts','configure','--agent-release',path.join(root,'agent')];if(oldSettings.discovery_enabled)args.push('--discovery');if(oldSettings.browser_inbox_enabled)args.push('--inbox');
 // Keep the maintenance-pipe server responsive while the existing configure
 // command checks whether a runtime is active. A synchronous child blocks it.
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,KFF_ROOT:root}});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('UPGRADE_RUNTIME_CONFIGURATION_FAILED')));
 });
 await closePool();await database.stop();database=undefined;
 await stoppedSource();await parallel(files,async entry=>{if(await checksum(path.join(sourceData,entry.path))!==entry.sha256)throw Error('UPGRADE_SOURCE_CHANGED');});
 stage('VERIFIED',{migrations_before:before.length,migrations_after:migrations.length,refreshed_capabilities:changed.length,live_sending_enabled:false,source_unchanged:true,target_database_closed:true});
 mkdirSync(path.join(data,'upgrades'),{recursive:true});record.finished_at=new Date().toISOString();saveRuntimeJson(path.join(data,'upgrades',record.id+'.json'),{...record,source_files:files});
 unlinkSync(marker);console.log(JSON.stringify({upgraded:true,from:oldRelease.release_id,to:nextRelease.release_id,source_preserved:true,data_directory:data,database_port:port,live_sending_enabled:false,login_file:path.join(data,'本地登录.txt')}));
}catch(error){
 if(marker&&record){record.error_code=error instanceof Error?error.message:'UPGRADE_FAILED';stage('FAILED');}
 throw error;
}finally{
 await closePool();if(database)await database.stop();for(const lock of locks)await new Promise(resolve=>lock.close(resolve));
}
