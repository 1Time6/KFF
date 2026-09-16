import {it,expect} from 'vitest';
import {publicationAge} from '../../packages/contracts/src/publication-time';
import {collectionRecordSchema} from '../../packages/contracts/src/collection';
import {discoveryConfig} from '../../packages/contracts/src/acquisition';
import {fieldText} from '../../packages/core/src/acquisition';
const at='2026-09-13T08:00:00Z';
const displayed=(value:string)=>({kind:'DISPLAYED_TIME' as const,value});
it('distinguishes an explicitly zoned timestamp from a timezone-free calendar interval',()=>{
  expect(publicationAge({kind:'VALUE',value:'2026-09-13T07:00:00Z'},at,7)).toBe('RECENT');
  expect(publicationAge(displayed('2026年7月30日周四15:19'),at,7)).toBe('OLDER');
  expect(publicationAge(displayed('2026年9月12日周六15:19'),at,7)).toBe('RECENT');
  expect(publicationAge(displayed('2026年9月6日周日08:00'),at,7)).toBe('UNKNOWN');
  expect(publicationAge({kind:'VALUE',value:'2026-09-06T08:00:00Z'},at,7)).toBe('RECENT');
  expect(publicationAge({kind:'VALUE',value:'2026-09-06T07:59:59Z'},at,7)).toBe('OLDER');
});
it('retains uncertain, missing, contradictory and impossible labels for review',()=>{
  for(const value of ['6周','昨天','2026年2月30日12:00','2026年7月30日周五15:19','2026年9月13日25:00','2026年9月13日15:99','2026年10月1日12:00','2026-09-12 10:00'])expect(publicationAge(displayed(value),at,7)).toBe('UNKNOWN');
  expect(publicationAge({kind:'NOT_RETURNED'},at,7)).toBe('UNKNOWN');
  expect(publicationAge({kind:'VALUE',value:'2026-02-30T00:00:00Z'},at,7)).toBe('UNKNOWN');
  expect(publicationAge({kind:'VALUE',value:'2026-09-13T08:00:01Z'},at,7)).toBe('UNKNOWN');
  expect(publicationAge(displayed('2024年2月29日周四00:00'),at,7)).toBe('OLDER');
});
it('does not invent a time filter or contact timestamp for existing monitors',()=>{
  expect(publicationAge(displayed('2026年7月30日15:19'),at)).toBe('UNRESTRICTED');
  expect(fieldText({created_time:displayed('2026年9月12日15:19')},'created_time')).toBe('');
  const config={platform:'facebook',strategy:'COMMENTS',provider:'LOCAL_FIXTURE',keywords:['help'],target:'',processing_basis:'Contract-only owned fixture'};
  expect(discoveryConfig.parse(config).max_age_days).toBeUndefined();
  expect(discoveryConfig.parse({...config,max_age_days:7}).max_age_days).toBe(7);
  for(const value of [0,1.5,366,null])expect(discoveryConfig.safeParse({...config,max_age_days:value}).success).toBe(false);
});
it('permits only a bounded original source-time label, without an invented timestamp or timezone',()=>{
  const record={source_object_id:'comment:1',source_url:'https://www.facebook.com/',fields:{created_time:displayed('2026年7月30日周四15:19')}};
  expect(collectionRecordSchema.parse(record).fields.created_time).toEqual(record.fields.created_time);
  for(const fields of [{author_id:displayed('123')},{created_time:{...displayed('today'),timezone:'Asia/Shanghai'}},{created_time:displayed('x'.repeat(161))}])expect(collectionRecordSchema.safeParse({...record,fields}).success).toBe(false);
});
