import { z } from 'zod';
import { scoped } from '@kff/database';
import { adjudicationInput, type Scope, type Task, type AdjudicationRecord } from '@kff/contracts';
import { digest, isWrite, requireCondition } from './index';
import { audit, requireAdmin } from './service';
import {projectMessageOutcome} from './lead-reception';

export async function adjudicateAction(scope: Scope, runId: string, input: z.infer<typeof adjudicationInput>) {
  requireAdmin(scope); const value = adjudicationInput.parse(input); const hash = digest({ run_id: runId, ...value });
  return scoped(scope, async client => {
    const run = (await client.query('SELECT id,task_id FROM kff.runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    requireCondition(run, 'NOT_FOUND', '运行不存在', 404);
    const action = (await client.query('SELECT * FROM kff.actions WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
    const previous = (await client.query<AdjudicationRecord & { request_hash: string }>('SELECT * FROM kff.action_adjudications WHERE id=$1', [value.request_id])).rows[0];
    if (previous) { requireCondition(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '裁定请求已有不同内容', 409); return previous; }
    requireCondition(action.state === value.expected_state && action.adjudication_version === value.expected_version, 'VERSION_CONFLICT', '结果或裁定版本已变化，请重新核对', 409);
    const task = (await client.query<Task>('SELECT * FROM kff.tasks WHERE id=$1', [run.task_id])).rows[0]; const snapshot = task.snapshot;
    requireCondition(value.snapshot_hash === task.snapshot_hash && digest(snapshot) === task.snapshot_hash && value.evidence.content_hash === snapshot.content_hash, 'APPROVAL_STALE', '证据与原任务内容版本不符', 409);
    requireCondition(value.evidence.external_account_id === snapshot.external_account_id, 'ACCOUNT_MISMATCH', '证据中的账号与原任务不符', 409);
    if(snapshot.outreach?.browser&&value.decision==='CONFIRMED_SUCCESS'){
      const source=snapshot.outreach.browser;
      requireCondition(value.evidence.remote_id&&/^[0-9]{1,80}$/.test(value.evidence.remote_id)&&value.evidence.remote_id!==source.comment_id&&value.evidence.parent_id===source.comment_id&&value.evidence.source_url===source.comment_url+'&reply_comment_id='+value.evidence.remote_id,'ACCOUNT_MISMATCH','证据必须对应原公开评论及新回复链接',409);
    }
    if(snapshot.outreach)requireCondition(value.evidence.recipient_id===snapshot.outreach.author_id,'ACCOUNT_MISMATCH','证据互动作者不符',409);
    if(snapshot.message)requireCondition(snapshot.message.browser ? value.evidence.recipient_id===snapshot.message.browser.peer_id && value.evidence.thread_id===snapshot.message.browser.thread_id : value.evidence.recipient_id===snapshot.message.contact.remote_id,'ACCOUNT_MISMATCH','证据中的客户或会话与原私信收件人不符',409);
    requireCondition(snapshot.is_synthetic === (value.evidence.source === 'owned_fixture'), 'FORBIDDEN_SCOPE', '合成证据与真实平台证据不能混用', 403);
    const observed = Date.parse(value.evidence.observed_at);
    requireCondition(observed >= new Date(action.created_at).getTime() && observed <= Date.now() + 60000, 'INVALID_INPUT', '证据核查时间应在本动作创建后，且不能在未来');
    if (value.decision !== 'INCONCLUSIVE') {
      const unclosed = await client.query("SELECT id FROM kff.agent_commands WHERE action_id=$1 AND (state NOT IN ('DONE','EXPIRED') OR quiesced_at IS NULL)", [action.id]);
      requireCondition(!unclosed.rowCount, 'GUARDIAN_UNCONFIRMED', '旧执行上下文尚未确认关闭，暂不能最终裁定', 409);
    }
    if (value.decision === 'CONFIRMED_SUCCESS') {
      const remoteId = value.evidence.remote_id!;
      if (isWrite(snapshot)) {
        const submitted = await client.query('SELECT id FROM kff.action_attempts WHERE action_id=$1 AND submitted_at IS NOT NULL', [action.id]);
        requireCondition(submitted.rowCount, 'SUBMISSION_UNCERTAIN', '本动作没有持久提交意图，不能关联为原发布成功', 409);
        requireCondition((snapshot.is_synthetic ? /^synthetic_[a-f0-9-]{36}$/ : snapshot.message?.browser?/^[A-Za-z0-9_:+.@-]{1,160}$/:(snapshot.message||snapshot.outreach)?/^[A-Za-z0-9_:.=$+/-]{1,200}$/:/^[0-9]+_[0-9]+$/).test(remoteId), 'INVALID_INPUT', '远端对象标识与本动作类型不符');
      } else requireCondition(remoteId === snapshot.external_account_id, 'ACCOUNT_MISMATCH', '只读证据必须对应原主页身份', 409);
    }
    const state = value.decision === 'CONFIRMED_SUCCESS' ? 'VERIFIED_SUCCEEDED' : value.decision === 'CONFIRMED_FAILURE' ? 'VERIFIED_FAILED' : 'NEEDS_HUMAN';
    const version = action.adjudication_version + 1;
    const record = (await client.query<AdjudicationRecord>('INSERT INTO kff.action_adjudications(id,organization_id,brand_id,action_id,reviewer_id,request_hash,snapshot_hash,expected_version,result_version,previous_state,decision,result_state,evidence,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *', [value.request_id, scope.organization_id, scope.brand_id, action.id, scope.user_id, hash, task.snapshot_hash, action.adjudication_version, version, action.state, value.decision, state, value.evidence, value.reason])).rows[0];
    const receipt = value.decision === 'INCONCLUSIVE' ? action.receipt : { evidence_kind: 'human_review', adjudication_id: record.id, remote_id: value.evidence.remote_id, actual_account_id: snapshot.external_account_id, ...((snapshot.message||snapshot.outreach)?{recipient_id:value.evidence.recipient_id}:{}),...(snapshot.message?.browser?{thread_id:value.evidence.thread_id}:{}),...(snapshot.outreach?.browser?{parent_id:value.evidence.parent_id,source_url:value.evidence.source_url}:{}),content_hash: snapshot.content_hash, observed_at: value.evidence.observed_at };
    const error = value.decision === 'INCONCLUSIVE' ? 'HUMAN_REVIEW_INCONCLUSIVE' : value.decision === 'CONFIRMED_FAILURE' ? 'MANUALLY_CONFIRMED_FAILURE' : null;
    await client.query('UPDATE kff.actions SET state=$1,adjudication_version=$2,receipt=$3,error_code=$4 WHERE id=$5', [state, version, receipt, error, action.id]);
    await projectMessageOutcome(client,action.id,snapshot);
    const status = value.decision === 'CONFIRMED_SUCCESS' ? 'SUCCEEDED' : value.decision === 'CONFIRMED_FAILURE' ? 'FAILED' : 'NEEDS_HUMAN';
    await client.query('UPDATE kff.runs SET status=$1,updated_at=now() WHERE id=$2', [status, runId]);
    await client.query('UPDATE kff.tasks SET status=$1 WHERE id=$2', [status, task.id]);
    await audit(client, scope, 'action.human_adjudicated', action.id, { adjudication_id: record.id, decision: value.decision, result_version: version, evidence_source: value.evidence.source });
    return record;
  });
}
