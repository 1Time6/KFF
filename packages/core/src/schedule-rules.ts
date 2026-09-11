import {Temporal} from '@js-temporal/polyfill';
import {scheduleRuleSchema,type ScheduleRule} from '../../contracts/src/schedule';

export interface ScheduleSlot {key:string;index:number;local_time:string;resolved_local_time:string|null;scheduled_at:string|null;sort_at:string;offset:string|null;decision:'NORMAL'|'DST_EARLIER'|'DST_LATER'|'DST_GAP_SHIFTED'|'DST_GAP_SKIPPED'|'DST_REPEAT_SKIPPED'}
export interface ScheduleDefinition {schema_version:'kff.schedule.v1';engine_version:'calendar-v1';timezone_data:string;rule:ScheduleRule;slots:ScheduleSlot[];execution_authorized:false}
export interface ScheduleDecision {slot:ScheduleSlot;state:'READY_FOR_TASK'|'SKIPPED';reason:'ON_TIME'|'DEFERRED_LATEST'|'CATCH_UP'|'MISSED_SKIP'|'MISSED_COALESCED'|'CATCH_UP_LIMIT'|'TOO_LATE'|'DST_GAP_SKIPPED'|'DST_REPEAT_SKIPPED';available_at:string|null}
export const timezoneDataVersion=()=>`polyfill:0.5.1;icu:${process.versions.icu??'unknown'};tz:${process.versions.tz??'unknown'}`;
const instant=(value:Temporal.ZonedDateTime)=>new Date(value.epochMilliseconds).toISOString();
export function compileSchedule(input:ScheduleRule):ScheduleDefinition {
  const rule=scheduleRuleSchema.parse(input);const slots:ScheduleSlot[]=[];const end=Temporal.PlainDate.from(rule.end_date);
  for(let date=Temporal.PlainDate.from(rule.start_date);Temporal.PlainDate.compare(date,end)<=0;date=date.add({days:1})){
    if(rule.kind==='WEEKLY'&&!rule.weekdays.includes(date.dayOfWeek))continue;
    const local=date.toPlainDateTime(rule.time);const early=local.toZonedDateTime(rule.timezone,{disambiguation:'earlier'});const late=local.toZonedDateTime(rule.timezone,{disambiguation:'later'});
    const add=(value:Temporal.ZonedDateTime|null,decision:ScheduleSlot['decision'],sort=late)=>slots.push({key:local.toString()+'/'+decision,index:0,local_time:local.toString(),resolved_local_time:value?.toPlainDateTime().toString()??null,scheduled_at:value?instant(value):null,sort_at:instant(value??sort),offset:value?.offset??null,decision});
    if(early.epochNanoseconds===late.epochNanoseconds)add(early,'NORMAL');
    else if(!early.toPlainDateTime().equals(local)||!late.toPlainDateTime().equals(local)){
      if(rule.missing_time==='SKIP')add(null,'DST_GAP_SKIPPED');else add(late,'DST_GAP_SHIFTED');
    }else if(rule.repeated_time==='SKIP')add(null,'DST_REPEAT_SKIPPED');
    else{if(rule.repeated_time==='EARLIER'||rule.repeated_time==='BOTH')add(early,'DST_EARLIER');if(rule.repeated_time==='LATER'||rule.repeated_time==='BOTH')add(late,'DST_LATER');}
  }
  slots.sort((a,b)=>a.sort_at.localeCompare(b.sort_at)||a.key.localeCompare(b.key));slots.forEach((slot,index)=>{slot.index=index;});
  return {schema_version:'kff.schedule.v1',engine_version:'calendar-v1',timezone_data:timezoneDataVersion(),rule,slots,execution_authorized:false};
}
export function evaluateSchedule(definition:ScheduleDefinition,nextIndex:number,at:string,previousRelease:string|null=null) {
  if(!Number.isInteger(nextIndex)||nextIndex<0||nextIndex>definition.slots.length)throw new Error('Invalid schedule cursor');
  const now=Temporal.Instant.from(at).epochMilliseconds;const rule=definition.rule;
  const due=definition.slots.slice(nextIndex).filter(slot=>new Date(slot.sort_at).getTime()<=now);
  const missed=due.filter(slot=>slot.scheduled_at&&now-new Date(slot.scheduled_at).getTime()>rule.late_tolerance_seconds*1000&&now-new Date(slot.scheduled_at).getTime()<=rule.maximum_lateness_seconds*1000);
  const chosen=new Set((rule.missed_policy==='DEFER_LATEST'?missed.slice(-1):rule.missed_policy==='CATCH_UP'?missed.slice(0,rule.catch_up_limit):[]).map(slot=>slot.index));
  let release=previousRelease?Temporal.Instant.from(previousRelease).epochMilliseconds:NaN;
  const decisions:ScheduleDecision[]=due.map(slot=>{
    let reason:ScheduleDecision['reason'];let accepted=false;
    if(!slot.scheduled_at)reason=slot.decision==='DST_REPEAT_SKIPPED'?'DST_REPEAT_SKIPPED':'DST_GAP_SKIPPED';
    else{const lag=now-new Date(slot.scheduled_at).getTime();
      if(lag>rule.maximum_lateness_seconds*1000)reason='TOO_LATE';
      else if(lag<=rule.late_tolerance_seconds*1000){reason='ON_TIME';accepted=true;}
      else if(chosen.has(slot.index)){reason=rule.missed_policy==='DEFER_LATEST'?'DEFERRED_LATEST':'CATCH_UP';accepted=true;}
      else reason=rule.missed_policy==='DEFER_LATEST'?'MISSED_COALESCED':rule.missed_policy==='CATCH_UP'?'CATCH_UP_LIMIT':'MISSED_SKIP';
    }
    if(accepted){const candidate=Math.max(now,Number.isFinite(release)?release+rule.spacing_seconds*1000:now);
      if(candidate-new Date(slot.scheduled_at!).getTime()>rule.maximum_lateness_seconds*1000){reason='TOO_LATE';accepted=false;}else release=candidate;
    }
    return {slot,state:accepted?'READY_FOR_TASK':'SKIPPED',reason,available_at:accepted?new Date(release).toISOString():null};
  });
  const index=nextIndex+decisions.length;return {decisions,next_index:index,next_due_at:definition.slots[index]?.sort_at??null,last_release_at:Number.isFinite(release)?new Date(release).toISOString():null};
}
