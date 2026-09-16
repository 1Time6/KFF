import{execFileSync}from'node:child_process';
import{readFileSync,writeFileSync,existsSync,mkdirSync,unlinkSync,copyFileSync}from'node:fs';
import path from'node:path';
import{setTimeout as delay}from'node:timers/promises';
import{z}from'zod';
import{query,closePool,projectRoot}from'@kff/database';
import{digest,requireCondition}from'@kff/core';
import{taskSnapshotSchema}from'@kff/contracts';
import{AdsPowerClient}from'../packages/adapters/src/browser-profile';
import{browserProviderEnvironment}from'../apps/agent/src/browser-provider-configuration';
import{loadAgentConfiguration}from'../apps/agent/src/configuration';
import{saveClosure,closureFile}from'../apps/agent/src/guardian-protocol';

// Operator-invoked recovery of an observed, still-running AdsPower startup after a read-only guardian died.
// No task is executed and no successful platform result is manufactured. The original Agent uploads only closure.
const [commandId,endpoint,pid,observationFile]=z.tuple([z.string().uuid(),z.string().url(),z.coerce.number().int().positive(),z.string().optional()]).parse(process.argv.slice(2));
const url=new URL(endpoint);requireCondition(url.protocol==='ws:'&&url.hostname==='127.0.0.1'&&/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)&&!url.username&&!url.password&&!url.search&&!url.hash,'INVALID_INPUT','Expected exact local provider instance');
const dead=(processId:number)=>{try{process.kill(processId,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}};
try{
 const {runtimeDir,agentConfig}=loadAgentConfiguration(projectRoot);
 const journal=JSON.parse(readFileSync(path.join(runtimeDir,'agent/journal.json'),'utf8'))[commandId];
 requireCondition(journal?.phase==='claimed'&&journal.guardian_pid&&journal.guardian_nonce&&!journal.report&&!journal.quiesced&&dead(journal.guardian_pid),'GUARDIAN_UNCONFIRMED','Only a dead guardian before opening a context can be recovered here');
 const row=(await query("SELECT c.id,c.action_id,c.agent_id,c.state,c.claimed_at,c.quiesced_at,t.snapshot,t.snapshot_hash,at.submitted_at FROM kff.agent_commands c JOIN kff.actions a ON a.id=c.action_id JOIN kff.tasks t ON t.id=a.task_id JOIN kff.action_attempts at ON at.id=c.attempt_id WHERE c.id=$1 AND c.agent_id=$2",[commandId,agentConfig.agent_id]))[0];
 requireCondition(row?.state==='EXPIRED'&&!row.quiesced_at&&!row.submitted_at&&row.action_id===journal.action_id&&digest(row.snapshot)===row.snapshot_hash,'FORBIDDEN_SCOPE','Original command is not an expired unsubmitted read');
 const snapshot=taskSnapshotSchema.parse(row.snapshot),environment=snapshot.browser_environment,profile=environment?.configuration.provider_profile_id;
 requireCondition(snapshot.capability_key==='facebook.inbox.read.browser'&&snapshot.inbox&&!snapshot.message&&!snapshot.collection&&!snapshot.is_synthetic&&environment?.configuration.driver==='adspower'&&profile&&environment.agent_id===agentConfig.agent_id&&environment.organization_id===agentConfig.organization_id&&environment.brand_id===agentConfig.brand_id,'FORBIDDEN_SCOPE','Only the original paired real inbox read can be recovered');
 const folder=path.join(runtimeDir,'browser-environments','adspower-'+profile),lockFile=path.join(folder,'owner.lock'),lockBytes=readFileSync(lockFile),owner=JSON.parse(lockBytes.toString()),binding=JSON.parse(readFileSync(path.join(folder,'binding.json'),'utf8'));
 requireCondition(owner.pid===journal.guardian_pid&&owner.environment_id===environment.environment_id&&owner.agent_id===agentConfig.agent_id&&binding.account_id===snapshot.account_id&&binding.environment_id===environment.environment_id&&binding.login_account_id===environment.configuration.login_account_id&&binding.operating_identity_id===environment.configuration.operating_identity_id,'PROFILE_IDENTITY_MISMATCH','Original local owner or binding changed');
 const evidenceFile=path.join(runtimeDir,'agent/recoveries',commandId+'.json');requireCondition(!existsSync(evidenceFile)&&!existsSync(closureFile(runtimeDir,commandId)),'IDEMPOTENCY_CONFLICT','Inspect the previous recovery; never overwrite it');
 const provider=new AdsPowerClient(browserProviderEnvironment(projectRoot));const before=await provider.status(profile);
 let browser,operatorObservation;
 if(before.status==='Active'){
  requireCondition(before.ws?.puppeteer===endpoint&&!observationFile,'GUARDIAN_UNCONFIRMED','Expected original active browser was replaced');
  browser=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',path.join(projectRoot,'scripts/inspect-adspower-process.ps1'),'-ProfileId',profile,'-BrowserProcessId',String(pid),'-Port',url.port],{encoding:'utf8',windowsHide:true}));
 }else{
  requireCondition(observationFile&&dead(pid),'GUARDIAN_UNCONFIRMED','Already closed startup needs a reviewed record of its previously observed active instance');
  operatorObservation=JSON.parse(readFileSync(observationFile,'utf8'));
  requireCondition(operatorObservation.kind==='OPERATOR_REVIEW_OF_TOOL_OUTPUT'&&operatorObservation.command_id===commandId&&operatorObservation.profile_id===profile&&operatorObservation.endpoint===endpoint&&operatorObservation.browser?.pid===pid&&operatorObservation.browser?.profile_id===profile&&operatorObservation.basis?.length>=80,'GUARDIAN_UNCONFIRMED','Reviewed observation does not identify this exact abandoned startup');
  browser=operatorObservation.browser;
 }
 const created=Date.parse(browser.created_at),claimed=new Date(row.claimed_at).getTime();requireCondition(created>=claimed&&created<=claimed+120000,'GUARDIAN_UNCONFIRMED','Browser startup does not match the original command interval');
 mkdirSync(path.dirname(evidenceFile),{recursive:true});const evidence={kind:'OPERATOR_OBSERVED_ADSPOWER_READ_RECOVERY',command_id:commandId,action_id:row.action_id,guardian_pid:journal.guardian_pid,original_guardian_dead:true,lock_sha256:digest(lockBytes.toString()),endpoint,profile_id:profile,browser,operator_observation:operatorObservation,started_at:new Date().toISOString(),status:before.status==='Active'?'STOP_REQUESTED':'VERIFY_PREVIOUSLY_OBSERVED_CLOSURE',platform_result_verified:false};
 writeFileSync(evidenceFile,JSON.stringify(evidence,null,2),{flag:'wx'});copyFileSync(lockFile,evidenceFile+'.owner-lock-backup');
 if(before.status==='Active')await provider.stop(profile,endpoint);
 else{await delay(2000);requireCondition((await provider.status(profile)).status==='Inactive','GUARDIAN_UNCONFIRMED','A replacement or delayed startup appeared');}
 requireCondition((await provider.status(profile)).status==='Inactive'&&dead(pid)&&dead(journal.guardian_pid)&&readFileSync(lockFile).equals(lockBytes),'GUARDIAN_UNCONFIRMED','Physical browser closure or original owner could not be confirmed');
 const closedAt=new Date().toISOString();Object.assign(evidence,{status:'PHYSICAL_CLOSURE_VERIFIED',closed_at:closedAt,browser_pid_dead:true,provider_after:'Inactive'});writeFileSync(evidenceFile,JSON.stringify(evidence,null,2));
 saveClosure(runtimeDir,{protocol_version:'kff.guardian-closure.v1',command_id:commandId,action_id:row.action_id,nonce:journal.guardian_nonce,closed_at:closedAt,context_closed:true,result:{outcome:'CANCELED',error_code:'PROVIDER_STARTUP_RECOVERED',diagnostic:{step:'operator-provider-shutdown',executor_version:'kff-local-read-recovery-v1'}}});
 unlinkSync(lockFile);
 console.log(JSON.stringify({command_id:commandId,status:evidence.status,proof_origin:'observed_operator_recovery',platform_result_verified:false,evidence_file:evidenceFile}));
}finally{await closePool();}
