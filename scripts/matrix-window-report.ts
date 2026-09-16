import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
import {z} from 'zod';
import {transaction,closePool} from '@kff/database';

// Read-only acceptance export. Never starts monitors, browsers, or outbound actions.
const {values}=parseArgs({options:{plan:{type:'string'},output:{type:'string'}}});
if(!values.plan||!values.output)throw Error('Use --plan <JSON> --output <new JSON file>');
const plan=z.object({from:z.string().datetime(),to:z.string().datetime(),synthetic:z.boolean(),
  targets:z.array(z.object({account_id:z.string().uuid(),environment_id:z.string().uuid(),
    minimum_public_scans:z.number().int().min(0).max(1000),minimum_inbox_cycles:z.number().int().min(0).max(1000)}).strict().refine(v=>v.minimum_public_scans+v.minimum_inbox_cycles>0,'Each account needs planned work')).min(1).max(10),
}).strict().refine(v=>new Set(v.targets.map(t=>t.account_id)).size===v.targets.length,'Account targets must be unique').refine(v=>Date.parse(v.to)>Date.parse(v.from)&&Date.parse(v.to)-Date.parse(v.from)<=24*3600000,'Window must be positive and at most 24 hours').parse(JSON.parse(readFileSync(values.plan,'utf8').replace(/^\uFEFF/,'')));
try{
  const report=await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const accounts=plan.targets.map(t=>t.account_id),params=[accounts,plan.from,plan.to,plan.synthetic];
    const bindings=(await client.query(`SELECT a.id,a.external_id,a.is_synthetic,e.id AS environment_id,e.agent_id,e.state,e.browser_status
      FROM kff.accounts a JOIN kff.environments e ON e.account_id=a.id WHERE a.id=ANY($1::uuid[]) AND a.is_synthetic=$2`,[accounts,plan.synthetic])).rows;
    const scans=(await client.query(`SELECT s.id,s.monitor_id,s.query_id,m.account_id,s.monitor_version,r.id AS run_id,r.state,r.error_code,r.stop_reason,
      r.returned_count,r.unique_count,r.created_at,r.started_at,r.finished_at
      FROM kff.acquisition_scans s JOIN kff.acquisition_monitors m ON m.id=s.monitor_id JOIN kff.accounts a ON a.id=m.account_id
      JOIN kff.collection_runs r ON r.query_id=s.query_id WHERE m.account_id=ANY($1::uuid[]) AND s.created_at>=$2 AND s.created_at<$3 AND a.is_synthetic=$4 ORDER BY s.created_at`,params)).rows;
    // Start from tasks/actions, not commands: pre-dispatch failures have no command.
    const actions=(await client.query(`SELECT t.id AS task_id,t.account_id,t.environment_id,t.status,t.snapshot->>'external_account_id' AS expected_identity,
      t.snapshot->>'capability_key' AS capability,t.snapshot->'collection'->>'query_id' AS query_id,t.snapshot->'inbox'->>'monitor_id' AS inbox_monitor_id,
      a.id AS action_id,a.state,a.error_code,t.created_at,c.id AS command_id,c.created_at AS queued_at,c.claimed_at,c.quiesced_at,
      a.receipt->>'actual_account_id' AS actual_identity,a.receipt->>'observed_at' AS receipt_at,
      EXTRACT(epoch FROM (c.claimed_at-c.created_at)) AS queue_seconds,EXTRACT(epoch FROM (c.quiesced_at-c.claimed_at)) AS execution_seconds,
      EXISTS(SELECT 1 FROM kff.audit_events proof WHERE proof.event_type='guardian.quiesced' AND proof.object_id=c.id) AS closure_recorded
      FROM kff.tasks t JOIN kff.accounts ac ON ac.id=t.account_id LEFT JOIN kff.actions a ON a.task_id=t.id LEFT JOIN kff.agent_commands c ON c.action_id=a.id
      WHERE t.account_id=ANY($1::uuid[]) AND t.created_at>=$2 AND t.created_at<$3 AND ac.is_synthetic=$4
      AND (t.snapshot ? 'collection' OR t.snapshot ? 'inbox') ORDER BY t.created_at,a.id`,params)).rows;
    const inbox=(await client.query(`SELECT cp.task_id,cp.monitor_id,m.account_id,cp.cycle_id,cp.stored,cp.duplicates,cp.observed_at,cp.next_cursor
      FROM kff.browser_inbox_checkpoints cp JOIN kff.browser_inbox_monitors m ON m.id=cp.monitor_id JOIN kff.accounts a ON a.id=m.account_id
      WHERE m.account_id=ANY($1::uuid[]) AND cp.created_at>=$2 AND cp.created_at<$3 AND a.is_synthetic=$4 ORDER BY cp.created_at`,params)).rows;
    const inboxNotes=(await client.query(`SELECT e.id,e.object_id,e.event_type,e.created_at,e.details->>'task_id' AS task_id,e.details->>'reason' AS reason,
      e.details->'discovery'->'skipped' AS skipped,e.details->'discovery'->'unparsed_rows' AS unparsed_rows,e.details->'discovery'->'window_limited' AS window_limited
      FROM kff.audit_events e JOIN kff.browser_inbox_monitors m ON m.id=e.object_id JOIN kff.accounts a ON a.id=m.account_id
      WHERE m.account_id=ANY($1::uuid[]) AND e.created_at>=$2 AND e.created_at<$3 AND a.is_synthetic=$4 AND e.event_type LIKE 'browser_inbox.%' ORDER BY e.created_at`,params)).rows;
    const leads=(await client.query(`SELECT l.id,l.monitor_id,m.account_id,l.state,l.score,l.first_seen_at,l.version,x.source_object_id,
      x.fields->'author_id'->>'value' AS explicit_author_id FROM kff.acquisition_leads l JOIN kff.acquisition_monitors m ON m.id=l.monitor_id
      JOIN kff.accounts a ON a.id=m.account_id JOIN kff.collection_observations x ON x.id=l.observation_id
      WHERE m.account_id=ANY($1::uuid[]) AND l.first_seen_at>=$2 AND l.first_seen_at<$3 AND a.is_synthetic=$4 ORDER BY l.first_seen_at`,params)).rows;
    const problems:string[]=[];
    if(Date.now()<Date.parse(plan.to))problems.push('WINDOW_NOT_FINISHED');
    for(const target of plan.targets){
      if(!bindings.some(b=>b.id===target.account_id&&b.environment_id===target.environment_id))problems.push('BINDING_MISMATCH:'+target.account_id);
      if(scans.filter(s=>s.account_id===target.account_id&&['COMPLETED','PARTIAL'].includes(s.state)&&!s.error_code).length<target.minimum_public_scans)problems.push('PUBLIC_SCANS_SHORT:'+target.account_id);
      if(new Set(inbox.filter(i=>i.account_id===target.account_id&&i.next_cursor===null).map(i=>i.cycle_id)).size<target.minimum_inbox_cycles)problems.push('INBOX_CYCLES_SHORT:'+target.account_id);
    }
    if(scans.some(s=>s.error_code||!['COMPLETED','PARTIAL'].includes(s.state)))problems.push('SCAN_FAILED_OR_UNFINISHED');
    if(actions.some(a=>!a.command_id||a.state!=='VERIFIED_SUCCEEDED'||!a.quiesced_at||!a.closure_recorded))problems.push('ACTION_FAILED_UNDISPATCHED_OR_UNCLOSED');
    if(actions.some(a=>a.actual_identity&&a.actual_identity!==a.expected_identity||!plan.targets.some(t=>t.account_id===a.account_id&&t.environment_id===a.environment_id)))problems.push('ACTION_IDENTITY_OR_ENVIRONMENT_MISMATCH');
    if(inboxNotes.some(n=>n.skipped?.length||Number(n.unparsed_rows)>0||n.window_limited===true))problems.push('INBOX_PARTIAL_COVERAGE');
    return {schema:'kff.matrix-window-report.v1',generated_at:new Date().toISOString(),plan,read_only:true,
      record_review:problems.length?'INCOMPLETE':'RECORDS_MATCH_COUNTS',problems,bindings,scans,actions,inbox,inbox_notes:inboxNotes,leads,
      counts:{lead_records:leads.length,qualified_records:leads.filter(l=>l.state==='QUALIFIED').length,inbox_stored:inbox.reduce((n,r)=>n+r.stored,0),inbox_duplicates:inbox.reduce((n,r)=>n+r.duplicates,0)},
      evidence_limits:['Counts do not establish uninterrupted scheduled observation, provider window ownership, or capacity guarantees.','Lead records are not unique customers; scores are not purchase probabilities.','No natural lead to WhatsApp attribution is inferred from unrelated Inbox or C test records.','Review original timing, skips, command journal and guardian file proofs before accepting a real window.']};
  });
  writeFileSync(values.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output:values.output,record_review:report.record_review,problems:report.problems,counts:report.counts}));
}finally{await closePool();}
