import {it,expect} from 'vitest';
import {scheduleRuleSchema,scheduleControlInput,scheduleSaveInput} from '../../packages/contracts/src/schedule';
const valid={timezone:'Asia/Shanghai',kind:'DAILY',start_date:'2024-01-01',end_date:'2024-01-02',time:'09:00',weekdays:[],repeated_time:'EARLIER',missing_time:'SKIP',missed_policy:'SKIP',catch_up_limit:2,spacing_seconds:60,late_tolerance_seconds:30,maximum_lateness_seconds:3600};
it('requires valid bounded dates, IANA zones, explicit DST choices and finite catch-up policy',()=>{
  expect(scheduleRuleSchema.safeParse(valid).success).toBe(true);
  for(const change of [{timezone:'+08:00'},{timezone:'Mars/Olympus'},{start_date:'2024-02-30'},{end_date:'2023-12-31'},{end_date:'2027-01-01'},{kind:'ONCE'},{weekdays:[1]},{kind:'WEEKLY',weekdays:[]},{time:'24:00'},{catch_up_limit:0},{catch_up_limit:11},{spacing_seconds:0},{maximum_lateness_seconds:10},{repeated_time:undefined},{execute:true}])expect(scheduleRuleSchema.safeParse({...valid,...change}).success).toBe(false);
});
it('does not accept client-supplied occurrence payloads, invented controls or stale zero versions',()=>{
  const id='11111111-1111-4111-8111-111111111111';expect(scheduleSaveInput.safeParse({request_id:id,preview_id:id,preview_hash:'a'.repeat(64),title:'Plan',slots:[]}).success).toBe(false);
  expect(scheduleControlInput.safeParse({request_id:id,expected_version:0,action:'RESUME',reason:'Explicit reason'}).success).toBe(false);expect(scheduleControlInput.safeParse({request_id:id,expected_version:1,action:'EXECUTE',reason:'Explicit reason'}).success).toBe(false);
});
