import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
const checks = [];
for (const name of ['typecheck','lint','unit','contracts','integration','fixtures','web','build','production']) {
  const result = JSON.parse(readFileSync('.kff/checks/' + name + '.json', 'utf8'));
  if (result.exit_code !== 0) throw new Error('Check did not pass: ' + name);
  for (const [file, hash] of Object.entries(result.source_hashes)) if (sha(readFileSync(file)) !== hash) throw new Error('Check is stale: ' + name + ' / ' + file);
  let count = null;
  if (['unit','contracts','integration'].includes(name)) {
    const data = JSON.parse(readFileSync('.kff/checks/' + name + '-results.json', 'utf8'));
    if (!data.success || data.numFailedTests || data.numPendingTests || !data.numPassedTests) throw new Error('Test report has failures, skips or no samples: ' + name);
    count = data.numPassedTests;
  }
  if (['fixtures','web'].includes(name)) {
    const data = JSON.parse(readFileSync('.kff/checks/' + name + '-results.json', 'utf8'));
    if (data.stats.unexpected || data.stats.skipped || data.stats.flaky || !data.stats.expected) throw new Error('Browser report not fully passed: ' + name);
    count = data.stats.expected;
  }
  checks.push({ ...result, test_count: count });
}
const files = [...new Set(execFileSync('git', ['ls-files','--cached','--others','--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/))].filter(file => /^(apps|packages|scripts|tests|supabase\/migrations)\//.test(file) && /\.(ts|tsx|mjs|sql|css)$/.test(file)).sort();
const sourceHashes = Object.fromEntries(files.map(file => [file, sha(readFileSync(file))]));
const evidence = { schema_version: 'kff.checkpoint.v1', created_at: new Date().toISOString(), repository_commit_before: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(), source_tree_sha256: sha(JSON.stringify(sourceHashes)), source_hashes: sourceHashes, scope: 'G1 本地功能与选定合同回归；非完整 G1、非真实 Facebook 验收', checks, total_tests: checks.reduce((sum, check) => sum + (check.test_count ?? 0), 0), real_platform_calls: 0, real_platform_verified: false, device_verified: false, full_delivery: false, shutdown_requested: false };
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/g1-local-checkpoint.json', JSON.stringify(evidence, null, 2) + '\n');
const ledger = JSON.parse(readFileSync('docs/tasks/ledger.json','utf8'));
const scoped = {
  'TASK-015': ['Next.js、原生 Postgres、Worker、Agent、构建和实际测试脚本', ['package.json','scripts/dev.ts','scripts/migrate.ts','apps/web/next.config.ts'], ['build','production']],
  'TASK-016': ['当前主页动作的 ID、协议、快照及拒绝未知字段合同', ['packages/contracts/src/index.ts'], ['contracts','unit']],
  'TASK-017': ['本机登录、角色、服务端品牌上下文与 RLS；Supabase 真实联调仍待执行', ['apps/web/lib/auth.ts','packages/database/src/index.ts','supabase/migrations/20260911164326_g1_execution_core.sql'], ['integration','production']],
  'TASK-021': ['不可变单条文本版本；附件不属于此已验证子范围', ['packages/core/src/service.ts'], ['integration','fixtures']],
  'TASK-022': ['单账号、自有主页、动作、内容及实现摘要的批准快照', ['packages/core/src/service.ts','packages/contracts/src/index.ts'], ['integration','contracts']],
  'TASK-023': ['单条任务并发创建、同体复用和异体冲突', ['packages/core/src/service.ts'], ['integration']],
  'TASK-024': ['当前动作状态机与合成未知结果后续核验', ['packages/core/src/index.ts','packages/core/src/reconciliation.ts'], ['unit','integration','web']],
  'TASK-025': ['同库原子投递；真实调用进程与 Worker 在提交前后终止、重启后的业务意图不丢失不重复', ['packages/core/src/service.ts','packages/core/src/execution.ts','tests/integration/durability.test.ts'], ['integration']],
  'TASK-026': ['Postgres 账号/环境租约、token、并发派发、单 Agent 执行槽及过期隔离', ['packages/core/src/execution.ts','supabase/migrations/20260911175746_g1_agent_slot_guard.sql'], ['integration']],
  'TASK-028': ['组织、品牌、账号与任务停止；与提交锁排序协调、展示在途数量；未领取命令有未启动证明', ['packages/core/src/controls.ts','packages/core/src/execution.ts','apps/web/components/workbench.tsx'], ['integration','web']],
  'TASK-029': ['作用域配对文件、令牌仅首次下载、Agent 排空与不可逆撤销；远程宿主联调未验', ['packages/core/src/controls.ts','apps/web/components/executor-controls.tsx','apps/agent/src/config.ts'], ['integration','web']],
  'TASK-030': ['本机持久 journal、独立关闭证明；重启和确认连接丢失后使用同一事件，不重做旧命令', ['apps/agent/src/main.ts','apps/agent/src/guardian-protocol.ts'], ['fixtures','integration']],
  'TASK-031': ['ENV-L1 独立 Chromium profile 的任务内启动与关闭、存储隔离', ['packages/adapters/src/fixture.ts'], ['fixtures']],
  'TASK-032': ['Windows 单槽 guardian、父进程终止/卡住后关闭、缺证明继续隔离；其他宿主与外部人工接管未验', ['apps/agent/src/guardian.ts','apps/agent/src/guardian-child.ts','tests/browser/fixtures/agent-recovery.spec.ts'], ['fixtures','integration','web']],
  'TASK-033': ['D0 v2 协议、适配器与执行器版本、尝试、状态、步骤、错误、耗时白名单；兼容旧导出', ['packages/core/src/index.ts','packages/core/src/reconciliation.ts','apps/agent/src/main.ts'], ['unit','integration','web']],
  'TASK-034': ['本项目合成页、故障场景与非白名单请求阻断', ['scripts/fixture-server.ts','tests/browser/fixtures/executor.spec.ts'], ['fixtures']],
  'TASK-035': ['合成页面的单一身份读取及身份错误拒绝；真实 Facebook 只读待验', ['packages/adapters/src/fixture.ts'], ['fixtures','contracts']],
  'TASK-036': ['账号、环境、任务、运行详情、能力及总览工作台的本地流程', ['apps/web/components/workbench.tsx','apps/web/components/pilot-permit-form.tsx'], ['web','production']],
  'TASK-044': ['最小 D1 语义计数、D0 降级、导出权限/审计/白名单；其他驱动和截图未纳入', ['packages/core/src/reconciliation.ts','packages/core/src/index.ts'], ['unit','integration','web']],
  'TASK-065': ['首个 Graph/fixture URL 白名单、响应上限与 UUID profile 路径边界；附件尚待实施', ['packages/core/src/index.ts','packages/adapters/src/facebook.ts'], ['unit','contracts','fixtures']],
};
for (const card of ledger.tasks) {
  const value = scoped[card.task_id];
  if (value) {
    card.status = 'DONE_SCOPED'; card.scope = value[0]; card.outputs = value[1];
    card.actual_test_commands = checks.filter(check => value[2].includes(check.name)).map(check => ({ command: check.command.join(' '), exit_code: check.exit_code, test_count: check.test_count }));
    card.evidence_refs = ['docs/evidence/g1-local-checkpoint.json'];
  }
  if (['TASK-003','TASK-004','TASK-005'].includes(card.task_id)) { card.status = 'BLOCKED'; card.known_blockers = ['原 PDF/DOC/视频/旧追踪表未提供；不影响已授权的独立代码实现']; }
  if (['TASK-039','TASK-042','TASK-043'].includes(card.task_id)) { card.status = 'TODO'; card.known_blockers = ['用户已要求真实测试后置；未配置已授权主页、实际 API 版本和真实试验凭据，未取得真实结果']; }
  if (card.task_id === 'TASK-038') { card.status = 'IN_PROGRESS'; card.outputs = ['tests/browser/web/workflow.spec.ts','tests/browser/fixtures/agent-recovery.spec.ts','tests/browser/fixtures/executor.spec.ts','tests/integration/durability.test.ts','tests/integration/execution.test.ts']; card.evidence_refs = ['docs/evidence/g1-local-checkpoint.json']; card.known_blockers = ['所列本地故障已验；系统断网/掉电、不同宿主及完整外部接管矩阵仍需环境级验收']; }
  if (card.task_id === 'TASK-054') { card.status = 'TODO'; card.known_blockers = ['当前动作是自有主页文本发布，未实施联系动作；消息资格公共组件尚待实现']; }
}
ledger.updated_at = evidence.created_at; writeFileSync('docs/tasks/ledger.json', JSON.stringify(ledger,null,2) + '\n');
console.log(JSON.stringify({ total_tests: evidence.total_tests, checks: checks.length, full_delivery: false, source_tree_sha256: evidence.source_tree_sha256 }));
