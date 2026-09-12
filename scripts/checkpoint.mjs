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
const files = [...new Set(execFileSync('git', ['ls-files','--cached','--others','--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/))].filter(file => /^(apps|packages|scripts|tests|supabase\/migrations)\//.test(file) && /\.(ts|tsx|mjs|sql|css|xlsx)$/.test(file)).sort();
const sourceHashes = Object.fromEntries(files.map(file => [file, sha(readFileSync(file))]));
const evidence = { schema_version: 'kff.checkpoint.v1', created_at: new Date().toISOString(), repository_commit_before: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(), source_tree_sha256: sha(JSON.stringify(sourceHashes)), source_hashes: sourceHashes, scope: 'G1/G2 当前实现及 G3 自有收件与客户基础本地回归；非完整关口、非真实 Facebook 验收', checks, total_tests: checks.reduce((sum, check) => sum + (check.test_count ?? 0), 0), real_platform_calls: 0, real_platform_verified: false, device_verified: false, full_delivery: false, shutdown_requested: false };
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/g1-local-checkpoint.json', JSON.stringify(evidence, null, 2) + '\n');
const ledger = JSON.parse(readFileSync('docs/tasks/ledger.json','utf8'));
const scoped = {
  'TASK-015': ['Next.js、原生 Postgres、Worker、Agent、构建和实际测试脚本', ['package.json','scripts/dev.ts','scripts/migrate.ts','apps/web/next.config.ts'], ['build','production']],
  'TASK-016': ['当前主页动作的 ID、协议、快照及拒绝未知字段合同', ['packages/contracts/src/index.ts'], ['contracts','unit']],
  'TASK-017': ['本机登录、角色、服务端品牌上下文与 RLS；Supabase 真实联调仍待执行', ['apps/web/lib/auth.ts','packages/database/src/index.ts','supabase/migrations/20260911164326_g1_execution_core.sql'], ['integration','production']],
  'TASK-018': ['首个主页动作的证据、版本、账号实例和运行模式求值；生产禁用未实测能力', ['packages/core/src/index.ts','packages/core/src/service.ts','packages/core/src/capabilities.ts'], ['unit','contracts','integration','web']],
  'TASK-019': ['绑定单任务快照、主页、动作、内容、窗口和上限的试验许可；真实授权实样待验', ['packages/contracts/src/index.ts','packages/core/src/permits.ts'], ['integration','web']],
  'TASK-021': ['不可变单条文本版本；附件不属于此已验证子范围', ['packages/core/src/service.ts'], ['integration','fixtures']],
  'TASK-022': ['单账号、自有主页、动作、内容及实现摘要的批准快照', ['packages/core/src/service.ts','packages/contracts/src/index.ts'], ['integration','contracts']],
  'TASK-023': ['单条任务并发创建、同体复用和异体冲突', ['packages/core/src/service.ts'], ['integration']],
  'TASK-024': ['当前动作状态机与合成未知结果后续核验', ['packages/core/src/index.ts','packages/core/src/reconciliation.ts'], ['unit','integration','web']],
  'TASK-025': ['同库原子投递；真实调用进程与 Worker 在提交前后终止、重启后的业务意图不丢失不重复', ['packages/core/src/service.ts','packages/core/src/execution.ts','tests/integration/durability.test.ts'], ['integration']],
  'TASK-026': ['Postgres 账号/环境租约、token、并发派发、单 Agent 执行槽及过期隔离', ['packages/core/src/execution.ts','supabase/migrations/20260911175746_g1_agent_slot_guard.sql'], ['integration']],
  'TASK-027': ['稳定动作与尝试、事务内提交意图、本地持久日志；进程恢复保留原意图且不自动重做', ['packages/core/src/execution.ts','apps/agent/src/main.ts','tests/browser/fixtures/agent-recovery.spec.ts'], ['integration','fixtures']],
  'TASK-028': ['组织、品牌、账号与任务停止；与提交锁排序协调、展示在途数量；未领取命令有未启动证明', ['packages/core/src/controls.ts','packages/core/src/execution.ts','apps/web/components/workbench.tsx'], ['integration','web']],
  'TASK-029': ['作用域配对文件、令牌仅首次下载、Agent 排空与不可逆撤销；远程宿主联调未验', ['packages/core/src/controls.ts','apps/web/components/executor-controls.tsx','apps/agent/src/config.ts'], ['integration','web']],
  'TASK-030': ['本机持久 journal、独立关闭证明；重启和确认连接丢失后使用同一事件，不重做旧命令', ['apps/agent/src/main.ts','apps/agent/src/guardian-protocol.ts'], ['fixtures','integration']],
  'TASK-031': ['ENV-L1 独立 Chromium profile 的任务内启动与关闭、存储隔离', ['packages/adapters/src/fixture.ts'], ['fixtures']],
  'TASK-032': ['Windows 单槽 guardian、父进程终止/卡住后关闭、缺证明继续隔离；其他宿主与外部人工接管未验', ['apps/agent/src/guardian.ts','apps/agent/src/guardian-child.ts','tests/browser/fixtures/agent-recovery.spec.ts'], ['fixtures','integration','web']],
  'TASK-033': ['D0 v2 协议、适配器与执行器版本、尝试、状态、步骤、错误、耗时白名单；兼容旧导出', ['packages/core/src/index.ts','packages/core/src/reconciliation.ts','apps/agent/src/main.ts'], ['unit','integration','web']],
  'TASK-034': ['本项目合成页、故障场景与非白名单请求阻断', ['scripts/fixture-server.ts','tests/browser/fixtures/executor.spec.ts'], ['fixtures']],
  'TASK-035': ['合成页面的单一身份读取及身份错误拒绝；真实 Facebook 只读待验', ['packages/adapters/src/fixture.ts'], ['fixtures','contracts']],
  'TASK-036': ['账号、环境、任务、运行详情、能力及总览工作台的本地流程', ['apps/web/components/workbench.tsx','apps/web/components/pilot-permit-form.tsx'], ['web','production']],
  'TASK-037': ['原合成提交后续核验；管理员按快照与版本记录不可变人工裁定，证据不足保持待人工；原动作不重发、来源不冒充机器核验；真实只读对账命令仍待接入', ['packages/core/src/reconciliation.ts','packages/core/src/adjudication.ts','packages/contracts/src/adjudication.ts','apps/web/components/action-adjudication.tsx','tests/integration/adjudication.test.ts'], ['integration','web']],
  'TASK-041': ['单动作试验次数及最大成本原子预占与重放去重；未知保留费用，释放不退试验次数', ['packages/core/src/permits.ts','packages/core/src/costs.ts','tests/integration/execution.test.ts'], ['integration']],
  'TASK-044': ['最小 D1 语义计数、D0 降级、导出权限/审计/白名单；其他驱动和截图未纳入', ['packages/core/src/reconciliation.ts','packages/core/src/index.ts'], ['unit','integration','web']],
  'TASK-047': ['查询/分页公共合同；当前来源仅本项目合成主页，固定目标、字段、用途、上限、显示时区和保留期；真实来源未接入', ['packages/contracts/src/collection.ts','packages/adapters/src/collection-fixture.ts','tests/contracts/collections.test.ts'], ['contracts','integration']],
  'TASK-049': ['字符串 ID、空值/隐藏/未返回/零、账号与来源范围内身份去重、不可变观察版本；真实来源样本尚待验收', ['packages/contracts/src/collection.ts','packages/core/src/collections.ts','tests/integration/collections.test.ts'], ['contracts','integration','web']],
  'TASK-050': ['同库查询队列、分页/观察/结果/游标一致提交、进程终止恢复、旧 token 拒绝、循环/过期明确停止；当前合成来源验证', ['packages/core/src/collections.ts','supabase/migrations/20260911203355_g2_collection_checkpoints.sql','tests/helpers/collection-process.ts','tests/integration/collections.test.ts'], ['integration','web']],
  'TASK-051': ['CSV/XLSX 上传、受限解析、映射/逐行预览、错误排除确认、来源去重、精确字段/对象导出与文本 ID 往返；人工来源独立，原文件权限与到期清理已验', ['packages/contracts/src/imports.ts','packages/core/src/imports.ts','packages/core/src/import-parser.ts','scripts/import-parser.mjs','packages/core/src/import-mapping.ts','packages/core/src/collection-export.ts','apps/web/components/import-workbench.tsx','apps/web/components/collection-export.tsx','supabase/migrations/20260911213439_g2_import_export.sql','tests/fixtures/import-fixture.xlsx','tests/integration/imports.test.ts','tests/browser/web/imports.spec.ts'], ['contracts','integration','web','production']],
  'TASK-052': ['查询配置、实际进度、结果分页、观察历史、部分/失败/空结果与保留期展示；人工导入、精确导出及服务端 ID/正文/作者/计数/状态筛选；真实覆盖待后续', ['apps/web/components/collection-workbench.tsx','apps/web/components/collection-targets.tsx','apps/web/components/collection-export.tsx','packages/core/src/collections.ts','packages/core/src/collection-filter.ts','tests/browser/web/workflow.spec.ts','tests/browser/web/imports.spec.ts','tests/browser/web/target-snapshots.spec.ts'], ['integration','web']],
  'TASK-053': ['当前页、跨页手选及全部筛选显式预览；固定对象/观察/字段/用途与排除原因，保存、撤销、到期清理和固定导出；具体任务执行联调待后续', ['packages/contracts/src/target-selection.ts','packages/core/src/collection-filter.ts','packages/core/src/target-snapshots.ts','packages/core/src/collection-export.ts','apps/web/components/collection-targets.tsx','supabase/migrations/20260911221017_g2_target_snapshots.sql','tests/contracts/target-selection.test.ts','tests/integration/target-snapshots.test.ts','tests/browser/web/target-snapshots.spec.ts'], ['contracts','integration','web','production']],
  'TASK-054': ['联系依据、用途与显式窗口、退出/新同意、不可变选择及事务内复核；账号页管理入口；具体消息执行门槛尚待接入', ['packages/contracts/src/contact.ts','packages/core/src/contacts.ts','apps/web/components/contact-permissions.tsx','supabase/migrations/20260911185039_g1_contact_eligibility.sql'], ['integration','web']],
  'TASK-057': ['当前四种主页动作的不可变模板、输入/关联预演、允许集合、固定任务版本和弃用边界；原结果继续核验；任意流程编辑器及真实版本试验未验', ['packages/contracts/src/template.ts','packages/core/src/templates.ts','packages/adapters/src/templates.ts','apps/web/components/template-workbench.tsx','supabase/migrations/20260911200056_g2_template_versions.sql','tests/integration/templates.test.ts'], ['contracts','integration','fixtures','web']],
  'TASK-059': ['IANA 时区、一次/每日/每周有限日期规则、明确重复/缺失时刻、错过跳过/仅延后最近一次/限量补准备；不可变版本、暂停恢复/终止、UTC 时点与游标原子保存、崩溃恢复；实际任务与预算执行门槛待 TASK-060 联调', ['packages/contracts/src/schedule.ts','packages/core/src/schedule-rules.ts','packages/core/src/schedules.ts','apps/web/components/schedule-workbench.tsx','supabase/migrations/20260911224129_g2_schedule_rules.sql','tests/unit/schedule-rules.test.ts','tests/contracts/schedule.test.ts','tests/integration/schedules.test.ts','tests/helpers/schedule-process.ts','tests/browser/web/schedules.spec.ts'], ['unit','contracts','integration','web','production']],
  'TASK-061': ['单槽动作费用预占、按币种的显式预算和精度、未知保留、人工结算/释放/差异调整及工作台；释放不退试验次数，继续执行复查预算；批次和多品牌公平调度未验', ['packages/contracts/src/cost.ts','packages/core/src/costs.ts','apps/web/components/cost-ledger.tsx','supabase/migrations/20260911190913_g2_cost_ledger.sql','tests/integration/costs.test.ts'], ['integration','web']],
  'TASK-065': ['Graph/fixture URL 白名单与 UUID profile 路径；CSV/XLSX 原始上传上限、格式/编码/ZIP/XML 约束、无凭据限时限堆解析进程已验；媒体专有边界待后续', ['packages/core/src/index.ts','packages/adapters/src/facebook.ts','packages/core/src/import-parser.ts','scripts/import-parser.mjs','tests/integration/imports.test.ts'], ['unit','contracts','integration','fixtures','production']],
  'TASK-078': ['KFF 自有站内端点、同源与随机访客令牌鉴权、持久配额、共用事件表及落库后确认；重复/乱序/伪造/存储失败和进程中断已验；公网及外部平台入口未验', ['packages/contracts/src/inbox.ts','packages/core/src/inbox.ts','apps/web/lib/visitor-auth.ts','apps/web/app/api/[[...path]]/route.ts','supabase/migrations/20260911235946_g3_owned_inbound.sql','tests/integration/inbox.test.ts','tests/helpers/inbound-process.ts'], ['contracts','integration','web','production']],
  'TASK-079': ['品牌/自有渠道/服务端访客身份映射、消息去重与服务器顺序、显式客服窗口、退出后不自动恢复；同名/同外部 ID 跨渠道品牌保持分离；外部平台身份合同未验', ['packages/contracts/src/inbox.ts','packages/core/src/inbox.ts','supabase/migrations/20260911235946_g3_owned_inbound.sql','tests/integration/inbox.test.ts'], ['contracts','integration','web','production']],
  'TASK-087': ['按用户独立主数据决定从主动咨询原子建客户，渠道身份、品牌成员负责人、阶段/依据、不可变备注及时间线；人数与消息区分、未知获客来源和未核实支付显式保留；合并/订单完整时间线待后续', ['docs/decisions/017-independent-business-data.md','packages/core/src/inbox.ts','apps/web/components/customer-workbench.tsx','tests/integration/inbox.test.ts','tests/browser/web/inbox.spec.ts'], ['integration','web','production']],
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
  if (card.task_id === 'TASK-054') { card.selected_contact_path = 'basis_component_only'; card.known_blockers = ['当前 E1 是主页发布；具体消息动作仍需将此依据检查接入共同平台能力、审核、预算、租约与组织停止门槛。采集来源扩展和真实消息验收未完成']; }
  if (card.task_id === 'TASK-061') { card.known_blockers = ['本次仅单槽费用基础；真实账单提供方、旧数据实样迁移验收、批次与多品牌公平调度在对应后续范围验收']; }
  if (card.task_id === 'TASK-057') { card.known_blockers = ['当前只支持已有四种固定主页动作与输入约束；任意流程编辑器、新动作及真实版本小流量试验待后续验收']; }
  if (card.task_id === 'TASK-059') { card.known_blockers = ['当前只交付规则与持久时点准备，execution_authorized=false；实际任务绑定、完整批准与预算复核、在途任务控制及真实平台定时执行待 TASK-060 和对应任务联调，不计完整 ACC-34/68 通过']; }
  if (['TASK-047','TASK-049','TASK-050','TASK-052'].includes(card.task_id)) { card.known_blockers = ['当前自动来源仅本项目合成页；人工文件、结果筛选与精确目标快照已独立实现；真实 Facebook 来源合同与受控试验、结果转具体任务待后续实现/验收']; }
  if (card.task_id === 'TASK-053') { card.known_blockers = ['当前只冻结数据准备与导出范围，execution_authorized=false；具体对象语义、动作和联系资格的任务门槛及 TASK-060/068 联调仍待完成，未进行真实平台验收']; }
  if (card.task_id === 'TASK-051') { card.known_blockers = ['CSV/XLSX 本地文件流程已验；未使用真实客户文件或 Microsoft Excel 应用验收，不覆盖旧版 .xls、宏及外链工作簿；真实来源专有许可、备份和下载副本治理由对应任务验收']; }
  if (card.task_id === 'TASK-037') { card.known_blockers = ['人工裁定当前已验合成样本；真实 Graph 只读对账命令、等待策略与实际平台证据仍待实施/实测，不计真实通过']; }
  if (['TASK-078','TASK-079','TASK-087'].includes(card.task_id)) { card.selected_contact_path='site_chat';card.evidence_refs.push('docs/decisions/017-independent-business-data.md','docs/tasks/g3-owned-inbound.md');card.known_blockers=['当前仅 KFF 自有入站与客户基础；公网部署、外部平台收件、人工回复/接管、完整身份纠错与订单关联在对应任务继续实施或验证']; }
  if (['TASK-082','TASK-092'].includes(card.task_id)) { card.status='IN_PROGRESS';card.selected_contact_path='site_chat';card.outputs=['apps/web/components/inbox-workbench.tsx','apps/web/components/visitor-chat.tsx','apps/web/app/chat/[channelId]/page.tsx','tests/browser/web/inbox.spec.ts'];card.evidence_refs=['docs/evidence/g1-local-checkpoint.json','docs/api/inbox.md'];card.known_blockers=['已交付自有收件/访客会话、历史与客户跳转；人工发送与会话控制权尚未接入，不计完整收件箱或聊天接待分支验收通过']; }
}
ledger.updated_at = evidence.created_at; writeFileSync('docs/tasks/ledger.json', JSON.stringify(ledger,null,2) + '\n');
console.log(JSON.stringify({ total_tests: evidence.total_tests, checks: checks.length, full_delivery: false, source_tree_sha256: evidence.source_tree_sha256 }));
