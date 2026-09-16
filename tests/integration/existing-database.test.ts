import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import {expect,it} from 'vitest';
import {startExistingDatabase} from '../../scripts/existing-database';
import {startDatabase} from '../../scripts/database';
import {localConfig} from '../../packages/database/src/runtime';

it('starts only an existing cluster and cleanly rolls back an open transaction on shutdown, retaining committed data after restart',async()=>{
 const root=await mkdtemp(path.resolve('.kff/owned-database-test-')),data=path.join(root,'postgres'),password=randomUUID();await mkdir(data);
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 await expect(startExistingDatabase(data,port,path.join(root,'missing.log'))).rejects.toThrow();expect(existsSync(path.join(data,'PG_VERSION'))).toBe(false);
 const initializer=new EmbeddedPostgres({databaseDir:data,user:'kff_probe',password,port,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],onLog:()=>{},onError:()=>{}});await initializer.initialise();
 const clean=async(name:string)=>/database system is shut down/.test(await readFile(path.join(root,name),'utf8'));
 const clientOptions={host:'127.0.0.1',port,database:'postgres',user:'kff_probe',password,connectionTimeoutMillis:2000};let handle:Awaited<ReturnType<typeof startExistingDatabase>>|undefined,client:pg.Client|undefined;
 try{
  handle=await startExistingDatabase(data,port,path.join(root,'first.log'));const firstPid=handle.pid;
  await expect(startExistingDatabase(data,port,path.join(root,'duplicate.log'))).rejects.toThrow('Existing database process');
  client=new pg.Client(clientOptions);client.on('error',()=>{});await client.connect();
  await client.query('CREATE SCHEMA kff');await client.query('CREATE TABLE kff.cold_start_probe(id integer primary key,body text NOT NULL)');await client.query("INSERT INTO kff.cold_start_probe VALUES(1,'committed original')");
  await client.query('BEGIN');await client.query("UPDATE kff.cold_start_probe SET body='uncommitted change' WHERE id=1");
  await handle.stop();await handle.stop();expect(existsSync(path.join(data,'postmaster.pid'))).toBe(false);expect(await clean('first.log')).toBe(true);await client.end().catch(()=>{});client=undefined;
  handle=await startExistingDatabase(data,port,path.join(root,'second.log'));expect(handle.pid).not.toBe(firstPid);
  client=new pg.Client(clientOptions);await client.connect();expect((await client.query('SELECT body FROM kff.cold_start_probe WHERE id=1')).rows).toEqual([{body:'committed original'}]);
  const restartedLog=await readFile(path.join(root,'second.log'),'utf8');expect(restartedLog).toContain('database system was shut down');expect(restartedLog).not.toContain('database system was interrupted');
  expect((await readFile(path.join(data,'PG_VERSION'),'utf8')).trim()).toBe('17');await client.end();client=undefined;await handle.stop();expect(await clean('second.log')).toBe(true);
  await writeFile('.kff/checks/existing-database.json',JSON.stringify({recorded_at:new Date().toISOString(),synthetic:true,real_platform:false,directory:data,port,missing_directory_not_initialized:true,duplicate_start_rejected:true,uncommitted_transaction_rolled_back:true,committed_data_preserved:true,first_pid:firstPid,second_pid:handle.pid,clean_shutdown_verified:true,original_data_directory_retained:true},null,2));
 }finally{await client?.end().catch(()=>{});await handle?.stop();}
},90000);

it('uses the clean lifecycle from the existing bootstrap entry point and preserves its created KFF database',async()=>{
 const root=await mkdtemp(path.resolve('.kff/owned-bootstrap-test-')),data=path.join(root,'postgres');
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 let handle:Awaited<ReturnType<typeof startDatabase>>|undefined,client:pg.Client|undefined;
 try{
  handle=await startDatabase(data,port);const url=new URL(localConfig().database_url);url.port=String(port);
  client=new pg.Client({connectionString:url.href});await client.connect();expect((await client.query('SELECT current_database() name')).rows[0].name).toBe('kff');
  await client.query('CREATE TABLE bootstrap_probe(id integer primary key)');await client.query('INSERT INTO bootstrap_probe VALUES(1)');await client.end();client=undefined;await handle.stop();
  expect(await readFile(path.join(root,'postgres-'+port+'.log'),'utf8')).toContain('database system is shut down');
  handle=await startDatabase(data,port);client=new pg.Client({connectionString:url.href});await client.connect();expect((await client.query('SELECT * FROM bootstrap_probe')).rows).toEqual([{id:1}]);await client.end();client=undefined;await handle.stop();expect(existsSync(path.join(data,'postmaster.pid'))).toBe(false);
 }finally{await client?.end().catch(()=>{});await handle?.stop();}
},90000);
