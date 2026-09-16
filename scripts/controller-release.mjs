import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export function controllerManifest(directory,currentNode=true){
 const root=realpathSync(directory),manifest=JSON.parse(readFileSync(path.join(root,'release.json'),'utf8'));
 if(manifest.schema_version!=='kff.controller-release.v1'||manifest.platform!==process.platform||manifest.arch!==process.arch||currentNode&&manifest.node_version!==process.versions.node)throw Error('CONTROLLER_RUNTIME_MISMATCH');
 if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||manifest.release_id!==`kff-controller-${manifest.version}-win32-x64-${String(manifest.release_id).slice(-12)}`||!/[a-f0-9]{12}$/.test(manifest.release_id)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('CONTROLLER_MANIFEST_INVALID');
 for(const [file,hash] of Object.entries(manifest.files))if(!file||file.includes('\\')||file.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(file)||file==='.kff'||file.startsWith('.kff/')||!/^[a-f0-9]{64}$/.test(hash))throw Error('CONTROLLER_MANIFEST_INVALID');
 for(const file of ['scripts/local-runtime.ps1','scripts/local-runtime.ts','scripts/setup-controller.ts','agent/agent-launch.mjs','apps/web/.next-production/BUILD_ID'])if(!manifest.files[file])throw Error('CONTROLLER_ENTRYPOINT_MISSING: '+file);
 return manifest;
}
export async function verifyControllerRelease(directory,currentNode=true){
 const root=realpathSync(directory),manifest=controllerManifest(root,currentNode),pending=[],seen=new Set();
 function walk(dir,prefix=''){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const relative=prefix+entry.name,file=path.join(dir,entry.name);
   if(relative==='.kff'||relative==='apps/web/.next-production/cache')continue;
   if(entry.isSymbolicLink())throw Error('CONTROLLER_LINK_NOT_ALLOWED');
   if(entry.isDirectory())walk(file,relative+'/');
   else{if(!lstatSync(file).isFile())throw Error('CONTROLLER_FILE_INVALID');if(relative!=='release.json')pending.push({file,relative});}
  }
 }
 walk(root);let cursor=0;
 await Promise.all(Array.from({length:8},async()=>{while(cursor<pending.length){const {file,relative}=pending[cursor++];if(createHash('sha256').update(await readFile(file)).digest('hex')!==manifest.files[relative])throw Error('CONTROLLER_HASH_MISMATCH: '+relative);seen.add(relative);}}));
 if(seen.size!==Object.keys(manifest.files).length)throw Error('CONTROLLER_FILE_MISSING');
 return {manifest,verified_files:seen.size};
}
