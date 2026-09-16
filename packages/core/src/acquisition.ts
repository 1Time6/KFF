import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {scoped,transaction} from '@kff/database';
import type {Scope,Account,CollectionRecord,TaskSnapshot,Capability} from '@kff/contracts';
import {browserEnvironmentSnapshot} from '../../contracts/src/environment';
import {browserCommentContext} from '../../contracts/src/acquisition';
import {taskSnapshotSchema} from '@kff/contracts';
import {discoveryIsSynthetic,monitorInput,monitorControl,leadControl,automationInput,outreachInput,type MonitorInput} from '../../contracts/src/acquisition';
import {digest,requireCondition} from './index';
import {audit,requireAdmin,requireWrite,enqueueTaskInTransaction} from './service';
import {createCollectionInTransaction} from './collections';
import {ensureBundledTemplates,chooseTemplateVersion} from './templates';
import {readStopEpochs} from './lead-reception';
import {adapterImplementationDigest} from './artifacts';
import {projectRoot} from '@kff/database';
import {apifyConnection} from '../../adapters/src/apify-connection';
import {providerWorkspace} from './acquisition-provider';
import {scoreAcquisitionText} from './acquisition-scoring';
import {unifiedAcquisitionCandidates,type CandidateLeadInput} from './acquisition-candidates';
import {publicationAge} from '../../contracts/src/publication-time';
import {lockAcquisitionSources,stopDerivedMonitors,cancelMonitorScans,derivedMonitorActive} from './acquisition-continuation';
import {publicReplyEligibility} from './acquisition-eligibility';

export interface Monitor {id:string;organization_id:string;brand_id:string;account_id:string;title:string;config:MonitorInput;state:'ACTIVE'|'PAUSED';version:number;scan_number:number;interval_minutes:number;next_due_at:string;created_by:string;automation:z.infer<typeof automationInput>|null}
export async function createAcquisitionFixture(scope:Scope,input:unknown){
  requireAdmin(scope);const v=z.object({request_id:z.string().uuid(),platform:z.enum(['facebook','instagram']),agent_id:z.string().uuid()}).strict().parse(input),hash=digest(v);
  return scoped(scope,async client=>{
    const old=await replay(client,scope,v.request_id,hash);if(old)return old;
    requireCondition((await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status<>'REVOKED'",[v.agent_id])).rowCount,'FORBIDDEN_SCOPE','Agent 不属于本品牌',403);
    const external=BigInt('0x'+randomUUID().replaceAll('-','')).toString();
    const a=(await client.query("INSERT INTO kff.accounts(organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',true) RETURNING *",[scope.organization_id,scope.brand_id,'本地获客验证 · '+v.platform+' '+external.slice(-5),v.platform,v.platform==='facebook'?'page':'professional',external])).rows[0];
    const e=(await client.query('INSERT INTO kff.environments(organization_id,brand_id,name,account_id,agent_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[scope.organization_id,scope.brand_id,'获客验证环境',a.id,v.agent_id])).rows[0];
    await ensureBundledTemplates(client,scope);const result={account_id:a.id,environment_id:e.id};
    await audit(client,scope,'acquisition.fixture_created',a.id,{request_id:v.request_id,request_hash:hash,result});return result;
  });
}
export const fieldText=(fields:CollectionRecord['fields'],key:keyof CollectionRecord['fields'])=>fields[key]?.kind==='VALUE'?String(fields[key].value):'';
export const scoreDiscovery=scoreAcquisitionText;

async function replay(client:PoolClient,scope:Scope,id:string,hash:string){
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['acquisition/'+scope.brand_id+'/'+id]);
  const row=(await client.query("SELECT details FROM kff.audit_events WHERE details->>'request_id'=$1 AND event_type LIKE 'acquisition.%'",[id])).rows[0];
  if(row)requireCondition(row.details.request_hash===hash,'IDEMPOTENCY_CONFLICT','请求标识已用于其他内容',409);
  return row?.details.result;
}
export async function createMonitor(scope:Scope,input:unknown){
  requireAdmin(scope);const v=monitorInput.parse(input),hash=digest(v);
  return scoped(scope,async client=>{
    const old=await replay(client,scope,v.request_id,hash);if(old)return old;
    const a=(await client.query<Account>('SELECT * FROM kff.accounts WHERE id=$1',[v.account_id])).rows[0];
    requireCondition(a&&a.platform===v.discovery.platform&&a.is_synthetic===(discoveryIsSynthetic(v.discovery)),'COLLECTION_SOURCE_MISMATCH','平台、账号和来源模式不匹配',409);
    if (v.discovery.browser) requireCondition((await client.query('SELECT 1 FROM kff.environments WHERE id=$1 AND account_id=$2 AND browser_configuration IS NOT NULL', [v.discovery.browser.environment_id, a.id])).rowCount, 'SOURCE_NOT_CONFIGURED', '请先配置当前账号的浏览器环境', 409);
    if(v.discovery.provider==='META_API')requireCondition(v.discovery.strategy==='COMMENTS'&&/^[0-9_]{1,160}$/.test(v.discovery.target),'SOURCE_UNSUPPORTED','Meta 直连支持自有帖子/媒体评论；其他策略请选择数据服务',409);
    if(v.discovery.provider==='META_API')requireCondition(v.discovery.credential_ref===a.credential_ref,'SOURCE_AUTH_REQUIRED','须使用当前账号的凭据引用',409);
    if (v.discovery.browser) {
      const realBrowser = ['facebook-search-dom-v1','facebook-comments-dom-v1','facebook-page-dom-v1'].includes(v.discovery.browser.template ?? '');
      requireCondition(!realBrowser || a.account_type === 'profile', 'SOURCE_UNSUPPORTED', '当前真实浏览器模板需绑定 Facebook 个人账号', 409);
      await client.query('INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING', [scope.organization_id,scope.brand_id,a.id, realBrowser ? 'facebook.discovery.read.browser' : 'kff.fixture.discovery.read.browser', realBrowser ? 'facebook-search-browser-v1' : 'browser-discovery-v1', realBrowser ? 'UNASSESSED' : 'IMPLEMENTED_TEST_ONLY', realBrowser ? 'DISABLED' : 'TEST_ONLY', !realBrowser, realBrowser ? '读取固定关键词公开内容、指定帖子的可见评论或固定公共主页帖子；仅覆盖当前页面窗口，需先登记代码证据。' : '读取本地合成评论 DOM 并写入采集检查点']);
      await ensureBundledTemplates(client,scope);
    }
    const row=(await client.query<Monitor>('INSERT INTO kff.acquisition_monitors(organization_id,brand_id,account_id,request_id,request_hash,title,config,interval_minutes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[scope.organization_id,scope.brand_id,a.id,v.request_id,hash,v.title,v,v.interval_minutes,scope.user_id])).rows[0];
    await audit(client,scope,'acquisition.monitor_created',row.id,{request_id:v.request_id,request_hash:hash,result:row});return row;
  });
}
async function scan(client:PoolClient,m:Monitor){
  const lineage=(await client.query('SELECT parent_monitor_id,derived_expires_at,parent_monitor_version FROM kff.acquisition_monitors WHERE id=$1',[m.id])).rows[0];
  if(lineage.parent_monitor_id){
    const parent=(await client.query('SELECT state,version FROM kff.acquisition_monitors WHERE id=$1',[lineage.parent_monitor_id])).rows[0];
    requireCondition(parent?.state==='ACTIVE'&&parent.version===lineage.parent_monitor_version&&Date.parse(lineage.derived_expires_at)>Date.now(),'SOURCE_CONTINUATION_STOPPED','父监控已停止、版本变化或评论来源已到期',409);
  }
  const active=await client.query("SELECT 1 FROM kff.acquisition_scans s JOIN kff.collection_runs r ON r.query_id=s.query_id WHERE s.monitor_id=$1 AND r.state IN ('QUEUED','RUNNING')",[m.id]);
  if(active.rowCount)return null;
  const account=(await client.query<Account>('SELECT * FROM kff.accounts WHERE id=$1',[m.account_id])).rows[0];
  const scope:Scope={organization_id:m.organization_id,brand_id:m.brand_id,user_id:m.created_by,role:'admin'},v=m.config;
  const created=await createCollectionInTransaction(client,scope,{request_id:randomUUID(),title:m.title+' #'+(m.scan_number+1),source_key:'social.discovery',account_id:account.id,targets:[account.external_id],fields:['message','author_id','reaction_count','comment_count','created_time'],purpose:account.is_synthetic?'software_verification':'lead_discovery',mode:account.is_synthetic?'TEST_ONLY':'CONTROLLED_PILOT',incremental_rule:'append_observations',max_records:v.max_records,max_pages:v.max_pages,page_size:v.page_size??50,retention_days:v.retention_days,display_timezone:'Asia/Shanghai',scenario:'normal',discovery:v.discovery});
  await client.query('INSERT INTO kff.acquisition_scans(organization_id,brand_id,monitor_id,query_id,monitor_version,scan_number) VALUES($1,$2,$3,$4,$5,$6)',[m.organization_id,m.brand_id,m.id,created.id,m.version,m.scan_number+1]);
  await client.query("UPDATE kff.acquisition_monitors SET scan_number=scan_number+1,next_due_at=clock_timestamp()+make_interval(mins=>interval_minutes) WHERE id=$1",[m.id]);return created;
}
export async function controlMonitor(scope:Scope,id:string,input:unknown){
  requireAdmin(scope);const v=monitorControl.parse(input),hash=digest({id,...v});
  return scoped(scope,async client=>{
    await lockAcquisitionSources(client);
    const old=await replay(client,scope,v.request_id,hash);if(old)return old;
    const m=(await client.query<Monitor>('SELECT * FROM kff.acquisition_monitors WHERE id=$1 FOR UPDATE',[id])).rows[0];
    requireCondition(m&&m.version===v.expected_version,'VERSION_CONFLICT','监控配置已变化，请刷新',409);
    let result:unknown;
    if(v.action==='START'){
      const source=(await client.query('SELECT parent_monitor_id FROM kff.acquisition_monitors WHERE id=$1',[m.id])).rows[0];
      requireCondition(!source.parent_monitor_id,'SOURCE_CONTINUATION_STOPPED','派生来源由父监控管理；暂停后请通过新的父搜索重新核对来源',409);
    }
    if(v.action==='SCAN')result=await scan(client,m);
    else{
      result=(await client.query("UPDATE kff.acquisition_monitors SET state=$2,version=version+1,next_due_at=clock_timestamp() WHERE id=$1 RETURNING *",[id,v.action==='START'?'ACTIVE':'PAUSED'])).rows[0];
      if(v.action==='PAUSE'){await cancelMonitorScans(client,[id]);await stopDerivedMonitors(client,id);}
    }
    await audit(client,scope,'acquisition.monitor_controlled',id,{request_id:v.request_id,request_hash:hash,result,action:v.action,reason:v.reason});return result;
  });
}
export async function prepareDiscoveryScan(){
  return transaction(async client=>{
    await lockAcquisitionSources(client);await stopDerivedMonitors(client);
    const m=(await client.query<Monitor>("SELECT m.* FROM kff.acquisition_monitors m JOIN kff.accounts a ON a.id=m.account_id JOIN kff.brands b ON b.id=a.brand_id JOIN kff.organizations o ON o.id=a.organization_id WHERE m.state='ACTIVE' AND m.next_due_at<=clock_timestamp() AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused AND NOT EXISTS(SELECT 1 FROM kff.acquisition_scans s JOIN kff.collection_runs r ON r.query_id=s.query_id WHERE s.monitor_id=m.id AND r.state IN ('QUEUED','RUNNING')) ORDER BY m.next_due_at LIMIT 1 FOR UPDATE OF m SKIP LOCKED")).rows[0];
    return m?scan(client,m):null;
  });
}
export async function projectDiscoveryLeads(){
  return transaction(async client=>{
    const rows=(await client.query("SELECT x.*,s.monitor_id,m.config FROM kff.collection_observations x JOIN kff.collection_runs r ON r.id=x.run_id JOIN kff.acquisition_scans s ON s.query_id=r.query_id JOIN kff.acquisition_monitors m ON m.id=s.monitor_id WHERE x.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM kff.acquisition_evaluations e WHERE e.observation_id=x.id) ORDER BY x.created_at,x.id LIMIT 100 FOR UPDATE OF x SKIP LOCKED")).rows;
    for(const row of rows){
      const keyword=scoreDiscovery(fieldText(row.fields,'message'),row.config.discovery),age=publicationAge(row.fields.created_time,row.observed_at,row.config.discovery.max_age_days);
      const result=age==='OLDER'?{...keyword,score:0,reason:`原始发布时间已超出最近 ${row.config.discovery.max_age_days} 天；${keyword.reason}`}:
        age==='UNKNOWN'&&keyword.score?{...keyword,reason:`发布时间待核对；${keyword.reason}`}:keyword;
      await client.query('INSERT INTO kff.acquisition_evaluations(observation_id,organization_id,brand_id,monitor_id,score,reason) VALUES($1,$2,$3,$4,$5,$6)',[row.id,row.organization_id,row.brand_id,row.monitor_id,result.score,result.reason]);
      const previous=(await client.query('SELECT l.id,l.score,x.fields,x.source_url FROM kff.acquisition_leads l JOIN kff.collection_observations x ON x.id=l.observation_id WHERE l.monitor_id=$1 AND l.object_id=$2 FOR UPDATE OF l',[row.monitor_id,row.object_id])).rows[0];
      // An identical scan is a new observation, but does not invalidate an approved delayed reply.
      if(previous&&previous.score===result.score&&digest({fields:previous.fields,url:previous.source_url})===digest({fields:row.fields,url:row.source_url})){
        await client.query('UPDATE kff.acquisition_leads SET last_seen_at=clock_timestamp() WHERE id=$1',[previous.id]);continue;
      }
      if(!result.score){
        await client.query("UPDATE kff.acquisition_leads SET observation_id=$3,score=0,matched_keywords=$4,reason=CASE WHEN state='NEW' THEN $5 ELSE reason END,last_seen_at=clock_timestamp(),version=version+1 WHERE monitor_id=$1 AND object_id=$2 AND (SELECT observed_at FROM kff.collection_observations WHERE id=observation_id)<=$6::timestamptz",[row.monitor_id,row.object_id,row.id,JSON.stringify(result.matched),result.reason,row.observed_at]);continue;
      }
      await client.query("INSERT INTO kff.acquisition_leads(organization_id,brand_id,monitor_id,object_id,observation_id,score,matched_keywords,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(monitor_id,object_id) DO UPDATE SET observation_id=EXCLUDED.observation_id,score=EXCLUDED.score,matched_keywords=EXCLUDED.matched_keywords,reason=EXCLUDED.reason,last_seen_at=clock_timestamp(),version=kff.acquisition_leads.version+1 WHERE (SELECT observed_at FROM kff.collection_observations WHERE id=kff.acquisition_leads.observation_id)<= $9::timestamptz",[row.organization_id,row.brand_id,row.monitor_id,row.object_id,row.id,result.score,JSON.stringify(result.matched),result.reason,row.observed_at]);
    }return rows.length;
  });
}
export async function controlDiscoveryLead(scope:Scope,id:string,input:unknown){
  requireWrite(scope);const v=leadControl.parse(input),hash=digest({id,...v});return scoped(scope,async client=>{
    const old=await replay(client,scope,v.request_id,hash);if(old)return old;
    const row=(await client.query('UPDATE kff.acquisition_leads SET state=$2,version=version+1,reason=$3,automation_error=NULL,next_action_at=clock_timestamp() WHERE id=$1 AND version=$4 RETURNING *',[id,v.state,v.reason,v.expected_version])).rows[0];
    requireCondition(row,'VERSION_CONFLICT','线索已变化，请刷新',409);
    if(v.state==='OPTED_OUT'){
      const source=(await client.query('SELECT m.account_id,x.fields FROM kff.acquisition_monitors m JOIN kff.collection_observations x ON x.id=$2 WHERE m.id=$1',[row.monitor_id,row.observation_id])).rows[0];
      const author=fieldText(source.fields,'author_id');
      if(author)await client.query('INSERT INTO kff.acquisition_suppressions(organization_id,brand_id,account_id,author_id,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scope.organization_id,scope.brand_id,source.account_id,author,v.reason]);
    }
    await audit(client,scope,'acquisition.lead_controlled',id,{request_id:v.request_id,request_hash:hash,result:row,reason:v.reason});return row;
  });
}
export async function configureAcquisitionAutomation(scope:Scope,input:unknown){
  requireAdmin(scope);const v=automationInput.parse(input),hash=digest(v);return scoped(scope,async client=>{
    const old=await replay(client,scope,v.request_id,hash);if(old)return old;
    const row=(await client.query<Monitor>('SELECT * FROM kff.acquisition_monitors WHERE id=$1 FOR UPDATE',[v.monitor_id])).rows[0];
    requireCondition(row?.version===v.expected_version,'VERSION_CONFLICT','监控配置已变化',409);
    requireCondition((await client.query('SELECT id FROM kff.environments WHERE id=$1 AND account_id=$2',[v.environment_id,row.account_id])).rowCount,'FORBIDDEN_SCOPE','环境与账号不匹配',403);
    const result=(await client.query('UPDATE kff.acquisition_monitors SET automation=$2,version=version+1 WHERE id=$1 RETURNING *',[row.id,v])).rows[0];
    await audit(client,scope,'acquisition.automation_configured',row.id,{request_id:v.request_id,request_hash:hash,result});return result;
  });
}

const leadSelect="SELECT l.*,x.fields,x.source_object_id,x.source_url,x.observed_at,x.expires_at,m.config,m.account_id,m.version AS monitor_version,m.state AS monitor_state,m.automation,EXISTS(SELECT 1 FROM kff.acquisition_suppressions s WHERE s.account_id=m.account_id AND s.author_id=x.fields->'author_id'->>'value') AS author_suppressed FROM kff.acquisition_leads l JOIN kff.collection_observations x ON x.id=l.observation_id JOIN kff.acquisition_monitors m ON m.id=l.monitor_id";
export async function acquisitionWorkspace(scope:Scope){return scoped(scope,async client=>{const workspace={
  external:await providerWorkspace(client),
  accounts:(await client.query<Account>("SELECT * FROM kff.accounts WHERE platform IN ('facebook','instagram') ORDER BY created_at")).rows,
  environments:(await client.query<{id:string;account_id:string;name:string;browser_configured:boolean}>('SELECT id,account_id,name,browser_configuration IS NOT NULL AS browser_configured FROM kff.environments')).rows,
  agents:(await client.query<{id:string;name:string}>("SELECT id,name FROM kff.agents WHERE status NOT IN ('REVOKED','DRAINING')")).rows,
  monitors:(await client.query('SELECT * FROM kff.acquisition_monitors ORDER BY created_at DESC LIMIT 100')).rows,
  leads:(await client.query(leadSelect+' WHERE x.expires_at>clock_timestamp() ORDER BY l.score DESC,l.last_seen_at DESC LIMIT 200')).rows.map(lead=>({...lead,public_reply_eligibility:publicReplyEligibility(lead),publication_age:publicationAge(lead.fields.created_time,new Date().toISOString(),lead.config.discovery.max_age_days)})),
  scans:(await client.query('SELECT s.*,r.id AS run_id,r.state,r.error_code,r.stop_reason,r.returned_count,r.unique_count FROM kff.acquisition_scans s JOIN kff.collection_runs r ON r.query_id=s.query_id ORDER BY s.created_at DESC LIMIT 100')).rows,
  actions:(await client.query('SELECT l.*,t.status,a.state,a.error_code,a.receipt,r.id AS run_id FROM kff.acquisition_action_links l JOIN kff.tasks t ON t.id=l.task_id LEFT JOIN kff.runs r ON r.task_id=t.id LEFT JOIN kff.actions a ON a.run_id=r.id ORDER BY l.created_at DESC LIMIT 100')).rows,
  readiness:{discovery_enabled:process.env.KFF_ENABLE_DISCOVERY==='true',provider_configured:Boolean(process.env.KFF_DISCOVERY_PROVIDER_URL&&process.env.KFF_DISCOVERY_PROVIDER_KEY),apify_configured:Boolean(apifyConnection()),live_enabled:process.env.KFF_ENABLE_LIVE==='true',scope:'未配置数据源不产生真实搜索结果；Meta 直连仅支持自有内容评论。'}
};return {...workspace,candidates:unifiedAcquisitionCandidates(workspace.leads as CandidateLeadInput[],workspace.external.prospects)};});}

export async function queueOutreach(scope:Scope,input:unknown){requireWrite(scope);const v=outreachInput.parse(input);return scoped(scope,client=>queueOutreachInTransaction(client,scope,v));}
async function queueOutreachInTransaction(client:PoolClient,scope:Scope,v:z.infer<typeof outreachInput>){
  const hash=digest(v),old=await replay(client,scope,v.request_id,hash);if(old)return old;
  const lead=(await client.query(leadSelect+' WHERE l.id=$1 FOR UPDATE OF l',[v.lead_id])).rows[0];
  requireCondition(lead&&lead.version===v.expected_version,'VERSION_CONFLICT','线索观察已变化，请重新核对',409);
  requireCondition(!['DISMISSED','OPTED_OUT'].includes(lead.state)&&Date.parse(lead.expires_at)>Date.now(),'CONTACT_BLOCKED','线索已退出、排除或到期',409);
  const d=lead.config.discovery as MonitorInput['discovery'];
  requireCondition(d.max_age_days===undefined||publicationAge(lead.fields.created_time,new Date().toISOString(),d.max_age_days)==='RECENT','SOURCE_TIME_UNVERIFIED','发布时间不在当前筛选范围内或仍待核对',409);
  const browser=d.provider==='LOCAL_BROWSER'&&d.browser?.template==='facebook-comments-dom-v1';
  requireCondition(d.strategy==='COMMENTS'&&(browser||['LOCAL_FIXTURE','META_API'].includes(d.provider)),'CONTACT_BASIS_MISSING','全域/竞品线索仅供筛选；直接评论互动需要自有内容证据',409);
  const author=fieldText(lead.fields,'author_id'),occurred=fieldText(lead.fields,'created_time');
  requireCondition(/^[0-9]{1,128}$/.test(author)&&(browser?lead.fields.created_time?.kind==='DISPLAYED_TIME':Boolean(occurred)),'CONTACT_BASIS_MISSING','来源未返回可核实作者或评论时间',409);
  const a=(await client.query<Account>('SELECT * FROM kff.accounts WHERE id=$1 FOR SHARE',[lead.account_id])).rows[0];
  const e=(await client.query('SELECT * FROM kff.environments WHERE id=$1 AND account_id=$2',[v.environment_id,a.id])).rows[0];
  requireCondition(e,'FORBIDDEN_SCOPE','指定环境不属于该账号',403);
  let browserContext, browserEnvironment;
  if(browser){
    requireCondition(!a.is_synthetic&&a.account_type==='profile'&&a.platform==='facebook'&&v.action==='COMMENT_REPLY','CONTACT_BASIS_MISSING','浏览器公开评论不会取得私信资格',409);
    requireCondition(lead.state==='QUALIFIED'&&lead.score>0,'CONTACT_BLOCKED','先将线索核对为值得跟进，再准备回复',409);
    requireCondition(d.browser?.environment_id===e.id&&e.browser_configuration?.driver==='adspower','FORBIDDEN_SCOPE','须使用采集时绑定的 AdsPower 环境',403);
    requireCondition(v.expires_at&&Date.parse(v.expires_at)>Date.now()+v.delay_minutes*60000&&Date.parse(v.expires_at)<=Date.now()+48*3600000,'CONTACT_WINDOW_CLOSED','请指定延迟之后、48 小时内的动作有效期限',409);
    const sourceBody=fieldText(lead.fields,'message');
    browserContext=browserCommentContext.parse({comment_order:d.browser?.comment_order??'NEWEST',source_url:d.target,comment_id:lead.source_object_id.replace(/^facebook:comment:/,''),comment_url:lead.source_url,source_body:sourceBody,source_content_hash:digest(sourceBody),displayed_time:lead.fields.created_time.value,observed_at:new Date(lead.observed_at).toISOString(),expires_at:v.expires_at});
    browserEnvironment=browserEnvironmentSnapshot.parse({environment_id:e.id,account_id:a.id,agent_id:e.agent_id,organization_id:scope.organization_id,brand_id:scope.brand_id,profile_key:e.profile_key,configuration_version:e.configuration_version,configuration:e.browser_configuration,account_type:'profile',platform:'facebook',is_synthetic:false});
  }else requireCondition(!v.expires_at&&!v.replaces_task_id,'INVALID_INPUT','额外期限及草稿替换仅用于浏览器公开评论');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['outreach/'+a.id+'/'+author]);
  const duplicate=(await client.query('SELECT task_id FROM kff.acquisition_action_links WHERE account_id=$1 AND platform=$2 AND source_object_id=$3 AND action_kind=$4 AND superseded_at IS NULL',[a.id,d.platform,lead.source_object_id,v.action])).rows[0];
  if(duplicate&&browser&&v.replaces_task_id===duplicate.task_id){
    const previous=(await client.query("SELECT id,status,snapshot FROM kff.tasks WHERE id=$1 FOR UPDATE",[duplicate.task_id])).rows[0];
    const actions=(await client.query(`SELECT a.id,a.state,a.error_code,
      EXISTS(SELECT 1 FROM kff.action_attempts at WHERE at.action_id=a.id AND at.submitted_at IS NOT NULL) has_submission,
      EXISTS(SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id) AND NOT EXISTS(
        SELECT 1 FROM kff.agent_commands c WHERE c.action_id=a.id AND (c.state<>'DONE' OR c.claimed_at IS NULL OR c.quiesced_at IS NULL OR NOT EXISTS(
          SELECT 1 FROM kff.audit_events e WHERE e.event_type='guardian.quiesced' AND e.object_id=c.id AND e.details->'proof'->>'command_id'=c.id::text AND e.details->'proof'->>'action_id'=a.id::text))) closed_with_proof
      FROM kff.actions a WHERE a.task_id=$1 FOR UPDATE OF a`,[previous.id])).rows;
    const repairedPreparation=previous.status==='FAILED'&&previous.snapshot.implementation_digest!==adapterImplementationDigest(projectRoot,'facebook')&&actions.length===1&&actions[0].state==='BLOCKED'&&actions[0].error_code==='BROWSER_LOCATOR_AMBIGUOUS'&&!actions[0].has_submission&&actions[0].closed_with_proof;
    requireCondition(['DRAFT','REJECTED'].includes(previous.status)&&actions.length===0||repairedPreparation,'OUTREACH_ALREADY_EXISTS','仅未执行草稿，或实现已更新、明确未提交且关闭证明完整的定位失败，才能重新准备；已有提交须核验原动作',409);
    if(repairedPreparation){
      await client.query('UPDATE kff.pilot_permits SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE task_id=$1',[previous.id]);
      await audit(client,scope,'acquisition.failed_preparation_superseded',previous.id,{replacement_request_id:v.request_id,replacement_lead_id:lead.id,previous_action_id:actions[0].id,submitted:false,closure_verified:true});
    }
    await client.query('UPDATE kff.acquisition_action_links SET superseded_at=clock_timestamp() WHERE task_id=$1',[previous.id]);
    if(previous.status==='DRAFT')await client.query("UPDATE kff.tasks SET status='REJECTED' WHERE id=$1",[previous.id]);
    await audit(client,scope,'acquisition.draft_superseded',previous.id,{replacement_request_id:v.request_id,replacement_lead_id:lead.id});
  }else requireCondition(!duplicate&&!v.replaces_task_id,'OUTREACH_ALREADY_EXISTS','此评论已有同类动作，请查看原结果，不重复发送',409);
  const key=browser?'facebook.comment.reply.browser':a.is_synthetic?'kff.fixture.social.reply.api':'social.comment.reply.api',adapter=browser?'facebook-browser-comment-v1':'social-outreach-v1';
  await client.query("INSERT INTO kff.capabilities(organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$8,$5,$6,$7,'指定评论互动；真实动作需审核与单次许可') ON CONFLICT DO NOTHING",[scope.organization_id,scope.brand_id,a.id,key,a.is_synthetic?'IMPLEMENTED_TEST_ONLY':'UNASSESSED',a.is_synthetic?'TEST_ONLY':'DISABLED',a.is_synthetic,adapter]);
  await ensureBundledTemplates(client,scope);
  const c=(await client.query<Capability>('SELECT * FROM kff.capabilities WHERE account_id=$1 AND capability_key=$2 ORDER BY revision DESC LIMIT 1',[a.id,key])).rows[0];
  const snapshot=taskSnapshotSchema.parse({browser_environment:browserEnvironment,account_id:a.id,external_account_id:a.external_id,account_version:a.version,credential_ref:a.credential_ref,environment_id:e.id,environment_version:e.configuration_version??1,profile_key:e.profile_key,agent_id:e.agent_id,capability_id:c.id,capability_key:key,capability_revision:c.revision,adapter_version:adapter,implementation_digest:a.is_synthetic?null:adapterImplementationDigest(projectRoot,'facebook'),platform_api_version:a.is_synthetic||browser?null:d.graph_version??null,body:v.body,content_hash:digest(v.body),not_before:new Date(Date.now()+v.delay_minutes*60000).toISOString(),mode:a.is_synthetic?'TEST_ONLY':'CONTROLLED_PILOT',template:await chooseTemplateVersion(client,key,adapter),fixture_scenario:'normal',is_synthetic:a.is_synthetic,outreach:{lead_id:lead.id,observation_id:lead.observation_id,monitor_id:lead.monitor_id,monitor_version:lead.monitor_version,platform:d.platform,action:v.action,source_object_id:lead.source_object_id,parent_id:d.provider==='LOCAL_FIXTURE'?a.external_id:d.target,author_id:author,occurred_at:browser?undefined:occurred,browser:browserContext,lead_version:lead.version,authorization_basis:v.authorization_basis,stop_epochs:await readStopEpochs(client,a.id,e.agent_id)}});
  await outreachSubmissionGate(client,snapshot);
  const content=(await client.query('INSERT INTO kff.content_versions(organization_id,brand_id,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[scope.organization_id,scope.brand_id,v.body,snapshot.content_hash,scope.user_id])).rows[0];
  const task=(await client.query("INSERT INTO kff.tasks(organization_id,brand_id,title,account_id,environment_id,capability_id,content_version_id,snapshot,snapshot_hash,idempotency_key,request_hash,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",[scope.organization_id,scope.brand_id,v.action+' · '+lead.source_object_id,a.id,e.id,c.id,content.id,snapshot,digest(snapshot),'outreach_'+v.request_id,hash,scope.user_id,browser?'DRAFT':'APPROVED'])).rows[0];
  if(!browser)await client.query("INSERT INTO kff.approval_decisions(organization_id,brand_id,task_id,snapshot_hash,decision,decided_by) VALUES($1,$2,$3,$4,'APPROVED',$5)",[scope.organization_id,scope.brand_id,task.id,digest(snapshot),scope.user_id]);
  await client.query('INSERT INTO kff.acquisition_action_links(task_id,organization_id,brand_id,monitor_id,lead_id,account_id,platform,source_object_id,author_id,action_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[task.id,scope.organization_id,scope.brand_id,lead.monitor_id,lead.id,a.id,d.platform,lead.source_object_id,author,v.action]);
  const run=a.is_synthetic?await enqueueTaskInTransaction(client,scope,task.id):null;
  if(run)await client.query("UPDATE kff.jobs SET available_at=clock_timestamp()+make_interval(mins=>$1) WHERE action_id IN (SELECT id FROM kff.actions WHERE run_id=$2)",[v.delay_minutes,run.id]);
  const result={task_id:task.id,run_id:run?.id??null,status:run?'QUEUED':browser?'AWAITING_REVIEW':'AWAITING_PILOT_PERMIT'};
  await audit(client,scope,'acquisition.outreach_prepared',lead.id,{request_id:v.request_id,request_hash:hash,result});return result;
}
export async function outreachSubmissionGate(client:PoolClient,snapshot:TaskSnapshot,actionId?:string){
  const s=snapshot.outreach;if(!s)return;
  requireCondition(await derivedMonitorActive(client,s.monitor_id),'SOURCE_CONTINUATION_STOPPED','评论来源已暂停或到期，请重新核对',409);
  const lead=(await client.query(leadSelect+' WHERE l.id=$1 FOR SHARE OF l,m',[s.lead_id])).rows[0];
  requireCondition(lead&&lead.account_id===snapshot.account_id&&lead.observation_id===s.observation_id&&lead.version===s.lead_version&&lead.monitor_version===s.monitor_version,'OUTREACH_STALE','线索或监控配置变化，旧动作不再执行',409);
  requireCondition(lead.config.discovery.max_age_days===undefined||publicationAge(lead.fields.created_time,new Date().toISOString(),lead.config.discovery.max_age_days)==='RECENT','SOURCE_TIME_UNVERIFIED','等待期间发布时间已超出筛选范围或仍待核对',409);
  requireCondition(!['DISMISSED','OPTED_OUT'].includes(lead.state)&&Date.parse(lead.expires_at)>Date.now(),'CONTACT_BLOCKED','线索已退出或到期',409);
  requireCondition(digest(await readStopEpochs(client,snapshot.account_id,snapshot.agent_id))===digest(s.stop_epochs),'STOP_EPOCH_STALE','停止状态变化，旧动作失效',409);
  if(s.browser){
    const b=s.browser,d=lead.config.discovery;
    requireCondition(lead.state==='QUALIFIED'&&lead.score>0&&d.provider==='LOCAL_BROWSER'&&d.browser?.template==='facebook-comments-dom-v1'&&d.browser.environment_id===snapshot.environment_id&&d.target===b.source_url&&(d.browser.comment_order??'NEWEST')===(b.comment_order??'NEWEST')&&lead.source_object_id===s.source_object_id&&lead.source_url===b.comment_url&&fieldText(lead.fields,'author_id')===s.author_id&&fieldText(lead.fields,'message')===b.source_body&&digest(b.source_body)===b.source_content_hash&&lead.fields.created_time?.kind==='DISPLAYED_TIME'&&lead.fields.created_time.value===b.displayed_time,'OUTREACH_STALE','原评论、作者或已核对状态已变化',409);
    requireCondition(Date.parse(b.expires_at)>Date.now(),'CONTACT_WINDOW_CLOSED','此公开评论动作已到期，请重新核对',409);
  }else requireCondition(s.occurred_at&&Date.parse(s.occurred_at)<=Date.now()+60000&&Date.now()-Date.parse(s.occurred_at)<7*86400000,'CONTACT_WINDOW_CLOSED','评论互动试验窗口已过期',409);
  const opted=await client.query('SELECT 1 FROM kff.acquisition_suppressions WHERE account_id=$1 AND author_id=$2',[snapshot.account_id,s.author_id]);
  requireCondition(!opted.rowCount,'CONTACT_BLOCKED','该作者已退出，不再联系',409);
  const limit=lead.automation?.daily_limit??20;
  const counts=(await client.query("SELECT count(*)::int AS daily,count(*) FILTER(WHERE l.author_id=$2)::int AS author FROM kff.acquisition_action_links l JOIN kff.actions a ON a.task_id=l.task_id WHERE l.account_id=$1 AND EXISTS(SELECT 1 FROM kff.action_attempts t WHERE t.action_id=a.id AND t.submitted_at>=date_trunc('day',clock_timestamp())) AND a.id IS DISTINCT FROM $3::uuid",[snapshot.account_id,s.author_id,actionId??null])).rows[0];
  requireCondition(counts.daily<limit&&counts.author<1,'RATE_LIMITED','达到账号每日或同作者联系上限',409);
}
export async function prepareAcquisitionAction(){
  return transaction(async client=>{
    const row=(await client.query(leadSelect+" WHERE x.expires_at>clock_timestamp() AND m.state='ACTIVE' AND m.automation->>'enabled'='true' AND l.state IN ('NEW','QUALIFIED') AND l.next_action_at<=clock_timestamp() AND (SELECT count(*) FROM kff.acquisition_action_links daily WHERE daily.account_id=m.account_id AND daily.created_at>=date_trunc('day',clock_timestamp()))<(m.automation->>'daily_limit')::int AND l.score>=(m.automation->>'min_score')::int AND m.config->'discovery'->>'strategy'='COMMENTS' AND m.config->'discovery'->>'provider' IN ('LOCAL_FIXTURE','META_API') AND NOT EXISTS(SELECT 1 FROM kff.acquisition_action_links k WHERE k.account_id=m.account_id AND k.source_object_id=x.source_object_id AND k.action_kind=m.automation->>'action' AND k.superseded_at IS NULL) ORDER BY l.first_seen_at LIMIT 1 FOR UPDATE OF l SKIP LOCKED")).rows[0];
    if(!row)return null;const m=(await client.query<Monitor>('SELECT * FROM kff.acquisition_monitors WHERE id=$1',[row.monitor_id])).rows[0],a=m.automation!;
    await client.query('SAVEPOINT prepare_outreach');
    try{return await queueOutreachInTransaction(client,{organization_id:row.organization_id,brand_id:row.brand_id,user_id:m.created_by,role:'admin'},{request_id:randomUUID(),lead_id:row.id,expected_version:row.version,environment_id:a.environment_id,action:a.action,body:a.body,authorization_basis:a.authorization_basis,delay_minutes:a.delay_minutes});}
    catch(error){await client.query('ROLLBACK TO SAVEPOINT prepare_outreach');const code=error instanceof Error&&'code' in error?String(error.code):'PREPARATION_FAILED';await client.query("UPDATE kff.acquisition_leads SET automation_error=$2,next_action_at=CASE WHEN $2='RATE_LIMITED' THEN clock_timestamp()+interval '5 minutes' ELSE NULL END WHERE id=$1",[row.id,code]);return {blocked:code};}
  });
}
