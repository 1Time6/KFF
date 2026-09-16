import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {startFixtureServer} from '../../scripts/fixture-server';
import {query,closePool} from '@kff/database';
import {AppError,digest} from '@kff/core';
import {resultInput,heartbeatInput,quiescenceInput,uuid} from '@kff/contracts';
import {authenticateAgent,agentHeartbeat,claimCommand,dispatchOne,beginSubmission,commandStatus,recordBrowserOpened,acceptReport} from '../../packages/core/src/execution';
import {claimEnvironmentCommand} from '../../packages/core/src/environments';
import {recordQuiescence} from '../../packages/core/src/reconciliation';
import {createAgent} from '../../packages/core/src/controls';
import {createFacebookFixture,configureFacebook} from '../../packages/core/src/facebook-inbound';
import {configureBrowserInbox,controlBrowserInbox,prepareBrowserInboxPage,syncBrowserInboxTasks} from '../../packages/core/src/browser-inbox';
import {browserInboxSetup} from '../helpers/browser-inbox';
import {leadScope as scope,clearLeads} from '../helpers/lead-fixture';
import {localSupervisionProtocol} from '../../packages/contracts/src/local-supervision';
import {readClosureEvidence,closureProof} from '../../apps/agent/src/guardian-protocol';
import type {JournalEntry} from '../../apps/agent/src/action-journal';

beforeAll(async()=>{await migrate();await seed();});beforeEach(clearLeads);afterAll(closePool);
async function killOwned(child?:ChildProcess){if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await exited;}}
const childMessages=(child:ChildProcess)=>{const states:string[]=[];child.on('message',m=>{if(typeof m==='object'&&m&&'protocol'in m&&m.protocol===localSupervisionProtocol&&'state'in m)states.push(String(m.state));});return states;};

it.each(['drain','parent-disconnect'] as const)('preserves the original receipt after lost acknowledgement and %s',async(mode)=>{
 const root=await mkdtemp(path.resolve('.kff/local-supervision-'));await mkdir(path.join(root,'.kff'));
 const fixture=await startFixtureServer(0,path.join(root,'fixture'));let hold=true,received=0,claims=0,commandId='',busy=false;const errors:string[]=[];
 const server=createServer(async(req,res)=>{try{
  const agent=await authenticateAgent(new Request('http://127.0.0.1'+req.url,{headers:{authorization:req.headers.authorization??''}}));
  let raw='';for await(const chunk of req)raw+=String(chunk);const body=JSON.parse(raw||'{}'),endpoint=req.url?.replace('/api/agent/',''),match=/^commands\/([^/]+)\/(status|submit|context-opened|quiescence)$/.exec(endpoint??'');let result:unknown;
  if(endpoint==='heartbeats')result=await agentHeartbeat(agent,heartbeatInput.parse(body).command_id);
  else if(endpoint==='environment-claims')result={command:await claimEnvironmentCommand(agent)};
  else if(endpoint==='claims'){claims++;result={command:await claimCommand(agent)};}
  else if(endpoint==='action-reports'){const report=resultInput.parse(body);result=await acceptReport(agent,report);commandId=report.command_id;received++;if(hold){req.socket.destroy();return;}}
  else if(match){const id=uuid.parse(match[1]);if(match[2]==='status')result=await commandStatus(agent,id);if(match[2]==='submit')result=await beginSubmission(agent,id);if(match[2]==='context-opened')result=await recordBrowserOpened(agent,id);if(match[2]==='quiescence')result=await recordQuiescence(agent,id,quiescenceInput.parse(body));}
  else throw Error('Unexpected endpoint');res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
 }catch(error){errors.push(error instanceof Error?error.message:'Bridge failed');res.writeHead(error instanceof AppError?error.status:500).end(JSON.stringify({error:{code:'TEST_ERROR'}}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 let child:ChildProcess|undefined;const timer=setInterval(()=>{if(busy)return;busy=true;void(async()=>{try{await syncBrowserInboxTasks();await prepareBrowserInboxPage();await dispatchOne();}finally{busy=false;}})();},200);
 try{
  const paired=await createAgent(scope,{name:'Graceful local supervisor'});await writeFile(path.join(root,'.kff/agent-config.json'),JSON.stringify({...paired.configuration,controller_origin:origin}));
  const account=await createFacebookFixture(scope,{request_id:randomUUID(),name:'Graceful browser fixture',page_id:BigInt('0x'+randomUUID().replaceAll('-','')).toString(),agent_id:paired.agent.id});const binding=await browserInboxSetup(scope,account);
  await configureFacebook(scope,{request_id:randomUUID(),...account,expected_version:0,transport:'BROWSER',state:'ACTIVE',auto_reply:false,reply_window_hours:24,policy_ref:'kff.browser-fixture.service-window.v1'});
  const page=binding.binding.environment.configuration.operating_identity_id;
  await fetch(fixture.origin+'/browser-inbox/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:page,thread_id:'000777',peer_id:'999888777666555',body:'Drain test inquiry',display_name:'Synthetic drain test'})});
  const monitor=await configureBrowserInbox(scope,{request_id:randomUUID(),environment_id:account.environment_id,expected_version:0,page_size:50,interval_seconds:10,raw_retention_hours:1});
  const launch=()=>spawn(process.execPath,['--import','tsx','apps/agent/src/main.ts'],{cwd:process.cwd(),env:{...process.env,KFF_ROOT:root,KFF_ENABLE_LIVE:'false',KFF_BROWSER_INBOX_FIXTURE_ORIGIN:fixture.origin},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  child=launch();let states=childMessages(child);
  await expect.poll(()=>states.includes('RUNNING'),{timeout:10000}).toBe(true);
  child.send({protocol:localSupervisionProtocol,command:'arbitrary-shell'});await controlBrowserInbox(scope,monitor.id,{request_id:randomUUID(),expected_version:1,action:'SCAN'});
  await expect.poll(()=>received,{timeout:45000}).toBeGreaterThan(0);
  const entries=JSON.parse(await readFile(path.join(root,'.kff/agent/journal.json'),'utf8')) as Record<string,JournalEntry>;const first=readClosureEvidence(path.join(root,'.kff'),entries[commandId]);expect(first).toBeTruthy();const original=digest(closureProof(first!));
  if(mode==='drain'){
   child.send({protocol:localSupervisionProtocol,command:'drain'});await expect.poll(()=>states.includes('DRAINING'),{timeout:5000}).toBe(true);
   const beforeClaims=claims,beforeReceived=received;await expect.poll(()=>received,{timeout:10000}).toBeGreaterThan(beforeReceived);expect(child.exitCode).toBeNull();expect(states).not.toContain('DRAINED');
   hold=false;await expect.poll(()=>child?.exitCode,{timeout:15000}).toBe(0);expect(states).toContain('DRAINED');expect(claims).toBe(beforeClaims);
  }else{
   child.disconnect();await expect.poll(()=>child?.exitCode,{timeout:15000}).toBe(0);
   const retained=JSON.parse(await readFile(path.join(root,'.kff/agent/journal.json'),'utf8')) as Record<string,JournalEntry>;
   expect(digest(closureProof(readClosureEvidence(path.join(root,'.kff'),retained[commandId])!))).toBe(original);
   const receivedBeforeRestart=received;hold=false;child=launch();states=childMessages(child);
   await expect.poll(()=>received,{timeout:15000}).toBeGreaterThan(receivedBeforeRestart);
   await expect.poll(async()=>JSON.parse(await readFile(path.join(root,'.kff/agent/journal.json'),'utf8'))[commandId].quiesced,{timeout:15000}).toBe(true);
   child.send({protocol:localSupervisionProtocol,command:'drain'});await expect.poll(()=>child?.exitCode,{timeout:15000}).toBe(0);expect(states).toContain('DRAINED');
  }
  const final=JSON.parse(await readFile(path.join(root,'.kff/agent/journal.json'),'utf8')) as Record<string,JournalEntry>;expect(final[commandId].quiesced).toBe(true);
  const proof=(await query("SELECT details->'proof' proof FROM kff.audit_events WHERE event_type='guardian.quiesced' AND object_id=$1",[commandId]))[0].proof;expect(digest(proof)).toBe(original);expect(digest(closureProof(readClosureEvidence(path.join(root,'.kff'),final[commandId])!))).toBe(original);
  expect((await query('SELECT count(*)::int AS n FROM kff.agent_commands WHERE agent_id=$1',[paired.agent.id]))[0].n).toBe(1);expect(errors).toEqual([]);
  await writeFile('.kff/checks/local-supervision-agent-'+mode+'.json',JSON.stringify({synthetic:true,real_platform:false,command_id:commandId,drained:true,original_proof_preserved:true,accepted_commands:1,mode,states},null,2));
 }finally{clearInterval(timer);await expect.poll(()=>busy).toBe(false);await killOwned(child);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fixture.close();}
},90000);

it('drains the actual Worker and closes its database pool through local IPC on Windows',async()=>{
 const child=spawn(process.execPath,['--import','tsx','apps/worker/src/main.ts'],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});const states=childMessages(child);
 try{await expect.poll(()=>states.includes('RUNNING'),{timeout:10000}).toBe(true);child.send({protocol:localSupervisionProtocol,command:'drain'});await expect.poll(()=>child.exitCode,{timeout:20000}).toBe(0);expect(states).toEqual(['RUNNING','DRAINING','DRAINED']);}finally{await killOwned(child);}
},30000);
