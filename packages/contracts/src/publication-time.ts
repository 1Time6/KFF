import type {CollectionRecord} from './collection';

export type PublicationAge='UNRESTRICTED'|'RECENT'|'OLDER'|'UNKNOWN';
/** Date labels without a timezone describe an interval, never an exact UTC timestamp. */
export function publicationAge(field:CollectionRecord['fields']['created_time'],observedAt:string,maxAgeDays?:number):PublicationAge {
  if(maxAgeDays===undefined)return 'UNRESTRICTED';
  const observed=Date.parse(observedAt),cutoff=observed-maxAgeDays*86400000;
  if(!Number.isFinite(observed)||!Number.isInteger(maxAgeDays)||maxAgeDays<1||maxAgeDays>365)return 'UNKNOWN';
  let earliest:number,latest:number;
  if(field?.kind==='VALUE'&&typeof field.value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(field.value)){
    earliest=latest=Date.parse(field.value);
    if(!Number.isFinite(earliest)||new Date(earliest).toISOString().slice(0,19)!==field.value.slice(0,19))return 'UNKNOWN';
  }else if(field?.kind==='DISPLAYED_TIME'){
    const match=/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:周([一二三四五六日天]))?\s*(\d{1,2}):(\d{2})$/.exec(field.value);
    if(!match)return 'UNKNOWN';
    const [,y,m,d,weekday,h,min]=match,year=Number(y),month=Number(m),day=Number(d),hour=Number(h),minute=Number(min);
    const nominal=Date.UTC(year,month-1,day,hour,minute),calendar=new Date(nominal);
    if(year<100||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||weekday&&calendar.getUTCDay()!==('日一二三四五六'.indexOf(weekday==='天'?'日':weekday)))return 'UNKNOWN';
    // Civil offsets span UTC-12 to UTC+14; retain minute precision and the unknown zone.
    earliest=nominal-14*3600000;latest=nominal+12*3600000+59999;
  }else return 'UNKNOWN';
  if(!Number.isFinite(earliest)||!Number.isFinite(latest)||earliest>observed)return 'UNKNOWN';
  if(latest<cutoff)return 'OLDER';
  // Only past instants are possible for content already observed on the source page.
  return earliest>=cutoff?'RECENT':'UNKNOWN';
}
