import {renameSync,writeFileSync} from 'node:fs';

export function saveRuntimeJson(file:string,value:unknown){
 const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flush:true});
 const deadline=Date.now()+1000;
 for(;;){
  try{renameSync(temporary,file);return;}
  catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code??'')||Date.now()>=deadline)throw error;
   // Windows readers can briefly deny replacement. Keep the old complete file until the atomic rename succeeds.
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(50,deadline-Date.now()));
  }
 }
}
