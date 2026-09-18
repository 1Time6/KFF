const fs = require('node:fs');
const p = 'C:/Users/17731/Desktop/KFF-Audit-B00-20260917/findings.json';
const f = JSON.parse(fs.readFileSync(p, 'utf8'));

// 防止重复插入
f.findings = f.findings.filter(x => x.id !== 'KFF-B00-015');

f.findings.push({
  id: 'KFF-B00-015',
  title: '集成测试的数据库确已隔离,但运行目录仍落回真实项目 .kff/',
  severity: 'P3',
  status: 'CONFIRMED',
  historical_status: null,
  prior_audit_id: null,
  batch: 'B04',
  category: 'verification-integrity / test-isolation',
  file: 'scripts/integration.ts, tests/integration/local-supervision.test.ts, tests/integration/existing-database.test.ts',
  function: 'integration runner env injection / it(drains the actual Worker) / it(starts only an existing cluster)',
  line: 'scripts/integration.ts:13; tests/integration/local-supervision.test.ts:73,78; tests/integration/existing-database.test.ts:31',
  trigger_conditions: '运行 pnpm test:integration(或 node --import tsx scripts/integration.ts)执行整个集成套件',
  actual_behavior: '数据库隔离成立:scripts/integration.ts:13 向子进程显式注入 DATABASE_URL(指向 kff_test_<20hex>)与 KFF_TEST_DATABASE,退出码为 0 时 DROP 该库 —— 任何测试都不会写用户日常库。但同一行的 env 还把 KFF_ROOT 显式设为真实项目根 path.resolve(.)。于是 local-supervision.test.ts:78 用 env: process.env 派生的真实 Worker(apps/worker/src/main.ts)继承到 KFF_ROOT=真实根,其运行目录就是用户日常的 .kff/(会读取真实 .kff/agent-config.json);而同文件 L51 的 Agent 用例却把 KFF_ROOT 显式钉到临时目录 —— 同一文件内两个用例的环境一致性策略不一致。此外 local-supervision.test.ts:73 与 existing-database.test.ts:31 均以固定文件名把报告写进真实 .kff/checks/(local-supervision-agent-<mode>.json、existing-database.json),而该目录是仓库约定的共享证据目录(docs/tasks/ledger.json 的 --outputFile=.kff/checks/...、docs/api/database-recovery.md 的 backup-restore-UUID.json)。',
  expected_behavior: '集成测试的全部运行期写入(运行目录 + 证据报告)应限制在临时目录内;或至少在文档中明确声明本套件会写入真实 .kff/ 并要求先停用户日常 Worker。',
  root_cause: '隔离机制只覆盖了数据库这一维(DATABASE_URL/KFF_TEST_DATABASE),未覆盖运行目录维。KFF_ROOT 被显式设为真实根,本意是让测试读到真实 .kff/local-config.json,副作用是运行目录也一并落回真实根。',
  cross_module_effect: '若用户日常 Worker 正在运行,该用例会向同一 .kff/ 运行目录派生第二个 Worker。两者是否互斥取决于 Worker 侧是否持有 process.lock —— Agent 侧确有(apps/agent/src/main.ts),Worker 侧本轮未核实(见 CV-11)。',
  impact_scope: '仅影响测试与审计的可复现性/隔离性,不影响生产运行路径,不写用户日常库。需要强调的是:这是本轮判定「不能执行集成套件」的具体依据,而依据不是数据库。',
  minimal_reproduction: '只读静态事实,无需运行:scripts/integration.ts:13、tests/integration/local-supervision.test.ts:73,78、tests/integration/existing-database.test.ts:31。',
  evidence_path: '源码行号(本轮为静态核对,未运行该套件);.kff/checks/ 的实际内容本轮未读取(属用户工作区)。',
  probe_source: '静态核对;由迁移审计子代理提出的「test:contracts 是否触库」UNVERIFIED 项触发追查,追查中反转出本条。',
  existing_test_gap: '无任何测试断言「集成套件不得写入真实 .kff/ 运行目录」。',
  tests_to_add: '① 断言集成测试的全部运行期写入位于 mkdtemp 根内(目录快照比对,或对 KFF_ROOT 加守卫);② 若确需写入共享证据目录,断言文件名含 synthetic 或唯一后缀,以免覆盖既有报告。',
  minimal_fix: '把 local-supervision.test.ts:78 的 env 改为显式构造(与 L51 一致,把 KFF_ROOT 钉到临时根);两处报告写入改到临时根,或文件名加 -synthetic-<uuid> 后缀。',
  files_allowed_to_change: 'tests/integration/local-supervision.test.ts, tests/integration/existing-database.test.ts, scripts/integration.ts',
  dependencies: '无。',
  risk: '把 L78 的 KFF_ROOT 钉到临时根后,Worker 将读取临时根下的 agent-config.json;该文件可能不存在(临时根下只有测试自己建的内容),可能导致该用例直接失败 —— 这是修复前必须先验证的点。',
  rollback: '纯测试文件改动,git revert。',
  acceptance_criteria: '① 集成套件运行前后,真实 .kff/ 无新增或改动文件;② local-supervision 两个用例的 KFF_ROOT 处理一致;③ 该用例仍能验证 Worker 的 RUNNING→DRAINING→DRAINED 协议。',
  divergence_from_prior_audit: '前轮未记录。本轮先怀疑该用例会写用户日常库,随后被 scripts/integration.ts:13 的 DATABASE_URL 注入否证 —— 数据库隔离成立,故降级为 P3,并明确它不属于数据安全缺陷。'
});

// 新增 CV-11
if (!f.cannot_verify.some(c => c.id === 'CV-11')) {
  f.cannot_verify.push({
    id: 'CV-11',
    item: 'Worker 侧是否持有 process.lock(决定第二个 Worker 能否与用户日常 Worker 并存)',
    why: '本轮只静态确认 Agent 侧有 process.lock(apps/agent/src/main.ts),未读 Worker 侧源码,也未运行任何 Worker 进程。',
    not_a_bug: '无法核实的运行时行为。KFF-B00-015 的「派生第二个 Worker」后果因此标为未定。'
  });
}

// 计数全部重算,避免手写漂移
const sev = { P0: 0, P1: 0, P2: 0, P3: 0 };
const st = {};
for (const x of f.findings) {
  sev[x.severity] = (sev[x.severity] || 0) + 1;
  st[x.status] = (st[x.status] || 0) + 1;
}
f.counts = {
  P0: sev.P0, P1: sev.P1, P2: sev.P2, P3: sev.P3,
  total: f.findings.length,
  by_status: {
    CONFIRMED: st.CONFIRMED || 0,
    HIGH_CONFIDENCE: st.HIGH_CONFIDENCE || 0,
    NEEDS_RUNTIME_VERIFICATION: st.NEEDS_RUNTIME_VERIFICATION || 0
  },
  cannot_verify_items_not_counted_as_bugs: f.cannot_verify.length
};

const batches = {};
for (const x of f.findings) batches[x.batch] = (batches[x.batch] || 0) + 1;

fs.writeFileSync(p, JSON.stringify(f, null, 2));
console.log('counts  :', JSON.stringify(f.counts));
console.log('batches :', JSON.stringify(batches));
console.log('ids     :', f.findings.map(x => x.id).join(', '));
console.log('cv      :', f.cannot_verify.length);
