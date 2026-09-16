import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Production lifecycle for an existing cluster. Never initializes, seeds, or deletes data. */
export async function startExistingDatabase(directory:string,port:number,log:string){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('This local database launcher requires Windows x64');
 const data=realpathSync(directory),normalized=data.replaceAll('\\','/');
 if(data.toLowerCase()!==path.resolve(directory).toLowerCase()||!path.isAbsolute(log)||!Number.isSafeInteger(port)||port<1024||port>65535||!/^[A-Za-z0-9: _./-]+$/.test(normalized))throw Error('Unsupported or redirected local database path/port');
 if(readFileSync(path.join(data,'PG_VERSION'),'utf8').trim()!=='17'||['standby.signal','recovery.signal'].some(name=>existsSync(path.join(data,name))))throw Error('An existing primary PostgreSQL 17 directory is required');
 const require=createRequire(import.meta.url),embeddedRequire=createRequire(require.resolve('embedded-postgres'));
 const pgCtl=(await import(pathToFileURL(embeddedRequire.resolve('@embedded-postgres/windows-x64')).href)).pg_ctl as string;
 const ctl=(args:string[])=>new Promise<number>((resolve,reject)=>{const child=spawn(pgCtl,args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>resolve(code??-1));});
 if(await ctl(['status','-D',data])!==3)throw Error('Existing database process or unavailable directory; do not start another');
 const options=`-h 127.0.0.1 -p ${port} -c "data_directory=${normalized}" -c "config_file=${normalized}/postgresql.conf" -c "hba_file=${normalized}/pg_hba.conf" -c "ident_file=${normalized}/pg_ident.conf"`;
 // A pg_ctl observation timeout can precede a late start. Leave the original log and state for inspection.
 if(await ctl(['start','-D',data,'-l',log,'-w','-t','60','-o',options])!==0)throw Error('Database startup did not confirm completion; inspect the original process and log');
 const identity=()=>{
  const lines=readFileSync(path.join(data,'postmaster.pid'),'utf8').split(/\r?\n/);
  const pid=Number(lines[0]),started=Number(lines[2]);
  if(!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(started)||started<1||Number(lines[3])!==port||path.resolve(lines[1]).toLowerCase()!==data.toLowerCase())throw Error('Database instance identity differs from the selected directory');
  return {pid,started,data,port};
 };
 const original=identity();let closed=false,stopRequested=false;
 return {pid:original.pid,started_at:new Date(original.started*1000).toISOString(),data_directory:data,async stop(){
  if(closed)return;
  if(stopRequested&&!existsSync(path.join(data,'postmaster.pid'))&&await ctl(['status','-D',data])===3){closed=true;return;}
  if(JSON.stringify(identity())!==JSON.stringify(original))throw Error('Database process instance changed; preserve it for inspection');
  // Fast shutdown rolls back open transactions and performs a clean shutdown; it is not immediate termination.
  stopRequested=true;
  if(await ctl(['stop','-D',data,'-m','fast','-w','-t','60'])!==0)throw Error('Database shutdown still unconfirmed; preserve the original instance');
  if(existsSync(path.join(data,'postmaster.pid'))||await ctl(['status','-D',data])!==3)throw Error('Database process has not confirmed exit');
  closed=true;
 }};
}
