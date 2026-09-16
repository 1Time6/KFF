import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {copyFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root=fileURLToPath(new URL('../',import.meta.url)),{values}=parseArgs({options:{'agent-release':{type:'string'}}});
const hash=value=>createHash('sha256').update(value).digest('hex'),read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
if(process.platform!=='win32'||process.arch!=='x64'||!values['agent-release'])throw Error('Windows x64 and --agent-release are required');
const agent=realpathSync(values['agent-release']),agentManifest=read(path.join(agent,'release.json')),build=read(path.join(root,'.kff/checks/build.json')),pkg=read(path.join(root,'package.json'));
if(agentManifest.version!==pkg.version||build.exit_code!==0||build.changed_during_check.length)throw Error('A matching Agent and successful current build are required');
execFileSync(path.join(agent,'node.exe'),[path.join(agent,'agent-launch.mjs'),'verify'],{cwd:agent,windowsHide:true,stdio:'inherit'});
const sources=Object.keys(build.source_hashes).filter(file=>/^(apps|packages|scripts|supabase)\//.test(file)||['package.json','pnpm-lock.yaml','tsconfig.json'].includes(file));
for(const file of sources)if(hash(readFileSync(path.join(root,file)))!==build.source_hashes[file])throw Error('Build is stale: '+file);
for(const [file,digest] of Object.entries(agentManifest.source_hashes))if(/^(apps\/agent|packages\/contracts|packages\/adapters)\//.test(file)&&hash(readFileSync(path.join(root,file)))!==digest)throw Error('Agent source differs: '+file);
const nodeLicense=path.join(root,`scripts/licenses/node-v${process.versions.node}.txt`);if(!existsSync(nodeLicense))throw Error('Exact Node license is required');
const extraSources=['scripts/local-runtime.ps1','docs/api/controller-delivery.md'];
const extraHashes=Object.fromEntries(extraSources.map(file=>[file,hash(readFileSync(path.join(root,file)))]));
const releaseId=`kff-controller-${pkg.version}-win32-x64-${hash(JSON.stringify({sources:build.source_hashes,extra_sources:extraHashes,agent:agentManifest.release_id,node:hash(readFileSync(process.execPath)),build:readFileSync(path.join(root,'apps/web/.next-production/BUILD_ID'),'utf8')})).slice(0,12)}`;
const destination=path.join(root,'dist',releaseId);if(existsSync(destination)||existsSync(destination+'.zip'))throw Error('Keep the existing release immutable: '+destination);
mkdirSync(destination,{recursive:true});
const copies=[],directories=new Set();
function copy(source,relative){if(!lstatSync(source).isFile())throw Error('Non-regular package input: '+relative);const file=path.join(destination,relative),directory=path.dirname(file);if(!directories.has(directory)){mkdirSync(directory,{recursive:true});directories.add(directory);}copies.push({source,file});}
async function parallel(items,work){let cursor=0;await Promise.all(Array.from({length:8},async()=>{while(cursor<items.length)await work(items[cursor++]);}));}
function tree(source,relative,skipNodeModules=false){
 for(const entry of readdirSync(source,{withFileTypes:true})){
  if(skipNodeModules&&entry.name==='node_modules'||relative==='apps/web/.next-production'&&entry.name==='cache')continue;
  if(entry.isSymbolicLink()){
   // Next creates hashed aliases for serverExternalPackages. Materialize only these
   // verified installed packages so the archive has no links to this build machine.
   if(relative!=='apps/web/.next-production/node_modules')throw Error('Unhandled package link: '+relative+'/'+entry.name);
   const linked=realpathSync(path.join(source,entry.name)),meta=read(path.join(linked,'package.json')),within=path.relative(realpathSync(path.join(root,'node_modules')),linked);
   if(within.startsWith('..')||path.isAbsolute(within)||!['pg','exceljs','csv-stringify'].includes(meta.name)||!new RegExp('^'+meta.name+'-[a-f0-9]{16}$').test(entry.name))throw Error('Unexpected external package alias');
   tree(linked,relative+'/'+entry.name,true);continue;
  }
  if(entry.isDirectory())tree(path.join(source,entry.name),relative+'/'+entry.name,skipNodeModules);else copy(path.join(source,entry.name),relative+'/'+entry.name);
 }
}
for(const file of sources)copy(path.join(root,file),file);
copy(path.join(root,'scripts/local-runtime.ps1'),'scripts/local-runtime.ps1');
for(const directory of ['apps/web/public'])if(existsSync(path.join(root,directory)))tree(path.join(root,directory),directory);
tree(path.join(root,'apps/web/.next-production'),'apps/web/.next-production');tree(agent,'agent');
copy(process.execPath,'node.exe');copy(nodeLicense,'NODE-LICENSE.txt');copy(path.join(root,'scripts/controller-launch.mjs'),'controller-launch.mjs');copy(path.join(root,'docs/api/controller-delivery.md'),'README.md');
copy(path.join(root,'.kff/checks/build.json'),'release-build.json');
if(existsSync(path.join(root,'docs/evidence/facebook-contracts.json')))copy(path.join(root,'docs/evidence/facebook-contracts.json'),'docs/evidence/facebook-contracts.json');
writeFileSync(path.join(destination,'controller.cmd'),'@echo off\r\n"%~dp0node.exe" "%~dp0controller-launch.mjs" %*\r\nexit /b %errorlevel%\r\n');

// Resolve each dependency from its installed parent. Conflicting versions remain nested.
const installed=new Map(),queue=[];
function packageRoot(name,from){
 const require=createRequire(path.join(from,'package.json'));
 try{return path.dirname(require.resolve(name+'/package.json'));}catch{
  let dir=path.dirname(require.resolve(name));while(dir!==path.dirname(dir)){if(existsSync(path.join(dir,'package.json'))&&read(path.join(dir,'package.json')).name===name)return dir;dir=path.dirname(dir);}throw Error('Cannot locate dependency: '+name);
 }
}
function dependency(name,from,fromTarget,optional=false){
 let source;try{source=realpathSync(packageRoot(name,from));}catch(e){if(optional)return;throw e;}
 const meta=read(path.join(source,'package.json')),allowed=(list,value)=>!list||!list.includes('!'+value)&&(list.every(x=>x.startsWith('!'))||list.includes(value));
 if(!allowed(meta.os,process.platform)||!allowed(meta.cpu,process.arch)){if(optional)return;throw Error('Unsupported dependency: '+name);}
 let cursor=fromTarget,resolved;
 while(true){const candidate=(cursor?cursor+'/':'')+'node_modules/'+name;if(installed.has(candidate)){resolved=candidate;break;}if(!cursor)break;const parent=path.posix.dirname(cursor);cursor=parent==='.'?'':parent;}
 if(resolved&&installed.get(resolved).version===meta.version)return;
 const target=resolved?(fromTarget?fromTarget+'/':'')+'node_modules/'+name:'node_modules/'+name;
 if(installed.has(target)){if(installed.get(target).version!==meta.version)throw Error('Dependency collision: '+target);return;}
 installed.set(target,{name,version:meta.version});tree(source,target,true);queue.push({source,target,meta});
}
for(const name of [...Object.keys(pkg.dependencies),'tsx','@playwright/test','typescript','embedded-postgres'])dependency(name,root,'');
for(let i=0;i<queue.length;i++){const item=queue[i];for(const child of Object.keys(item.meta.dependencies??{}))dependency(child,item.source,item.target,Boolean(item.meta.optionalDependencies?.[child]));for(const child of Object.keys(item.meta.optionalDependencies??{}))dependency(child,item.source,item.target,true);}
await parallel(copies,({source,file})=>copyFile(source,file));

const secrets=[];for(const filename of ['.kff/local-config.json','.kff/agent-config.json'])if(existsSync(path.join(root,filename))){const value=read(path.join(root,filename));for(const key of ['database_url','database_password','session_secret','operator_password','agent_token','token'])if(typeof value[key]==='string'&&value[key].length>=12)secrets.push(Buffer.from(value[key]));}
const files={},pending=[];let bytes=0;
function inventory(dir,prefix=''){
 for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix+entry.name,file=path.join(dir,entry.name);if(entry.isDirectory())inventory(file,relative+'/');else pending.push({file,relative});}
}
inventory(destination);
await parallel(pending,async({file,relative})=>{const contents=await readFile(file);if(secrets.some(secret=>contents.includes(secret)))throw Error('Live configuration value found in package input; release not published');files[relative]=hash(contents);bytes+=contents.length;});
writeFileSync(path.join(destination,'release.json'),JSON.stringify({schema_version:'kff.controller-release.v1',release_id:releaseId,version:pkg.version,platform:process.platform,arch:process.arch,node_version:process.versions.node,agent_release_id:agentManifest.release_id,created_at:new Date().toISOString(),dependencies:Object.fromEntries(installed),files},null,2));
execFileSync(path.join(destination,'node.exe'),[path.join(destination,'controller-launch.mjs'),'verify'],{cwd:destination,windowsHide:true,stdio:'inherit'});
execFileSync('tar.exe',['-a','-c','-f',destination+'.zip','-C',path.dirname(destination),releaseId],{windowsHide:true});
const result={release_id:releaseId,directory:destination,archive:destination+'.zip',archive_sha256:hash(readFileSync(destination+'.zip')),files:Object.keys(files).length,uncompressed_bytes:bytes,dependency_packages:installed.size,contains_runtime_data:false,live_config_values_scanned:secrets.length};
writeFileSync(destination+'.zip.sha256',result.archive_sha256+'  '+releaseId+'.zip\n');console.log(JSON.stringify(result));
