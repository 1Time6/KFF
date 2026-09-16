import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {saveRuntimeJson} from '../../scripts/local-runtime-state';

const directories:string[]=[];
function fixture(){const directory=mkdtempSync(path.join(os.tmpdir(),'kff-runtime-state-'));directories.push(directory);const file=path.join(directory,'state.json');writeFileSync(file,JSON.stringify({phase:'OLD'}));return file;}
afterEach(()=>{for(const directory of directories.splice(0)){if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('kff-runtime-state-'))throw Error('Unexpected test directory');for(const file of readdirSync(directory))unlinkSync(path.join(directory,file));rmdirSync(directory);}});
async function readerLock(file:string,milliseconds:number){
 const script="$stream=[IO.File]::Open('"+file.replaceAll("'","''")+"',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();Start-Sleep -Milliseconds "+milliseconds+"}finally{$stream.Dispose()}";
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 const closed=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Lock helper exited '+code)));});
 await new Promise<void>((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('LOCKED'))resolve();});child.on('error',reject);child.on('exit',()=>{if(!output.includes('LOCKED'))reject(Error('Lock helper never acquired the file'));});});
 return {closed};
}
it('replaces a complete runtime state file',()=>{const file=fixture();saveRuntimeJson(file,{phase:'RUNNING'});expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({phase:'RUNNING'});expect(readdirSync(path.dirname(file))).toEqual(['state.json']);});
it.runIf(process.platform==='win32')('survives a real Windows reader temporarily denying file replacement',async()=>{
 const file=fixture(),{closed}=await readerLock(file,450);
 const started=Date.now();saveRuntimeJson(file,{phase:'RUNNING'});
 try{expect(Date.now()-started).toBeGreaterThanOrEqual(300);expect(Date.now()-started).toBeLessThan(1300);expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({phase:'RUNNING'});}finally{await closed;}
});
it.runIf(process.platform==='win32')('bounds a persistent lock failure while preserving the previous complete state',async()=>{
 const file=fixture(),{closed}=await readerLock(file,1800),started=Date.now();
 try{expect(()=>saveRuntimeJson(file,{phase:'RUNNING'})).toThrow();expect(Date.now()-started).toBeGreaterThanOrEqual(950);expect(Date.now()-started).toBeLessThan(1500);expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({phase:'OLD'});expect(JSON.parse(readFileSync(file+'.tmp','utf8'))).toEqual({phase:'RUNNING'});}finally{await closed;}
});
