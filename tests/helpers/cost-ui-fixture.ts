import { randomUUID } from 'node:crypto';
import { localConfig, query, scoped, closePool } from '../../packages/database/src/index';
import { createAgent, controlAgent } from '../../packages/core/src/controls';
import { createEnvironment, createTask, approveTask, enqueueTask, stopRun } from '../../packages/core/src/service';
import { reserveCostForAction } from '../../packages/core/src/costs';
import { localIds } from '../../scripts/seed';

// Opt-in local UI fixture. Its Agent is revoked before any task can be queued.
const config = localConfig(); const url = new URL(process.env.DATABASE_URL ?? config.database_url);
if (process.env.KFF_LOCAL_COST_UI_FIXTURE !== '1' || process.env.KFF_ENABLE_LIVE === 'true' || url.href !== new URL(config.database_url).href || url.hostname !== '127.0.0.1' || url.pathname !== '/kff') throw new Error('Local synthetic UI fixture required');
const account = (await query('SELECT is_synthetic FROM kff.accounts WHERE id=$1', [localIds.account]))[0];
if (!account?.is_synthetic) throw new Error('Synthetic account required');
const scope = { organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' as const };
try {
  const executor = await createAgent(scope, { name: '费用界面合成记录 · 永不执行' });
  const environment = await createEnvironment(scope, { name: '费用界面合成记录 · 未启动环境', account_id: localIds.account, agent_id: executor.agent.id });
  await controlAgent(scope, executor.agent.id, { action: 'REVOKE', reason: 'Unused synthetic cost fixture; never start an executor' });
  const task = await createTask(scope, { title: '费用界面合成样本 ' + randomUUID().slice(0, 8), account_id: localIds.account, environment_id: environment.id, capability_id: localIds.publish, body: 'Never submit this synthetic accounting scenario', mode: 'TEST_ONLY', fixture_scenario: 'normal', idempotency_key: randomUUID() });
  await approveTask(scope, task.id, { snapshot_hash: task.snapshot_hash, decision: 'APPROVED' });
  const run = await enqueueTask(scope, task.id); const action = (await query('SELECT id FROM kff.actions WHERE run_id=$1', [run.id]))[0];
  await scoped(scope, client => reserveCostForAction(client, action.id, { permit_id: null, currency: 'QAA', reserved_minor: '123', cost_basis: '本地合成费用样本，没有真实账单与平台调用' }));
  await stopRun(scope, run.id, '结束未执行的合成费用样本');
  const commands = (await query('SELECT count(*)::int AS count FROM kff.agent_commands WHERE action_id=$1', [action.id]))[0].count;
  if (commands !== 0) throw new Error('Synthetic cost fixture unexpectedly dispatched');
  console.log(JSON.stringify({ action_id: action.id, title: task.title, run_id: run.id }));
} finally { await closePool(); }
