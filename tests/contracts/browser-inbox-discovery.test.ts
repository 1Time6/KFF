import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {browserInboxMonitorInput,browserInboxDiscoverySummary,browserInboxPage,browserInboxSkippedThread,browserInboxThreadTarget} from '../../packages/contracts/src/browser-inbox';
const target={thread_id:'00123',peer_id:'00987',display_name:'Sender'};
const summary={strategy:'RECENT_ACCEPTED',visible_threads:1,unparsed_rows:0,threads:[target],skipped:[],window_limited:false,empty_list:false};
function page(){return {monitor_id:randomUUID(),cursor:null,next_cursor:null,has_more:false,discovery:summary,batch:{schema_version:'kff.browser-inbox-batch.v1',login_account_id:'111',operating_identity_id:'111',observed_at:new Date().toISOString(),coverage:'VISIBLE_MESSAGES_ONLY',messages:[{message_id:'original.1',thread_id:target.thread_id,peer_id:target.peer_id,display_name:target.display_name,direction:'INBOUND',thread_kind:'UNVERIFIED',occurred_at:null,displayed_time:'昨天 11:59',has_attachment:false,source_url:'https://www.facebook.com/messages/e2ee/t/'+target.thread_id+'/',body:'Original text'}]}};}
it('requires an explicit bounded discovery mode separate from a fixed target',()=>{
 const input={request_id:randomUUID(),environment_id:randomUUID(),expected_version:0,discovery:{strategy:'RECENT_ACCEPTED',max_threads:3}};
 expect(browserInboxMonitorInput.parse(input).discovery?.max_threads).toBe(3);
 for(const change of [{target},{discovery:{strategy:'ALL_MESSAGES',max_threads:3}},{discovery:{strategy:'RECENT_ACCEPTED',max_threads:4}},{discovery:{strategy:'RECENT_ACCEPTED',max_threads:0}},{discovery:{strategy:'RECENT_ACCEPTED',max_threads:3,accept_requests:true}}])expect(browserInboxMonitorInput.safeParse({...input,...change}).success).toBe(false);
});
it('keeps distinct verified thread and peer identities and unknown time labels',()=>{
 expect(browserInboxPage.parse(page()).batch.messages[0]).toMatchObject({thread_id:'00123',peer_id:'00987',occurred_at:null,displayed_time:'昨天 11:59'});
 for(const change of [{peer_id:'444'},{display_name:'Another sender'},{thread_id:'222',source_url:'https://www.facebook.com/messages/e2ee/t/222/'},{thread_kind:'DIRECT'},{occurred_at:new Date().toISOString()}]){const p=page();Object.assign(p.batch.messages[0],change);expect(browserInboxPage.safeParse(p).success).toBe(false);}
});
it('requires observed incoming content for every claimed verified thread',()=>{
 const p=page();p.batch.messages[0].direction='OUTBOUND';expect(browserInboxPage.safeParse(p).success).toBe(false);
 expect(browserInboxPage.safeParse({...page(),discovery:{...summary,threads:[target,{...target,thread_id:'1234'}],visible_threads:2}}).success).toBe(false);
});
it('rejects duplicate thread claims and contradictory empty-list evidence',()=>{
 for(const change of [{threads:[target,target],visible_threads:2},{skipped:[{thread_id:target.thread_id,reason:'THREAD_NOT_ACCEPTED'}],visible_threads:2},{empty_list:true},{visible_threads:0}])expect(browserInboxDiscoverySummary.safeParse({...summary,...change}).success).toBe(false);
 const p=page();p.batch.messages=[];expect(browserInboxPage.parse({...p,discovery:{...summary,visible_threads:0,threads:[],empty_list:true}}).batch.messages).toHaveLength(0);
});
it('does not infer a continuation or complete history from a visible directory window',()=>{
 const p=page();expect(browserInboxPage.safeParse({...p,cursor:'invented'}).success).toBe(false);expect(browserInboxPage.safeParse({...p,next_cursor:'invented',has_more:true}).success).toBe(false);expect(browserInboxPage.safeParse({...p,batch:{...p.batch,coverage:'COMPLETE_HISTORY'}}).success).toBe(false);
});
it('preserves bounded failure phases without accepting error text or changing legacy skip reports',()=>{
 const base={...summary,visible_threads:2,window_limited:true},skipped={thread_id:'00456',reason:'THREAD_WINDOW_UNAVAILABLE'};
 expect(browserInboxDiscoverySummary.parse({...base,skipped:[skipped]}).skipped[0]).not.toHaveProperty('failure');
 const failure={stage:'facebook-inbox-peer-menu',code:'TIMEOUT'};
 expect(browserInboxDiscoverySummary.parse({...base,skipped:[{...skipped,failure}]}).skipped[0].failure).toEqual(failure);
 for(const change of [{stage:'message body or raw selector'},{code:'arbitrary platform error'},{message:'raw private text'}])expect(browserInboxDiscoverySummary.safeParse({...base,skipped:[{...skipped,failure:{...failure,...change}}]}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...base,skipped:[{...skipped,reason:'MESSAGE_LIMIT',failure}]}).success).toBe(false);
});
// A conversation read without an input box is a real read that keeps its reason, and a missing
// input box, an unusable one and a foreign one stay separate codes. None of them is reported as a
// Facebook business conclusion.
it('keeps a read-only conversation readable and separates unusable from foreign input boxes',()=>{
 const readOnly={...target,read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'};
 expect(browserInboxThreadTarget.parse(readOnly)).toMatchObject({read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'});
 expect(browserInboxPage.safeParse({...page(),discovery:{...summary,threads:[readOnly]}}).success).toBe(true);
 // A read flag without any composer or read-only evidence is refused.
 expect(browserInboxThreadTarget.safeParse({...target,read:true,message_count:1}).success).toBe(false);
 // A read-only reason on a conversation that was not read is refused.
 expect(browserInboxThreadTarget.safeParse({...target,read:false,read_only_reason:'THREAD_COMPOSER_ABSENT'}).success).toBe(false);
 for(const reason of ['THREAD_INPUT_UNUSABLE','THREAD_INPUT_FOREIGN','THREAD_COMPOSER_UNVERIFIED'])
  expect(browserInboxSkippedThread.safeParse({thread_id:'00456',reason}).success).toBe(true);
 expect(browserInboxSkippedThread.safeParse({thread_id:'00456',reason:'THREAD_BLOCKED_BY_PLATFORM'}).success).toBe(false);
});
// The window must report readable, skipped and failed conversations separately, and the read count
// must agree with the conversations it claims to have read.
it('requires self-consistent read, skipped and failed conversation counts',()=>{
 const readOnly={...target,read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'},skip={thread_id:'00456',reason:'THREAD_COMPOSER_ABSENT' as const};
 const coverage={threads_attempted:2,threads_read:1,threads_skipped:1,threads_failed:1};
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[skip],coverage}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[skip],coverage:{...coverage,threads_failed:0}}).success).toBe(true);
 // A skipped conversation is never counted as read, and a read-only observation must belong to a
 // conversation the window actually read.
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[target],coverage:{...coverage,threads_failed:0}}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[{...target,composer_surface:undefined}],skipped:[skip],observed:[skip]}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[{...skip,thread_id:'00999'}],observed:[skip],coverage:{...coverage,threads_failed:0}}).success).toBe(false);
});
