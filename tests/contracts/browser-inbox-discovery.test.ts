import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {browserInboxMonitorInput,browserInboxDiscoverySummary,browserInboxPage,browserInboxSkippedThread,browserInboxThreadTarget,browserInboxDiscoveryCoverage,browserInboxDiscoveryCoverageFrom} from '../../packages/contracts/src/browser-inbox';
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
// must agree with the conversations it claims to have read. The three categories are disjoint: a
// conversation the window tried and failed is a failure, only a conversation the window never
// reached is a skip. The old check read every skipped entry as a skip *and* as a failure, which is
// what let the counts disagree with the window they described.
it('requires self-consistent read, skipped and failed conversation counts',()=>{
 const readOnly={...target,read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT'},skip={thread_id:'00456',reason:'THREAD_COMPOSER_ABSENT' as const};
 const window={...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[skip]};
 // One conversation read and one attempted failure: the window tried two, and one of them failed.
 const consistent={threads_attempted:2,threads_read:1,threads_skipped:0,threads_failed:1};
 expect(browserInboxDiscoverySummary.parse({...window,coverage:consistent}).coverage).toEqual(consistent);
 // A conversation held back by the message limit is an unread skip that was never tried.
 const neverReached={thread_id:'00789',reason:'MESSAGE_LIMIT' as const};
 expect(browserInboxDiscoverySummary.parse({...window,skipped:[neverReached],coverage:{threads_attempted:1,threads_read:1,threads_skipped:1,threads_failed:0}}).coverage).toEqual({threads_attempted:1,threads_read:1,threads_skipped:1,threads_failed:0});
 // The overlapping count is still refused: one read plus one failure cannot report three tried.
 expect(browserInboxDiscoverySummary.safeParse({...window,coverage:{...consistent,threads_attempted:3}}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...window,coverage:{...consistent,threads_failed:0}}).success).toBe(false);
 // A conversation that is not in the skip list cannot be claimed as skipped.
 expect(browserInboxDiscoverySummary.safeParse({...window,coverage:{...consistent,threads_skipped:1}}).success).toBe(false);
 // A skipped conversation is never counted as read, and a read-only observation must belong to a
 // conversation the window actually read.
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[target],coverage:consistent}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[{...target,composer_surface:undefined}],skipped:[skip],observed:[skip]}).success).toBe(false);
 expect(browserInboxDiscoverySummary.safeParse({...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[{...skip,thread_id:'00999'}],observed:[skip],coverage:consistent}).success).toBe(false);
});
// The single derivation the adapter and the controller must share. A conversation the window
// genuinely tried and failed is counted once, as a failure; only a conversation that was never
// attempted (the message limit) counts as skipped. Summing the two overlapping sets on top of a
// "reached" base is the defect: it made attempted exceed the window and refused the whole page,
// so conversations that had been read successfully were thrown away with it.
it('derives one self-consistent coverage from read, failed and never-attempted conversations',()=>{
 const read=[target];
 const failed=[{thread_id:'00456',reason:'THREAD_COMPOSER_ABSENT' as const,failure:{stage:'facebook-inbox-directory-composer' as const,code:'THREAD_COMPOSER_ABSENT' as const}}];
 const limited=[{thread_id:'00789',reason:'MESSAGE_LIMIT' as const}];
 // One conversation read and one that failed: the window tried two, and one of them failed.
 expect(browserInboxDiscoveryCoverageFrom(read,failed)).toEqual({threads_attempted:2,threads_read:1,threads_skipped:0,threads_failed:1});
 // A conversation held back by the message limit is an unread skip and was never tried, so it does
 // not add to `attempted`; the failed conversation is a failure and not also a skip.
 expect(browserInboxDiscoveryCoverageFrom(read,limited)).toEqual({threads_attempted:1,threads_read:1,threads_skipped:1,threads_failed:0});
 expect(browserInboxDiscoveryCoverageFrom(read,[...failed,...limited])).toEqual({threads_attempted:2,threads_read:1,threads_skipped:1,threads_failed:1});
 // All failed, all read and an explicitly empty list stay distinct and consistent.
 expect(browserInboxDiscoveryCoverageFrom([],failed)).toEqual({threads_attempted:1,threads_read:0,threads_skipped:0,threads_failed:1});
 expect(browserInboxDiscoveryCoverageFrom([],limited)).toEqual({threads_attempted:0,threads_read:0,threads_skipped:1,threads_failed:0});
 expect(browserInboxDiscoveryCoverageFrom([],[])).toEqual({threads_attempted:0,threads_read:0,threads_skipped:0,threads_failed:0});
 for(const [threads,skipped] of [[read,failed],[read,limited],[read,[...failed,...limited]],[[],failed],[[],limited],[read,[]],[[],[]]] as const){
  const derived=browserInboxDiscoveryCoverageFrom(threads,skipped);
  // The identity the adapter must satisfy, and the same object the contract parses.
  expect(derived.threads_attempted).toBe(derived.threads_read+derived.threads_failed);
  // Every conversation the window did not read is accounted for exactly once, as a skip or a failure.
  expect(derived.threads_skipped+derived.threads_failed).toBe(skipped.length);
  expect(browserInboxDiscoveryCoverageFrom(threads,skipped)).toEqual(browserInboxDiscoveryCoverage.parse(derived));
 }
});
// The adapter's own counterexample, driven through the real summary and page contracts: a window
// that read one conversation and failed another must be accepted, and the overlapping count the
// adapter used to emit must stay refused.
it('accepts a partly failed window and still refuses the overlapping count',()=>{
 const readOnly={...target,read:true,message_count:1,read_only_reason:'THREAD_COMPOSER_ABSENT' as const};
 const skip={thread_id:'00456',reason:'THREAD_COMPOSER_ABSENT' as const,failure:{stage:'facebook-inbox-directory-composer' as const,code:'THREAD_COMPOSER_ABSENT' as const}};
 const partlyFailed={...summary,visible_threads:2,window_limited:true,threads:[readOnly],skipped:[skip]};
 expect(browserInboxDiscoverySummary.parse({...partlyFailed,coverage:browserInboxDiscoveryCoverageFrom([readOnly],[skip])}).coverage).toEqual({threads_attempted:2,threads_read:1,threads_skipped:0,threads_failed:1});
 // The count the adapter used to emit for this window: the failure was added to `attempted` on
 // top of a base that already contained it, so two conversations were reported as three.
 expect(browserInboxDiscoverySummary.safeParse({...partlyFailed,coverage:{threads_attempted:3,threads_read:1,threads_skipped:1,threads_failed:1}}).success).toBe(false);
 // A window whose only conversation failed reports one attempted conversation, not two.
 expect(browserInboxDiscoverySummary.safeParse({...partlyFailed,coverage:{threads_attempted:1,threads_read:1,threads_skipped:0,threads_failed:1}}).success).toBe(false);
 // A conversation held back by the message limit is an unread skip, never a successful read.
 const limitedWindow={...partlyFailed,skipped:[{thread_id:'00789',reason:'MESSAGE_LIMIT' as const}]};
 expect(browserInboxDiscoverySummary.parse({...limitedWindow,coverage:browserInboxDiscoveryCoverageFrom([readOnly],limitedWindow.skipped)}).coverage).toEqual({threads_attempted:1,threads_read:1,threads_skipped:1,threads_failed:0});
});
