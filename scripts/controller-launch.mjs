import {execFileSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {controllerManifest,verifyControllerRelease} from './scripts/controller-release.mjs';

const root=realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const {positionals,values}=parseArgs({allowPositionals:true,options:{'database-port':{type:'string'},from:{type:'string'}}});
const [command='help']=positionals;
if(positionals.length>1||!['help','verify','setup','upgrade','start','status','stop','recover'].includes(command)||values['database-port']&&!['setup','upgrade'].includes(command)||values.from&&command!=='upgrade'||command==='upgrade'&&!values.from)throw Error('Use controller.cmd help');
if(command==='help'){
 console.log('controller.cmd verify\ncontroller.cmd setup [--database-port 55432]\ncontroller.cmd upgrade --from <stopped older installation> [--database-port 55432]\ncontroller.cmd start|status|stop|recover\nSetup and upgrade require a new directory. Upgrade copies verified stopped data; the older directory is preserved. See README.md.');
}else{
 const manifest=controllerManifest(root);
 if(['start','recover'].includes(command)&&existsSync(path.join(root,'.kff/upgrade-in-progress.json')))throw Error('UPGRADE_INCOMPLETE: inspect the preserved upgrade record before starting');
 if(command==='setup'&&existsSync(path.join(root,'.kff')))throw Error('EXISTING_DATA_PRESERVED: setup only accepts a new installation');
 // Control/stop must remain responsive; the original runtime verifies build and
 // Agent integrity before any component recovery. Full scans belong to startup.
 const verified=['verify','setup','start'].includes(command)?await verifyControllerRelease(root):null;
 if(command==='verify')console.log(JSON.stringify({release_id:manifest.release_id,verified_files:verified.verified_files}));
 else {
  const env={...process.env,KFF_ROOT:root,PATH:root+path.delimiter+(process.env.PATH??process.env.Path??'')};
  for(const key of ['DATABASE_URL','KFF_AGENT_TOKEN','KFF_APP_ORIGIN','KFF_AGENT_CONFIG_FILE','TSX_TSCONFIG_PATH'])delete env[key];
  if(command==='upgrade'){
   execFileSync(process.execPath,['--import','tsx','scripts/upgrade-controller.mjs','--from',values.from,...(values['database-port']?['--database-port',values['database-port']]:[])],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  }else if(command==='setup'){
   if(existsSync(path.join(root,'.kff')))throw Error('EXISTING_DATA_PRESERVED: setup only accepts a new installation');
   execFileSync(process.execPath,['--import','tsx','scripts/setup-controller.ts',...(values['database-port']?['--database-port',values['database-port']]:[])],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  }else{
   if(!existsSync(path.join(root,'.kff/local-runtime.json')))throw Error('SETUP_REQUIRED');
   execFileSync(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/local-runtime.ps1','-Action',command[0].toUpperCase()+command.slice(1)],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  }
 }
}
