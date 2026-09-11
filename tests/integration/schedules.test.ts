import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed,localIds} from '../../scripts/seed';
import {query,scoped,closePool} from '../../packages/database/src/index';
import type {Scope} from '../../packages/contracts/src/index';
import {scheduleRuleSchema,type ScheduleRule} from '../../packages/contracts/src/schedule';
import {previewSchedule,saveSchedule,scheduleDetail,scheduleList,controlSchedule,prepareScheduleOne} from '../../packages/core/src/schedules';
import {digest} from '../../packages/core/src/index';
const scope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
const date=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const rule=(changes:Partial<ScheduleRule>={})=>scheduleRuleSchema.parse({timezone:'UTC',kind:'DAILY',start_date:date(-3),end_date:date(1),time:'00:00',weekdays:[],repeated_time:'EARLIER',missing_time:'SKIP',missed_policy:'CATCH_UP',catch_up_limit:2,spacing_seconds:60,late_tolerance_seconds:0,maximum_lateness_seconds:604800,...changes});
async function create(changes:Partial<ScheduleRule>={}){const preview=await previewSchedule(scope,{request_id:randomUUID(),rule:rule(changes)});const input={request_id:randomUUID(),preview_id:preview.id,preview_hash:preview.definition_hash,title:'Synthetic calendar'};return {preview,input,schedule:await saveSchedule(scope,input)};}
async function resume(id:string,version:number){return controlSchedule(scope,id,{request_id:randomUUID(),expected_version:version,action:'RESUME',reason:'Prepare owned synthetic calendar points'});}
const children:ChildProcess[]=[];
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await done;}
async function crash(boundary:'before'|'after'){
  const child=spawn(process.execPath,['--import','tsx','tests/helpers/schedule-process.ts',boundary],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Schedule barrier missing')),10000);child.on('message',message=>{if(message&&typeof message==='object'&&'barrier' in message&&message.barrier===boundary){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Schedule child exited: '+code));});});await kill(child);
}
beforeAll(async()=>{const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated database required');await migrate();await seed();});
beforeEach(async()=>{await query('TRUNCATE kff.schedules CASCADE');});
afterAll(async()=>{for(const child of children)await kill(child);await query('TRUNCATE kff.schedules CASCADE');await closePool();});
it('saves one paused immutable version from a preview under concurrent duplicate requests',async()=>{
  const {schedule,input}=await create();const saved=await Promise.all(Array.from({length:4},()=>saveSchedule(scope,input)));expect(new Set(saved.map(row=>row.id))).toEqual(new Set([schedule.id]));expect(schedule.state).toBe('PAUSED');expect(schedule.next_due_at).not.toBeNull();
  await expect(saveSchedule(scope,{...input,title:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});await expect(query("UPDATE kff.schedule_versions SET definition='{}' WHERE schedule_id=$1",[schedule.id])).rejects.toThrow('IMMUTABLE_SCHEDULE_DEFINITION');
});
it('atomically prepares a bounded backlog, spaces release times and never refills the same backlog',async()=>{
  const {schedule}=await create();const before=(await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n;await resume(schedule.id,schedule.version);
  const results=await Promise.all(Array.from({length:5},()=>prepareScheduleOne()));expect(results.filter(Boolean)).toHaveLength(1);const detail=await scheduleDetail(scope,schedule.id);expect(detail.counts).toEqual({total:4,ready:2,skipped:2,canceled:0});expect(detail.schedule.next_slot_index).toBe(4);expect(detail.schedule.state).toBe('ACTIVE');
  const ready=detail.occurrences.filter(row=>row.state==='READY_FOR_TASK').sort((a,b)=>a.slot_index-b.slot_index);expect(new Date(ready[1].available_at).getTime()-new Date(ready[0].available_at).getTime()).toBe(60000);expect(await prepareScheduleOne()).toBeNull();expect((await query('SELECT count(*)::int AS n FROM kff.tasks'))[0].n).toBe(before);
});
it('rolls back both prepared points and cursor when the actual process dies before COMMIT',async()=>{
  const {schedule}=await create();await resume(schedule.id,schedule.version);await crash('before');const empty=await scheduleDetail(scope,schedule.id);expect(empty.counts.total).toBe(0);expect(empty.schedule.next_slot_index).toBe(0);expect(await prepareScheduleOne()).toMatchObject({prepared:4});
});
it('retains committed points and cursor when the actual process dies before acknowledging COMMIT',async()=>{
  const {schedule}=await create();await resume(schedule.id,schedule.version);await crash('after');expect((await scheduleDetail(scope,schedule.id)).counts.total).toBe(4);expect(await prepareScheduleOne()).toBeNull();
});
it('pauses without discarding history, resumes with saved misfire policy and permanently stops future preparation',async()=>{
  const {schedule}=await create({missed_policy:'DEFER_LATEST'});const active=await resume(schedule.id,schedule.version);const paused=await controlSchedule(scope,schedule.id,{request_id:randomUUID(),expected_version:active.version,action:'PAUSE',reason:'Synthetic pause before prepare'});expect(await prepareScheduleOne()).toBeNull();await resume(schedule.id,paused.version);await prepareScheduleOne();
  const detail=await scheduleDetail(scope,schedule.id);expect(detail.counts).toEqual({total:4,ready:1,skipped:3,canceled:0});const input={request_id:randomUUID(),expected_version:detail.schedule.version,action:'STOP' as const,reason:'Terminate all future preparation'};const stopped=await controlSchedule(scope,schedule.id,input);expect(stopped.state).toBe('STOPPED');expect(await controlSchedule(scope,schedule.id,input)).toMatchObject({id:schedule.id,state:'STOPPED'});
  expect((await scheduleDetail(scope,schedule.id)).counts).toEqual({total:4,ready:0,skipped:3,canceled:1});await expect(resume(schedule.id,stopped.version)).rejects.toMatchObject({code:'INVALID_TRANSITION'});await expect(query("UPDATE kff.schedule_occurrences SET state='READY_FOR_TASK' WHERE schedule_id=$1 AND state='CANCELED'",[schedule.id])).rejects.toThrow('IMMUTABLE_SCHEDULE_OCCURRENCE');
});
it('requires pause and a new preview for rule revisions and preserves old calendar and point evidence',async()=>{
  const {schedule,preview}=await create();await resume(schedule.id,schedule.version);await prepareScheduleOne();const next=await previewSchedule(scope,{request_id:randomUUID(),rule:rule({time:'01:00'})});const current=(await scheduleDetail(scope,schedule.id)).schedule;
  const input={request_id:randomUUID(),preview_id:next.id,preview_hash:next.definition_hash,title:'Revised synthetic calendar',expected_version:current.version,reason:'Reviewed new local calendar time'};await expect(saveSchedule(scope,input,schedule.id)).rejects.toMatchObject({code:'SCHEDULE_NOT_PAUSED'});
  const paused=await controlSchedule(scope,schedule.id,{request_id:randomUUID(),expected_version:current.version,action:'PAUSE',reason:'Pause before calendar revision'});await saveSchedule(scope,{...input,request_id:randomUUID(),expected_version:paused.version},schedule.id);const detail=await scheduleDetail(scope,schedule.id);expect(detail.versions).toHaveLength(2);expect(detail.versions[1].definition_hash).toBe(preview.definition_hash);expect(detail.counts.canceled).toBe(2);expect(detail.schedule.next_slot_index).toBe(0);expect(detail.schedule.state).toBe('PAUSED');
});
it('refuses wrong brand, viewer writes, request reassignment and stale control versions',async()=>{
  const {schedule,input}=await create();const second=await create();await expect(saveSchedule(scope,{...input,request_id:second.input.request_id})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const other={...scope,brand_id:randomUUID()};await expect(scheduleDetail(other,schedule.id)).rejects.toMatchObject({code:'NOT_FOUND'});expect(await scheduleList(other)).toEqual([]);expect(await scoped(other,async client=>(await client.query('SELECT * FROM kff.schedule_versions')).rows)).toEqual([]);
  await expect(previewSchedule({...scope,role:'viewer'},{request_id:randomUUID(),rule:rule()})).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await expect(saveSchedule({...scope,role:'viewer'},input)).rejects.toMatchObject({code:'FORBIDDEN_SCOPE'});await resume(schedule.id,schedule.version);await expect(resume(schedule.id,schedule.version)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
});
it('rejects expired or changed preview evidence and cannot associate a version with another schedule',async()=>{
  const {preview,schedule}=await create();await expect(saveSchedule(scope,{request_id:randomUUID(),preview_id:preview.id,preview_hash:'a'.repeat(64),title:'Changed evidence'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const expired=randomUUID();await query("INSERT INTO kff.schedule_previews(id,organization_id,brand_id,request_id,request_hash,definition,definition_hash,evaluated_at,created_by,created_at,expires_at) SELECT $1,organization_id,brand_id,$2,request_hash,definition,definition_hash,evaluated_at,created_by,now()-interval '2 days',now()-interval '1 day' FROM kff.schedule_previews WHERE id=$3",[expired,randomUUID(),preview.id]);await expect(saveSchedule(scope,{request_id:randomUUID(),preview_id:expired,preview_hash:preview.definition_hash,title:'Expired preview'})).rejects.toMatchObject({code:'PREVIEW_EXPIRED'});
  const second=await create();await expect(query('UPDATE kff.schedules SET current_version_id=$1 WHERE id=$2',[second.schedule.current_version_id,schedule.id])).rejects.toMatchObject({code:'23503'});
});
it('records skipped gap decisions, finishes finite calendars and never presents them as execution',async()=>{
  const {schedule}=await create({kind:'ONCE',timezone:'America/New_York',start_date:'2024-03-10',end_date:'2024-03-10',time:'02:30'});await resume(schedule.id,schedule.version);await prepareScheduleOne();const detail=await scheduleDetail(scope,schedule.id);expect(detail.schedule).toMatchObject({state:'COMPLETED',next_due_at:null});expect(detail.occurrences[0]).toMatchObject({state:'SKIPPED',reason:'DST_GAP_SKIPPED',scheduled_at:null});expect(detail.execution_authorized).toBe(false);
});
it('blocks resume and pauses preparation if the saved timezone data is no longer current',async()=>{
  const {schedule,preview}=await create();const definition={...preview.definition,timezone_data:'synthetic-old-tzdata'};const versionId=randomUUID();
  const previewId=randomUUID();await query('INSERT INTO kff.schedule_previews(id,organization_id,brand_id,request_id,request_hash,definition,definition_hash,evaluated_at,created_by) SELECT $1,organization_id,brand_id,$2,request_hash,$3,$4,evaluated_at,created_by FROM kff.schedule_previews WHERE id=$5',[previewId,randomUUID(),definition,digest(definition),preview.id]);
  await query('INSERT INTO kff.schedule_versions(id,organization_id,brand_id,schedule_id,preview_id,request_id,request_hash,title,version_number,definition,definition_hash,created_by) SELECT $1,organization_id,brand_id,schedule_id,$2,$3,request_hash,title,2,$4,$5,created_by FROM kff.schedule_versions WHERE id=$6',[versionId,previewId,randomUUID(),definition,digest(definition),schedule.current_version_id]);
  await query('UPDATE kff.schedules SET current_version_id=$1 WHERE id=$2',[versionId,schedule.id]);await expect(resume(schedule.id,schedule.version)).rejects.toMatchObject({code:'TIMEZONE_DATA_CHANGED'});
  await query("UPDATE kff.schedules SET state='ACTIVE' WHERE id=$1",[schedule.id]);expect(await prepareScheduleOne()).toMatchObject({id:schedule.id,blocked:true});expect((await scheduleDetail(scope,schedule.id)).schedule).toMatchObject({state:'PAUSED',pause_reason:'RULES_CHANGED'});expect((await scheduleDetail(scope,schedule.id)).counts.total).toBe(0);
});
