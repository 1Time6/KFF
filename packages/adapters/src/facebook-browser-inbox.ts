import type { Page } from '@playwright/test';
import type { ActionReport, AgentCommand } from '@kff/contracts';
import { AppError, digest, requireCondition } from '@kff/core';
import { browserInboxPage, browserInboxThreadFailure, type BrowserInboxTask, type BrowserInboxDiscoverySummary } from '../../contracts/src/browser-inbox';
import { inspectFacebookInboxDom, isFacebookInboxExpansion } from './facebook-inbox-dom';
import { inspectFacebookProfileIdentity } from './facebook-browser-identity';
import { openManagedBrowser } from './browser-profile';
import { assertTemplateSnapshot } from './templates';
import type { ExecutorHooks } from './fixture';
import { inspectFacebookInboxComposerDom, inspectFacebookInboxDirectoryDom, inspectFacebookInboxHeaderDom } from './facebook-inbox-directory-dom';

/**
 * Only these failures are local to one conversation. Anything else - account identity, login,
 * Messenger setup, retention, lease, Guardian - must stop this environment instead of being
 * averaged away as a skipped conversation.
 */
const LOCAL_THREAD_CODES=new Set(['THREAD_IDENTITY_UNVERIFIED','ACCOUNT_MISMATCH','THREAD_NOT_ACCEPTED','THREAD_COMPOSER_ABSENT','THREAD_COMPOSER_UNVERIFIED','THREAD_INPUT_UNUSABLE','THREAD_INPUT_FOREIGN','INBOX_SOURCE_MISMATCH']);

type ThreadSkip=BrowserInboxDiscoverySummary['skipped'][number];
type ComposerSurface=NonNullable<ThreadSkip['composer_surface']>;
/** The only reasons that may keep a conversation readable through the read-only path. */
type ReadOnlyReason='THREAD_COMPOSER_ABSENT'|'THREAD_COMPOSER_UNVERIFIED'|'THREAD_INPUT_UNUSABLE'|'THREAD_INPUT_FOREIGN';
type ComposerProbe={composer:null|{value:string};absent:boolean;candidate_count:number;surface:Omit<ComposerSurface,'stage'|'candidate_count'>};

/**
 * Resolve the thread input box from its own semantic label. The label is what authorises the
 * accepted-chat path; it is not a precondition for reading at all, because a verified thread
 * can also be read read-only (see `readFacebookInboxThread`).
 * Every failure keeps its fact-only observation, including the zero-input case, and one
 * untrusted input box never becomes a Facebook business conclusion.
 */
async function resolveThreadComposer(page:Page,target:{display_name:string;peer_id:string},identityId:string,guard:()=>Promise<void>,viaPlaceholder:boolean,deadlineMs=15000){
  const probe={display_name:target.display_name,allow_other_name:viaPlaceholder,operating_identity_id:identityId};
  let observed:ComposerProbe=await page.evaluate(inspectFacebookInboxComposerDom,probe);
  for(const started=Date.now();!observed.composer&&Date.now()-started<deadlineMs;){
    await guard();await page.waitForTimeout(500);
    observed=await page.evaluate(inspectFacebookInboxComposerDom,probe);
  }
  // The fact-only observation is always returned. It used to be dropped once a composer was accepted,
  // which meant a successfully read conversation carried no evidence of the input box it was read with.
  const surface:ComposerSurface={stage:'facebook-inbox-directory-composer',candidate_count:observed.candidate_count,...observed.surface};
  const composer=observed.composer;
  // Field observations stay separate from conclusions: no input box is not proof the chat was
  // never accepted, an unusable box is a page fact, and a box naming somebody else is only a
  // label conflict. Each keeps its own code so one local anomaly cannot masquerade as another.
  if(!composer)return {composer:null,surface,reason:(observed.absent?'THREAD_COMPOSER_ABSENT':'THREAD_COMPOSER_UNVERIFIED') as ReadOnlyReason};
  if(!observed.surface.reachable)return {composer:null,surface,reason:'THREAD_INPUT_UNUSABLE' as ReadOnlyReason};
  if(!observed.surface.hit_target)return {composer:null,surface,reason:'THREAD_INPUT_FOREIGN' as ReadOnlyReason};
  return {composer,surface,reason:null};
}

/**
 * A verified thread may be readable without an accepted-chat input box: the header already
 * proved the numeric peer identity, so the read-only path still requires the same account
 * identity, the same unique message log, and the same per-message sender profile check.
 * It never widens acceptance; it only stops "cannot reply here" from being treated as
 * "cannot read here". Nothing about ownership is assumed from the URL alone.
 */
async function resolveThreadReadOnly(page:Page,target:{display_name:string;peer_id:string},identityId:string,guard:()=>Promise<void>){
  requireCondition(Boolean(target.peer_id)&&target.peer_id!==identityId,'THREAD_IDENTITY_UNVERIFIED','只读读取前没有已核实的对方身份');
  await guard();
  requireCondition(await page.getByRole('log').count()===1,'INBOX_SOURCE_MISMATCH','只读读取前消息区域不唯一');
  const label=await page.getByRole('log').first().getAttribute('aria-label');
  requireCondition(label==='与'+target.display_name+'的对话中的消息','INBOX_SOURCE_MISMATCH','只读读取前消息区域标题与已核实姓名不符');
}

async function assertMessengerReady(page:Page) {
  const url=new URL(page.url());
  requireCondition(url.origin==='https://www.facebook.com','INBOX_SOURCE_MISMATCH','收件页面离开了指定平台');
  requireCondition(!/checkpoint|challenge|two_step_verification/.test(url.pathname),'LOGIN_CHALLENGE','平台要求人工登录验证');
  requireCondition(!url.pathname.startsWith('/login')&&!await page.locator('input[type="password"]:visible').count(),'LOGIN_REQUIRED','浏览器需要人工登录');
  requireCondition(!await page.getByRole('dialog').getByRole('heading',{name:/创建 PIN 码|输入 PIN 码|恢复聊天记录|Create a PIN|Enter your PIN/}).isVisible(),'MESSENGER_SETUP_REQUIRED','Messenger 正在要求本人完成加密聊天设置');
}

/**
 * Bounded accepted thread: text and photo-presence markers; no image download, request
 * acceptance or send. `demand` decides which evidence authorises this exact read:
 * `COMPOSER` requires the thread input box, `READ_ONLY` is the fallback for a thread whose
 * identity was already verified from the unique numeric header while no input box was
 * observed. Both modes keep the same account identity, unique log and per-message sender
 * profile checks.
 */
export async function readFacebookInboxThread(page: Page, request: Pick<BrowserInboxTask,'binding'|'template'|'cursor'|'limit'>, controlled: () => void, stage: (value:string)=>void = () => {}, navigate = true, demand: 'COMPOSER'|'READ_ONLY' = 'COMPOSER') {
  const target=request.binding.target;
  requireCondition(target && request.template==='facebook-inbox-dom-v1' && request.cursor===null, 'INBOX_SOURCE_MISMATCH', '真实收件需要固定会话');
  // A fixed target must name the peer explicitly. The directory placeholder is not a peer, and
  // reading it read-only without the directory row would lose the name-vs-numeric-ID check.
  requireCondition(target.display_name!=='Facebook 用户','THREAD_IDENTITY_UNVERIFIED','指定会话没有可核实的对方姓名');
  const source='https://www.facebook.com/messages/e2ee/t/'+target.thread_id+'/';
  const guard=async()=>{
    await assertMessengerReady(page); const url=new URL(page.url());
    requireCondition(url.origin==='https://www.facebook.com' && url.pathname.replace(/\/$/,'')===new URL(source).pathname.replace(/\/$/,'') && !url.search && !url.hash, 'INBOX_SOURCE_MISMATCH', '当前页面不是指定的加密会话');
    requireCondition(!(await page.locator('input[type="password"]:visible').count()), 'LOGIN_REQUIRED', '浏览器需要人工登录');
    requireCondition(await page.getByRole('log').count()===1, 'INBOX_SOURCE_MISMATCH', '消息区域不唯一');
    controlled();
  };
  controlled(); stage('facebook-inbox-load'); if(navigate)await page.goto(source,{waitUntil:'domcontentloaded',timeout:30000}); await assertMessengerReady(page);
  // `target.display_name` is the name already verified against the numeric header profile,
  // never the directory placeholder that may still be showing.
  const log=page.getByRole('log',{name:'与'+target.display_name+'的对话中的消息',exact:true});
  try { await log.waitFor({state:'visible',timeout:30000}); } catch(error) { await assertMessengerReady(page); throw error; }
  await log.getByRole('article').first().waitFor({state:'visible',timeout:15000});
  await guard();
  if(demand==='COMPOSER'){
    // The inner read uses the same semantic rule as the caller: a blind exact-label wait
    // here would reject any label the caller legitimately accepted.
    stage('facebook-inbox-composer-surface');
    const composer=await page.evaluate(inspectFacebookInboxComposerDom,{display_name:target.display_name,allow_other_name:false,operating_identity_id:target.peer_id});
    // Zero input boxes stays a fact; a foreign label stays a label conflict.
    if(!composer.composer)requireCondition(composer.absent,'INBOX_SOURCE_MISMATCH','会话输入框标签与指定对象不符');
    requireCondition(composer.composer,'THREAD_COMPOSER_ABSENT','内层读取没有找到可核验的会话输入框');
    const label=composer.composer.value,compact=label.replace(/\s+/g,'').toLowerCase(),peer=target.display_name.replace(/\s+/g,'').toLowerCase();
    requireCondition(compact==='发消息给'+peer,'INBOX_SOURCE_MISMATCH','会话输入框标签与指定对象不符');
  }
  else stage('facebook-inbox-read-only');
  stage('facebook-inbox-wait-content'); let data=await page.evaluate(inspectFacebookInboxDom), stable=false;
  // Our recent outgoing rows can appear before the earlier inbound row is hydrated.
  // Wait within the same bound for complete content and a verifiable sender.
  for(let pass=0;pass<20&&(data.invalid||!data.rows.some(row=>row.direction==='INBOUND'))&&data.rows.length<=request.limit;pass++){await guard();await page.waitForTimeout(500);data=await page.evaluate(inspectFacebookInboxDom);}
  stage('facebook-inbox-parse');
  const verifiedSenders=new Set<string>();
  // Opening a message can render earlier rows. Verify newly rendered senders in at most three passes.
  for(let pass=0;pass<3;pass++){
  requireCondition(data.rows.some(row=>row.direction==='INBOUND') && !data.invalid && data.rows.length<=request.limit, 'INBOX_SOURCE_MISMATCH', '可见消息缺少可核对发送者的来信、明确文字字段或超过读取上限');
  requireCondition(new Set(data.rows.map(row=>row.message_id)).size===data.rows.length, 'INBOX_SOURCE_MISMATCH', '页面消息标识重复');
  for (const row of data.rows) {
    const senderAnchorId=row.sender_anchor_message_id??row.message_id;
    if(row.direction==='OUTBOUND'||verifiedSenders.has(senderAnchorId))continue;
    stage('facebook-inbox-peer');
    controlled(); requireCondition(row.display_name===target.display_name,'ACCOUNT_MISMATCH','消息头像名称与指定发送者不符');
    const node=log.locator('[data-message-id="'+senderAnchorId+'"]');
    const avatar=node.locator('[role="button"][aria-haspopup="dialog"]');
    requireCondition(await avatar.count()===1,'INBOX_SOURCE_MISMATCH','发送者入口不唯一');
    // A new reply may scroll older incoming rows above the visible log; inspect each original avatar in view.
    await avatar.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
    // The composer can temporarily cover the avatar while a direct thread opens.
    // AdsPower may stall animation-frame waits, so poll the actual hit target with a bound.
    stage('facebook-inbox-peer-hit-target');let clickable=false;
    for(let pass=0;pass<30;pass++){
      await guard();await avatar.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
      clickable=await avatar.evaluate(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
      if(clickable)break;await page.waitForTimeout(500);
    }
    requireCondition(clickable,'INBOX_SOURCE_MISMATCH','发送者头像被遮挡或不可点击');
    stage('facebook-inbox-peer-menu');
    await avatar.click({force:true,timeout:10000});
    const profile=page.getByRole('menuitem',{name:'查看个人主页',exact:true});
    await profile.waitFor({state:'visible',timeout:10000});
    requireCondition(await profile.count()===1 && await profile.getAttribute('href')==='/'+target.peer_id+'/', 'ACCOUNT_MISMATCH', '消息发送者个人主页与指定 ID 不符');
    await page.keyboard.press('Escape'); await profile.waitFor({state:'hidden',timeout:10000});
    await guard();
    verifiedSenders.add(senderAnchorId);
  }
  stage('facebook-inbox-recheck');const next=await page.evaluate(inspectFacebookInboxDom);
  if(digest(next)===digest(data)){stable=true;break;}
  requireCondition(isFacebookInboxExpansion(data,next,request.limit),'INBOX_SOURCE_MISMATCH','核验期间已有消息发生变化或页面超出读取范围');
  data=next;
  }
  requireCondition(stable,'INBOX_SOURCE_MISMATCH','核验期间页面持续加载，未取得稳定消息列表');
  return data.rows.map(({sender_anchor_message_id,...row})=>{void sender_anchor_message_id;return {...row,thread_id:target.thread_id,peer_id:target.peer_id,thread_kind:'UNVERIFIED' as const,occurred_at:null,source_url:source};});
}

/** Every selected thread is resolved from visible UI and read with the same sender checks as a fixed thread. */
export async function readFacebookInboxDirectory(page:Page,request:Pick<BrowserInboxTask,'binding'|'template'|'cursor'|'limit'>,controlled:()=>void,stage:(value:string)=>void=()=>{}) {
  const config=request.binding.discovery;
  requireCondition(config?.strategy==='RECENT_ACCEPTED'&&!request.binding.target&&request.template==='facebook-inbox-dom-v1'&&request.cursor===null,'INBOX_SOURCE_MISMATCH','发现会话需要明确的已接受会话窗口');
  controlled();stage('facebook-inbox-directory-load');await page.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded',timeout:30000});
  await assertMessengerReady(page);
  try { await page.getByRole('navigation',{name:'对话列表',exact:true}).waitFor({state:'visible',timeout:20000}); } catch(error) { await assertMessengerReady(page);throw error; }
  const guard=async()=>{controlled();await assertMessengerReady(page);const u=new URL(page.url());requireCondition(/^\/messages\/(?:e2ee\/t\/[0-9]{1,128}\/)?$/.test(u.pathname)&&!u.search&&!u.hash,'INBOX_SOURCE_MISMATCH','当前页面不是聊天列表或其加密会话');};
  let directory=await page.evaluate(inspectFacebookInboxDirectoryDom);
  for(let pass=0;pass<10&&!directory.ready;pass++){await guard();await page.waitForTimeout(500);directory=await page.evaluate(inspectFacebookInboxDirectoryDom);}
  await guard();requireCondition(directory.ready,'INBOX_WINDOW_UNAVAILABLE','聊天列表未显示可核实会话或明确空状态');
  // An empty label must survive another render check; a loading shell is not an empty Inbox.
  if(directory.empty){await page.waitForTimeout(500);await guard();directory=await page.evaluate(inspectFacebookInboxDirectoryDom);requireCondition(directory.ready&&directory.empty,'INBOX_WINDOW_UNAVAILABLE','聊天列表仍在变化');}
  const selected=directory.rows.slice(0,config.max_threads),messages:Awaited<ReturnType<typeof readFacebookInboxThread>>=[];
  const discovery:BrowserInboxDiscoverySummary={strategy:'RECENT_ACCEPTED',visible_threads:directory.rows.length,unparsed_rows:directory.invalid,threads:[],skipped:[],observed:[],window_limited:directory.rows.length>selected.length||directory.invalid>0,empty_list:directory.empty};
  const skippedReason=(error:unknown):ThreadSkip['reason']=>{
    const code=error instanceof AppError?error.code:null;
    if(code==='THREAD_COMPOSER_ABSENT')return 'THREAD_COMPOSER_ABSENT';
    if(code==='THREAD_COMPOSER_UNVERIFIED')return 'THREAD_COMPOSER_UNVERIFIED';
    if(code==='THREAD_INPUT_UNUSABLE')return 'THREAD_INPUT_UNUSABLE';
    if(code==='THREAD_INPUT_FOREIGN')return 'THREAD_INPUT_FOREIGN';
    if(code==='THREAD_NOT_ACCEPTED')return 'THREAD_NOT_ACCEPTED';
    if(code==='THREAD_IDENTITY_UNVERIFIED'||code==='ACCOUNT_MISMATCH')return 'THREAD_IDENTITY_UNVERIFIED';
    return 'THREAD_WINDOW_UNAVAILABLE';
  };
  // Per-thread isolation: one conversation that cannot be read is recorded with its own
  // observation and the window continues with the next conversation. Only the caller's
  // run-safety gates (account identity, Guardian, closure) may stop the whole environment.
  let connectionStopped=false;
  for(const thread of selected){
    controlled();if(messages.length>=request.limit){discovery.skipped.push({thread_id:thread.thread_id,reason:'MESSAGE_LIMIT'});continue;}
    let threadStage='facebook-inbox-directory-thread',composerSurface:ComposerSurface|undefined=undefined;const threadStep=(value:string)=>{threadStage=value;stage(value);};
    try {
      threadStep('facebook-inbox-directory-thread');await page.goto('https://www.facebook.com/messages/e2ee/t/'+thread.thread_id+'/',{waitUntil:'domcontentloaded',timeout:30000});await assertMessengerReady(page);
      // A placeholder can disappear before this wait begins. The header parser,
      // not this readiness wait, must establish the numeric peer identity.
      const heading=thread.display_name==='Facebook 用户'?page.getByRole('main').getByRole('heading',{level:3}).first():page.getByRole('main').getByRole('heading',{name:thread.display_name,exact:true,level:3}).first();
      await heading.waitFor({state:'visible',timeout:15000});
      threadStep('facebook-inbox-directory-identity');
      let target=await page.evaluate(inspectFacebookInboxHeaderDom,thread);
      // Messenger can render the name/composer before hydrating the profile link.
      // Wait for the same exact identity evidence; never fall back to the name alone.
      for(let pass=0;pass<30&&!target;pass++){await guard();await page.waitForTimeout(500);target=await page.evaluate(inspectFacebookInboxHeaderDom,thread);}
      requireCondition(target&&target.peer_id!==request.binding.environment.configuration.operating_identity_id,'THREAD_IDENTITY_UNVERIFIED','会话标题没有唯一且一致的发送者主页');
      const verified:{thread_id:string;peer_id:string;display_name:string}=target;
      threadStep('facebook-inbox-directory-composer');
      const composer=await resolveThreadComposer(page,verified,request.binding.environment.configuration.operating_identity_id,guard,thread.display_name==='Facebook 用户');
      if(composer.surface)composerSurface=composer.surface;
      // The accepted-chat path needs a composer that names this peer. When no input box was
      // observed at all the conversation stays readable read-only, because the header already
      // proved the numeric peer identity and the name that goes with it. An unusable box, a box
      // that only repeats the directory placeholder, or a box naming somebody else is a page
      // state that cannot be reconciled with this thread, so it is left unread: the read-only
      // path never becomes a way around an unverifiable input box.
      const accepted=Boolean(composer.composer), absent=composer.surface?.label_kind==='ABSENT';
      const fallback:ReadOnlyReason=composer.reason??'THREAD_COMPOSER_ABSENT';
      if(!accepted){
        const reason:ReadOnlyReason=absent?'THREAD_COMPOSER_ABSENT':composer.surface!.placeholder?'THREAD_COMPOSER_UNVERIFIED':composer.surface!.reachable?'THREAD_INPUT_FOREIGN':'THREAD_INPUT_UNUSABLE';
        requireCondition(reason==='THREAD_COMPOSER_ABSENT',reason,'会话输入框不可用于本次读取，保留逐会话观测');
      }
      if(accepted)threadStep('facebook-inbox-composer-surface');
      else {threadStep('facebook-inbox-read-only');await resolveThreadReadOnly(page,verified,request.binding.environment.configuration.operating_identity_id,guard);}
      const read=await readFacebookInboxThread(page,{...request,limit:request.limit-messages.length,binding:{environment:request.binding.environment,account_version:request.binding.account_version,target:verified}},controlled,threadStep,false,accepted?'COMPOSER':'READ_ONLY');
      messages.push(...read);
      // A read conversation must carry its evidence: the accepted composer surface, or the reason it
      // was read without a usable composer. Reported without either, the window fails its own contract.
      const evidence=composerSurface??(accepted?undefined:({stage:'facebook-inbox-directory-composer',candidate_count:0,label_kind:'ABSENT' as const,label_length:0,placeholder:false,reachable:false,hit_target:false,role:'none' as const,contenteditable:false}));
      discovery.threads.push({...verified,read:true,message_count:read.length,...(accepted?{}:{read_only_reason:fallback}),composer_surface:evidence});
      // A read-only conversation keeps its reason on record so it can be reviewed and retried.
      if(!accepted)discovery.observed!.push({thread_id:thread.thread_id,reason:fallback,failure:browserInboxThreadFailure.parse({stage:'facebook-inbox-directory-composer',code:fallback}),composer_surface:evidence});
    } catch(error) {
      const code=error instanceof AppError?error.code:null;
      if(!LOCAL_THREAD_CODES.has(code??'')&&!(error instanceof Error&&error.name==='TimeoutError')){connectionStopped=true;throw error;}
      controlled();await assertMessengerReady(page);
      // The reason must not overstate the evidence: a missing input box is recorded as missing,
      // an unusable one as unusable, and only page-verified non-acceptance is reported as not
      // accepted. One local anomaly never justifies a guessed Facebook business reason.
      const reason=skippedReason(error);
      discovery.skipped.push({thread_id:thread.thread_id,reason,failure:browserInboxThreadFailure.parse({stage:threadStage,code:code??'TIMEOUT'}),...(reason!=='MESSAGE_LIMIT'&&composerSurface?{composer_surface:composerSurface}:{})});
    }
  }
  controlled();discovery.window_limited ||= discovery.skipped.length>0;
  // Read, skipped and failed conversations are reported separately so a skipped one is never
  // counted as a successful read and never displaces a later retry. `threads_skipped` counts every
  // recorded local anomaly; `threads_failed` is the subset that failed with a read failure code.
  // A conversation kept back by the message limit was never read and is reported as not reached.
  const failed=discovery.skipped.filter(skip=>skip.reason!=='MESSAGE_LIMIT');
  const reachable=[...discovery.threads,...failed];
  discovery.window_limited ||= connectionStopped||reachable.length<selected.length;
  discovery.coverage={threads_attempted:reachable.length,threads_read:discovery.threads.length,threads_skipped:failed.length,threads_failed:discovery.skipped.filter(skip=>skip.failure).length};
  // The task fails closed when nothing readable was found, but the per-thread
  // observations must survive: attach the summary to the error instead of losing it.
  const refuse=(message:string):never=>{
    const error=new AppError('INBOX_WINDOW_UNAVAILABLE',message,400) as AppError&{discovery?:BrowserInboxDiscoverySummary};
    error.discovery=discovery;
    throw error;
  };
  if(!(messages.length>0||discovery.empty_list))refuse('当前窗口没有可核实的已接受会话；需要人工查看，不认定没有消息');
  return {messages,discovery};
}

/**
 * A blocked read must leave the reason on record. The controller does not store report diagnostics,
 * so the message itself has to stay short, fact-only and free of page content: the stage, the error
 * kind and, for an AppError, the code that the caller already maps into discovery.skipped.
 */
function blockedDiagnostic(error:unknown,step:string,browserVersion:string|undefined){
  const kind=error instanceof AppError?error.code:error instanceof Error?error.name:'UNKNOWN';
  const message=error instanceof Error?error.message:'';
  return {step,browser_version:browserVersion,error_kind:kind,error_message:message.slice(0,180)};
}

export async function executeFacebookBrowserInbox(command: AgentCommand, root: string, hooks: ExecutorHooks): Promise<Omit<ActionReport,'event_id'|'command_id'>> {
  const snapshot=command.snapshot, request=snapshot.inbox, environment=snapshot.browser_environment;
  requireCondition(!snapshot.is_synthetic && snapshot.mode==='CONTROLLED_PILOT' && snapshot.capability_key==='facebook.inbox.read.browser' && snapshot.adapter_version==='facebook-inbox-browser-v1' && request?.template==='facebook-inbox-dom-v1' && Boolean(request.binding.target||request.binding.discovery) && environment?.account_type==='profile' && environment.configuration.driver==='adspower' && environment.configuration.login_account_id===snapshot.external_account_id && !snapshot.body && !snapshot.message && !snapshot.collection && !snapshot.outreach,'FORBIDDEN_SCOPE','当前真实收件需要明确的个人账号会话读取范围');
  requireCondition(process.env.KFF_ENABLE_BROWSER_INBOX==='true','INBOX_DISABLED','真实浏览器收件尚未开启');
  requireCondition(digest(snapshot)===command.snapshot_hash && digest(environment)===digest(request.binding.environment),'APPROVAL_STALE','收件或环境快照不一致');
  const controlled=()=>{hooks.assertControlled();requireCondition(Date.parse(request.expires_at)>Date.now(),'RETENTION_EXPIRED','收件保留期已结束');};
  assertTemplateSnapshot(snapshot);controlled();
  const managed=await openManagedBrowser(root,environment,false);let step='facebook-inbox-tab-focus';
  try {
    hooks.onContext(managed.context);const page=await managed.context.newPage();page.setDefaultTimeout(10000);
    // AdsPower can leave a new tab hidden; activate this owned page before Messenger interactions.
    await page.bringToFront();step='facebook-inbox-identity-before';
    await inspectFacebookProfileIdentity(page,snapshot.external_account_id);controlled();
    step='facebook-inbox-read'; const read=request.binding.discovery?await readFacebookInboxDirectory(page,request,controlled,value=>{step=value;}):{messages:await readFacebookInboxThread(page,request,controlled,value=>{step=value;}),discovery:undefined}, observed=new Date().toISOString();
    step='facebook-inbox-identity-after';await inspectFacebookProfileIdentity(page,snapshot.external_account_id);controlled();
    const inboxPage=browserInboxPage.parse({monitor_id:request.monitor_id,cursor:null,next_cursor:null,has_more:false,...(read.discovery?{discovery:read.discovery}:{}),batch:{schema_version:'kff.browser-inbox-batch.v1',login_account_id:environment.configuration.login_account_id,operating_identity_id:snapshot.external_account_id,observed_at:observed,coverage:'VISIBLE_MESSAGES_ONLY',messages:read.messages}});
    return {outcome:'VERIFIED_SUCCEEDED',inbox_page:inboxPage,receipt:{remote_id:'inbox:'+request.monitor_id+':'+request.token,actual_account_id:snapshot.external_account_id,content_hash:digest(inboxPage),evidence_kind:'browser_dom',observed_at:observed},diagnostic:{step:'facebook-inbox-visible',browser_version:managed.context.browser()?.version(),scene:{identity_count:1,submit_controls:0,result_count:read.messages.length}}};
  } catch(error) {
    return {outcome:'BLOCKED',error_code:error instanceof AppError?error.code:'EXECUTOR_ERROR',diagnostic:{...blockedDiagnostic(error,step,managed.context.browser()?.version())}};
  } finally {await managed.close();hooks.onContext(null);}
}
