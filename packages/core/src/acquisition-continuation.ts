import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {transaction} from '@kff/database';
import type {CollectionRecord,Scope} from '@kff/contracts';
import {facebookPublicPostUrl,monitorInput,type MonitorInput} from '../../contracts/src/acquisition';
import {publicationAge} from '../../contracts/src/publication-time';
import {scoreAcquisitionText} from './acquisition-scoring';
import {audit} from './service';
import {digest} from './index';
import type {Monitor} from './acquisition';

// One short transaction lock orders parent pause, child scheduling and derivation.
// Browser work never runs under this lock.
export async function lockAcquisitionSources(client:PoolClient){
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acquisition-source-continuation',0))");
}
export async function derivedMonitorActive(client:PoolClient,monitorId:string){
  const row=(await client.query(`SELECT c.parent_monitor_id,c.state,c.derived_expires_at>clock_timestamp() AS unexpired,
    p.state AS parent_state,p.version=c.parent_monitor_version AS current_parent
    FROM kff.acquisition_monitors c LEFT JOIN kff.acquisition_monitors p ON p.id=c.parent_monitor_id WHERE c.id=$1`,[monitorId])).rows[0];
  return Boolean(row&&(!row.parent_monitor_id||row.state==='ACTIVE'&&row.unexpired&&row.parent_state==='ACTIVE'&&row.current_parent));
}
export function continuationSource(config:MonitorInput,row:{source_url:string;source_object_id:string;fields:CollectionRecord['fields']},now=new Date().toISOString()){
  const rule=config.comment_continuation;
  if(!rule||!facebookPublicPostUrl.safeParse(row.source_url).success)return null;
  const reel=/\/reel\/([0-9]+)\/$/.exec(row.source_url),post=/\/posts\/([^/]+)\/$/.exec(row.source_url);
  const kind=reel?'REEL':'POST',id=reel?.[1]??post?.[1];
  if(!id||!rule.allowed_source_types.includes(kind)||row.source_object_id!==`facebook:${reel?'reel':'post'}:${id}`)return null;
  if(publicationAge(row.fields.created_time,now,config.discovery.max_age_days)!=='RECENT')return null;
  const body=row.fields.message?.kind==='VALUE'?String(row.fields.message.value):'';
  if(!scoreAcquisitionText(body,config.discovery).score)return null;
  return row.source_url;
}
export async function stopDerivedMonitors(client:PoolClient,parentId?:string){
  const stopped=(await client.query(`UPDATE kff.acquisition_monitors c SET state='PAUSED',version=c.version+1
    FROM kff.acquisition_monitors p WHERE c.parent_monitor_id=p.id AND c.state='ACTIVE'
    AND ($1::uuid IS NOT NULL AND p.id=$1 OR $1::uuid IS NULL AND
      (p.state<>'ACTIVE' OR p.version<>c.parent_monitor_version OR c.derived_expires_at<=clock_timestamp())) RETURNING c.id`,[parentId??null])).rows;
  if(stopped.length)await cancelMonitorScans(client,stopped.map(row=>row.id));
  return stopped.length;
}
export async function cancelMonitorScans(client:PoolClient,ids:string[]){
  await client.query(`UPDATE kff.collection_runs r SET state='CANCELED',stop_reason='MONITOR_PAUSED',lease_token=lease_token+1,
    lease_until=NULL,version=version+1,finished_at=clock_timestamp() FROM kff.acquisition_scans s
    WHERE s.query_id=r.query_id AND s.monitor_id=ANY($1::uuid[]) AND r.state IN ('QUEUED','RUNNING')`,[ids]);
}
export async function deriveCommentMonitors(){
  return transaction(async client=>{
    await lockAcquisitionSources(client);await stopDerivedMonitors(client);
    const parents=(await client.query<Monitor>(`SELECT m.* FROM kff.acquisition_monitors m
      JOIN kff.accounts a ON a.id=m.account_id JOIN kff.brands b ON b.id=m.brand_id JOIN kff.organizations o ON o.id=m.organization_id
      WHERE m.state='ACTIVE' AND m.parent_monitor_id IS NULL AND m.config ? 'comment_continuation'
      AND a.state='ACTIVE' AND NOT a.outbound_paused AND NOT b.outbound_paused AND NOT o.outbound_paused
      ORDER BY m.created_at LIMIT 100 FOR UPDATE OF m`)).rows;
    let createdCount=0;
    for(const parent of parents){
      const config=monitorInput.parse(parent.config),rule=config.comment_continuation!;
      const total=(await client.query('SELECT count(*)::int n FROM kff.acquisition_monitors WHERE parent_monitor_id=$1',[parent.id])).rows[0].n;
      let remaining=rule.max_sources_total-total;if(remaining<=0)continue;
      const rows=(await client.query(`SELECT x.*,s.query_id FROM kff.collection_observations x
        JOIN kff.collection_runs r ON r.id=x.run_id JOIN kff.collection_pages cp ON cp.id=x.page_id JOIN kff.acquisition_scans s ON s.query_id=r.query_id
        WHERE s.monitor_id=$1 AND s.monitor_version=$2 AND r.state IN ('COMPLETED','PARTIAL')
        AND x.expires_at>clock_timestamp() AND x.observed_at>clock_timestamp()-make_interval(hours=>$3)
        AND r.error_code IS NULL
        AND EXISTS(SELECT 1 FROM kff.tasks t JOIN kff.actions a ON a.task_id=t.id
          WHERE t.snapshot->'collection'->>'run_id'=r.id::text AND a.state='VERIFIED_SUCCEEDED' AND a.receipt->>'evidence_kind'='browser_dom' AND a.receipt->>'remote_id'='collection:'||r.id::text||':'||cp.page_number::text)
        AND NOT EXISTS(SELECT 1 FROM kff.acquisition_monitors c WHERE c.parent_monitor_id=$1 AND c.derived_source_url=x.source_url)
        AND NOT EXISTS(SELECT 1 FROM kff.acquisition_leads l WHERE l.monitor_id=$1 AND l.object_id=x.object_id AND l.state IN ('DISMISSED','OPTED_OUT'))
        ORDER BY x.observed_at DESC,x.id LIMIT 1000`,[parent.id,parent.version,rule.source_lifetime_hours])).rows;
      const perScan=new Map<string,number>();
      for(const row of rows){
        if(remaining<=0)break;
        const url=continuationSource(config,row);if(!url)continue;
        if(!perScan.has(row.query_id))perScan.set(row.query_id,(await client.query('SELECT count(*)::int n FROM kff.acquisition_monitors WHERE parent_monitor_id=$1 AND source_query_id=$2',[parent.id,row.query_id])).rows[0].n);
        if(perScan.get(row.query_id)!>=rule.max_sources_per_scan)continue;
        const {comment_continuation:_rule,...base}=config;void _rule;
        const child=monitorInput.parse({...base,request_id:randomUUID(),title:(parent.title+' · 评论接续').slice(0,120),
          discovery:{...config.discovery,strategy:'COMMENTS',target:url,browser:{...config.discovery.browser,template:'facebook-comments-dom-v1',comment_order:rule.comment_order}},
          max_pages:rule.comment_order==='VISIBLE_WINDOW'?1:config.max_pages});
        const expires=new Date(Math.min(Date.parse(row.expires_at),Date.parse(row.observed_at)+rule.source_lifetime_hours*3600000)).toISOString();
        const created=(await client.query(`INSERT INTO kff.acquisition_monitors(organization_id,brand_id,account_id,request_id,request_hash,title,config,interval_minutes,created_by,state,
          parent_monitor_id,parent_monitor_version,source_observation_id,source_query_id,derived_source_url,derived_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11,$12,$13,$14,$15)
          ON CONFLICT(parent_monitor_id,derived_source_url) DO NOTHING RETURNING *`,
        [parent.organization_id,parent.brand_id,parent.account_id,child.request_id,digest(child),child.title,child,child.interval_minutes,parent.created_by,parent.id,parent.version,row.id,row.query_id,url,expires])).rows[0];
        if(!created)continue;
        const scope:Scope={organization_id:parent.organization_id,brand_id:parent.brand_id,user_id:parent.created_by,role:'admin'};
        await audit(client,scope,'acquisition.source_derived',created.id,{parent_monitor_id:parent.id,source_observation_id:row.id,source_query_id:row.query_id,source_url:url,expires_at:expires});
        perScan.set(row.query_id,perScan.get(row.query_id)!+1);remaining--;createdCount++;
      }
    }
    return createdCount;
  });
}
