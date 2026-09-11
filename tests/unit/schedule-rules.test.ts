import {it,expect} from 'vitest';
import {scheduleRuleSchema} from '../../packages/contracts/src/schedule';
import {compileSchedule,evaluateSchedule} from '../../packages/core/src/schedule-rules';
const rule=(changes:Record<string,unknown>={})=>scheduleRuleSchema.parse({timezone:'America/New_York',kind:'ONCE',start_date:'2024-11-03',end_date:'2024-11-03',time:'01:30',weekdays:[],repeated_time:'BOTH',missing_time:'SKIP',missed_policy:'SKIP',catch_up_limit:2,spacing_seconds:60,late_tolerance_seconds:30,maximum_lateness_seconds:604800,...changes});
it('uses two distinct UTC points for repeated local time and explicit earlier/later/skip choices',()=>{
  expect(compileSchedule(rule()).slots.map(slot=>slot.scheduled_at)).toEqual(['2024-11-03T05:30:00.000Z','2024-11-03T06:30:00.000Z']);
  expect(compileSchedule(rule({repeated_time:'EARLIER'})).slots[0].offset).toBe('-04:00');expect(compileSchedule(rule({repeated_time:'LATER'})).slots[0].offset).toBe('-05:00');
  expect(compileSchedule(rule({repeated_time:'SKIP'})).slots[0]).toMatchObject({scheduled_at:null,decision:'DST_REPEAT_SKIPPED'});
});
it('records missing time instead of inventing a UTC instant, or explicitly shifts by the transition gap',()=>{
  const input=rule({start_date:'2024-03-10',end_date:'2024-03-10',time:'02:30'});expect(compileSchedule(input).slots[0]).toMatchObject({scheduled_at:null,decision:'DST_GAP_SKIPPED'});
  expect(compileSchedule({...input,missing_time:'SHIFT_FORWARD'}).slots[0]).toMatchObject({scheduled_at:'2024-03-10T07:30:00.000Z',resolved_local_time:'2024-03-10T03:30:00',decision:'DST_GAP_SHIFTED'});
});
it('handles a half-hour transition and an entirely skipped date without assuming a one-hour DST change',()=>{
  const half=compileSchedule(rule({timezone:'Australia/Lord_Howe',start_date:'2024-10-06',end_date:'2024-10-06',time:'02:15',missing_time:'SHIFT_FORWARD'}));expect(half.slots[0].resolved_local_time).toBe('2024-10-06T02:45:00');
  const date=compileSchedule(rule({timezone:'Pacific/Apia',start_date:'2011-12-30',end_date:'2011-12-30',time:'12:00'}));expect(date.slots[0].scheduled_at).toBeNull();
});
it('uses calendar days and ISO weekdays across leap day and UTC date boundaries',()=>{
  const value=compileSchedule(rule({timezone:'Asia/Shanghai',kind:'DAILY',start_date:'2024-02-28',end_date:'2024-03-01',time:'00:30'}));expect(value.slots.map(slot=>slot.scheduled_at)).toEqual(['2024-02-27T16:30:00.000Z','2024-02-28T16:30:00.000Z','2024-02-29T16:30:00.000Z']);
  expect(compileSchedule(rule({timezone:'UTC',kind:'WEEKLY',start_date:'2024-01-01',end_date:'2024-01-14',weekdays:[7,1]})).slots.map(slot=>slot.local_time.slice(0,10))).toEqual(['2024-01-01','2024-01-07','2024-01-08','2024-01-14']);
});
const daily=(missed_policy:'SKIP'|'DEFER_LATEST'|'CATCH_UP')=>compileSchedule(rule({timezone:'UTC',kind:'DAILY',start_date:'2024-01-01',end_date:'2024-01-05',time:'12:00',missed_policy}));
it('skips missed points but accepts a point within its explicit tolerance',()=>{
  const result=evaluateSchedule(daily('SKIP'),0,'2024-01-03T12:00:15Z');expect(result.decisions.map(row=>row.reason)).toEqual(['MISSED_SKIP','MISSED_SKIP','ON_TIME']);expect(result.next_due_at).toBe('2024-01-04T12:00:00.000Z');
});
it('defers only the latest missed point and permanently coalesces the older points',()=>{
  const definition=daily('DEFER_LATEST');const result=evaluateSchedule(definition,0,'2024-01-04T13:00:00Z');expect(result.decisions.map(row=>row.reason)).toEqual(['MISSED_COALESCED','MISSED_COALESCED','MISSED_COALESCED','DEFERRED_LATEST']);expect(evaluateSchedule(definition,result.next_index,'2024-01-04T13:01:00Z').decisions).toEqual([]);
});
it('limits one backlog recovery, spaces chosen points and does not refill the cap on another cycle',()=>{
  const definition=daily('CATCH_UP');const result=evaluateSchedule(definition,0,'2024-01-04T13:00:00Z');expect(result.decisions.map(row=>row.reason)).toEqual(['CATCH_UP','CATCH_UP','CATCH_UP_LIMIT','CATCH_UP_LIMIT']);expect(result.decisions.filter(row=>row.available_at).map(row=>row.available_at)).toEqual(['2024-01-04T13:00:00.000Z','2024-01-04T13:01:00.000Z']);
  expect(evaluateSchedule(definition,result.next_index,'2024-01-04T14:00:00Z',result.last_release_at).decisions).toEqual([]);
});
it('does not prepare stale points and respects previously reserved release spacing',()=>{
  expect(evaluateSchedule(daily('CATCH_UP'),0,'2024-02-01T00:00:00Z').decisions.every(row=>row.reason==='TOO_LATE')).toBe(true);
  expect(evaluateSchedule(daily('CATCH_UP'),4,'2024-01-05T12:00:00Z','2024-01-05T12:00:00Z').decisions[0].available_at).toBe('2024-01-05T12:01:00.000Z');
});
it('does not reserve a release slot for a point rejected by its latest allowed time',()=>{
  const definition=compileSchedule(rule({timezone:'Pacific/Apia',kind:'DAILY',start_date:'2011-12-30',end_date:'2011-12-31',time:'12:00',missing_time:'SHIFT_FORWARD',missed_policy:'CATCH_UP',late_tolerance_seconds:0,maximum_lateness_seconds:60}));
  const at=new Date(new Date(definition.slots[0].scheduled_at!).getTime()+5000).toISOString();const previous=new Date(new Date(at).getTime()-30000).toISOString();const result=evaluateSchedule(definition,0,at,previous);
  expect(result.decisions.map(row=>row.reason)).toEqual(['CATCH_UP','TOO_LATE']);expect(result.last_release_at).toBe(result.decisions[0].available_at);
});
