import {z} from 'zod';
import {Temporal} from '@js-temporal/polyfill';

const date=z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value=>{try{Temporal.PlainDate.from(value,{overflow:'reject'});return true;}catch{return false;}},'日期无效');
const timezone=z.string().min(1).max(80).refine(value=>{try{return !/^[+-]/.test(value)&&new Temporal.ZonedDateTime(0n,value).timeZoneId.length>0;}catch{return false;}},'需要有效的 IANA 时区');
export const scheduleRuleSchema=z.object({
  timezone,kind:z.enum(['ONCE','DAILY','WEEKLY']),start_date:date,end_date:date,time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekdays:z.array(z.number().int().min(1).max(7)).max(7).refine(values=>new Set(values).size===values.length).transform(values=>[...values].sort()),
  repeated_time:z.enum(['EARLIER','LATER','BOTH','SKIP']),missing_time:z.enum(['SKIP','SHIFT_FORWARD']),
  missed_policy:z.enum(['SKIP','DEFER_LATEST','CATCH_UP']),catch_up_limit:z.number().int().min(1).max(10),
  spacing_seconds:z.number().int().min(60).max(86400),late_tolerance_seconds:z.number().int().min(0).max(3600),
  maximum_lateness_seconds:z.number().int().min(60).max(604800),
}).strict().superRefine((rule,context)=>{
  try{const days=Temporal.PlainDate.from(rule.start_date).until(Temporal.PlainDate.from(rule.end_date)).days;
    if(days<0||days>365)context.addIssue({code:'custom',message:'计划日期需有序且最多 366 天'});
    if(rule.kind==='ONCE'&&days!==0)context.addIssue({code:'custom',message:'一次计划的起止日期需相同'});
  }catch{context.addIssue({code:'custom',message:'计划日期无效'});}
  if((rule.kind==='WEEKLY')!==(rule.weekdays.length>0))context.addIssue({code:'custom',message:'每周计划必须选择星期，其他计划不能携带星期'});
  if(rule.maximum_lateness_seconds<rule.late_tolerance_seconds)context.addIssue({code:'custom',message:'最迟准备期限不能小于正常延迟容限'});
});
export type ScheduleRule=z.infer<typeof scheduleRuleSchema>;
export const schedulePreviewInput=z.object({request_id:z.uuid(),rule:scheduleRuleSchema,evaluate_at:z.iso.datetime().optional()}).strict();
export const scheduleSaveInput=z.object({request_id:z.uuid(),preview_id:z.uuid(),preview_hash:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().trim().min(1).max(120)}).strict();
export const scheduleRevisionInput=scheduleSaveInput.extend({expected_version:z.number().int().positive(),reason:z.string().trim().min(5).max(300)});
export const scheduleControlInput=z.object({request_id:z.uuid(),expected_version:z.number().int().positive(),action:z.enum(['PAUSE','RESUME','STOP']),reason:z.string().trim().min(5).max(300)}).strict();
