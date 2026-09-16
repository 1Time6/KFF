import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {monitorInput} from '../../packages/contracts/src/acquisition';
import {continuationSource} from '../../packages/core/src/acquisition-continuation';
import {publicReplyEligibility} from '../../packages/core/src/acquisition-eligibility';
import {scoreAcquisitionText} from '../../packages/core/src/acquisition-scoring';
const config=monitorInput.parse({request_id:randomUUID(),title:'Continuation contract',account_id:randomUUID(),discovery:{platform:'facebook',provider:'LOCAL_BROWSER',strategy:'KEYWORD',target:'',browser:{environment_id:randomUUID(),template:'facebook-search-dom-v1'},keywords:['八字'],processing_basis:'Isolated contract verification only',max_age_days:7},interval_minutes:30,max_records:10,max_pages:1,page_size:10,retention_days:7,comment_continuation:{allowed_source_types:['REEL'],max_sources_per_scan:1,max_sources_total:3,source_lifetime_hours:24,comment_order:'VISIBLE_WINDOW'}});
const now='2026-09-15T00:00:00.000Z';
const row={source_object_id:'facebook:reel:123',source_url:'https://www.facebook.com/reel/123/',fields:{message:{kind:'VALUE' as const,value:'八字咨询'},created_time:{kind:'DISPLAYED_TIME' as const,value:'2026年9月13日12:00'}}};
it('requires bounded real search/page configuration and rejects recursive continuation',()=>{
  expect(monitorInput.safeParse({...config,discovery:{...config.discovery,max_age_days:undefined}}).success).toBe(false);
  expect(monitorInput.safeParse({...config,discovery:{...config.discovery,strategy:'COMMENTS',target:row.source_url,browser:{...config.discovery.browser,template:'facebook-comments-dom-v1'}}}).success).toBe(false);
  expect(monitorInput.safeParse({...config,comment_continuation:{...config.comment_continuation,max_sources_per_scan:4,max_sources_total:1}}).success).toBe(false);
});
it('only selects matching recent public sources with consistent IDs and no tracking URLs',()=>{
  expect(continuationSource(config,row,now)).toBe(row.source_url);
  for(const bad of [{...row,source_object_id:'facebook:reel:999'},{...row,source_url:row.source_url+'?track=x'},{...row,source_url:'https://facebook.example/reel/123/'},{...row,fields:{...row.fields,created_time:{kind:'DISPLAYED_TIME' as const,value:'刚刚'}}},{...row,fields:{...row.fields,created_time:{kind:'DISPLAYED_TIME' as const,value:'2025年9月13日12:00'}}}])expect(continuationSource(config,bad,now)).toBeNull();
});
it('recognizes the observed 查8字 alias, keeps exclusions and separates seller service invitations',()=>{
  expect(scoreAcquisitionText('查8字',config.discovery)).toMatchObject({matched:['八字'],score:50});
  expect(scoreAcquisitionText('查８字',config.discovery).score).toBe(50);
  expect(scoreAcquisitionText('查8字',{keywords:['八字'],exclusions:['8字']}).score).toBe(0);
  const seller='For enquiry on Fengshui, as well as Bazi Reading, Baby Naming services, do drop me a WhatsApp text at [public contact].';
  expect(scoreAcquisitionText(seller,{keywords:['bazi reading'],exclusions:[]}).score).toBe(0);
  expect(scoreAcquisitionText('I need Bazi Reading services, how can I contact you?',{keywords:['bazi reading'],exclusions:[]}).score).toBe(75);
});
it('explains missing/conflicting identity, expiry and opt-out without author guessing or Messenger qualification',()=>{
  const lead={...row,state:'QUALIFIED',score:50,expires_at:'2026-09-16T00:00:00.000Z',source_object_id:'facebook:comment:999',source_url:row.source_url+'?comment_id=999',fields:{...row.fields,author_id:{kind:'VALUE' as const,value:'12345'}},config:{...config,discovery:{...config.discovery,strategy:'COMMENTS' as const,target:row.source_url,browser:{environment_id:config.discovery.browser!.environment_id,template:'facebook-comments-dom-v1' as const}}}};
  expect(publicReplyEligibility(lead,now).can_prepare).toBe(true);
  expect(publicReplyEligibility({...lead,fields:{...lead.fields,author_id:{kind:'NOT_RETURNED'}}},now).can_prepare).toBe(false);
  expect(publicReplyEligibility({...lead,source_url:row.source_url+'?comment_id=111'},now).can_prepare).toBe(false);
  expect(publicReplyEligibility({...lead,author_suppressed:true},now).can_prepare).toBe(false);
  expect(publicReplyEligibility({...lead,expires_at:now},now).can_prepare).toBe(false);
});
