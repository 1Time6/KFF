import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = {
  '项目规划.md': 'e4241d10aa291bec8024b5fdd22b60fbd6c4875fc1d40e6a1cb2a72155d2f58c',
  'docs/plans/项目规划_v1.0.md': '7b02f3a2d01e8823acbf7408604acfec50ad89066784d4c9921727e052f525cc',
  'docs/plans/KFF_项目规划_v2.0_Codex执行版.md': '0d1d89ad1be011007f80be88b554a0b26fc305fed1aff61850eb132ee7336d46',
};
for (const [file, expected] of Object.entries(files)) {
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) throw new Error('Planning source changed: ' + file);
}
const text = readFileSync('项目规划.md', 'utf8');
const tasks: { id: string; title: string; parent_id: string; gate: string; depends_on: string[]; scope: string; acceptance_ids: string[] }[] = [];
let gate = '';
for (const line of text.split(/\r?\n/)) {
  if (/^### 28\.[3-8] G[0-5]/.test(line)) gate = line.match(/G[0-5]/)![0];
  const match = line.match(/^\| <a id="task-\d{3}"><\/a>(TASK-\d{3}) (.+?)<br>(PLAN-[A-Z0-9-]+) \|/);
  if (!match) continue;
  const columns = line.split('|');
  tasks.push({ id: match[1], title: match[2], parent_id: match[3], gate, depends_on: [...new Set(columns[2].match(/TASK-\d{3}/g) ?? [])], scope: columns[3].trim(), acceptance_ids: [...new Set(columns[4].match(/ACC-\d{2}/g) ?? [])] });
}
if (tasks.length !== 134 || new Set(tasks.map(task => task.id)).size !== 134) throw new Error('Expected all 134 planning task definitions');
const ids = new Set(tasks.map(task => task.id));
for (const task of tasks) for (const dependency of task.depends_on) if (!ids.has(dependency)) throw new Error('Unknown dependency: ' + dependency);
const counts = Object.fromEntries(['G0','G1','G2','G3','G4','G5'].map(value => [value, tasks.filter(task => task.gate === value).length]));
if (JSON.stringify(Object.values(counts)) !== '[14,32,23,34,15,16]') throw new Error('Gate task counts differ');
const acceptance = [...text.matchAll(/^\| (ACC-\d{2}) \|/gm)].map(value => value[1]);
if (acceptance.length !== 72 || new Set(acceptance).size !== 72) throw new Error('Expected all 72 acceptance definitions');
for (const file of ['playwright.config.ts','vitest.config.ts','scripts/integration.ts','scripts/dev.ts','scripts/migrate.ts']) if (!existsSync(file)) throw new Error('Missing executable baseline: ' + file);
mkdirSync('docs/tasks', { recursive: true });
const ledgerPath = 'docs/tasks/ledger.json';
if (!existsSync(ledgerPath)) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cards = tasks.map(task => ({
    task_id: task.id, title: task.title, parent_id: task.parent_id, gate: task.gate, status: task.gate === 'G1' ? 'IN_PROGRESS' : 'TODO',
    scope: task.scope, authorized_objective: '按项目规划实施，Facebook 为首平台，真实测试后置', authorization_basis: '2026-09-12 当前会话用户指令',
    source_refs: ['项目规划.md#task-' + task.id.slice(5)], depends_on: task.depends_on, conditional_dependencies: {}, selected_contact_path: null, selected_content_source: task.gate === 'G1' ? 'single_text_version' : null,
    repository_commit_before: commit, allowed_files: task.gate === 'G1' ? ['apps/web/**','apps/worker/**','apps/agent/**','packages/**','supabase/migrations/**','scripts/**','tests/**','docs/**','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','eslint.config.mjs','vitest.config.ts','playwright.config.ts','.gitignore','.env.example'] : [],
    forbidden_changes: ['原始规划与归档内容','未获准的真实平台副作用','其他项目的主数据'], inputs: ['当前主规划 v2.1'], outputs: [], acceptance_ids: task.acceptance_ids,
    actual_test_commands: [], live_effects: 'none', pilot_permit_ref: null, rollback_plan: '停止本项目 Web/Worker/Agent，回退本任务代码提交；已提交动作保留未知并对账，已应用迁移不反向改写',
    known_blockers: [], evidence_refs: [], reviewer: 'Codex 实现；用户与独立审查尚未验收', next_task: null, continue_within_authorized_scope: true,
  }));
  writeFileSync(ledgerPath, JSON.stringify({ schema_version: 'kff.task-ledger.v1', generated_at: new Date().toISOString(), statement: '任务卡不是完成证明；TODO/IN_PROGRESS 不满足关口，真实验收均后置。', tasks: cards }, null, 2) + '\n');
}
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
if (ledger.tasks.length !== 134 || new Set(ledger.tasks.map((task: { task_id: string }) => task.task_id)).size !== 134) throw new Error('Incomplete task ledger');
for (const task of ledger.tasks) {
  if (!ids.has(task.task_id)) throw new Error('Ledger contains unknown task');
  if (task.status === 'DONE_SCOPED' && (!task.evidence_refs.length || !task.actual_test_commands.length || !task.outputs.length)) throw new Error('Missing evidence for ' + task.task_id);
}
console.log(JSON.stringify({ source_hashes_unchanged: true, task_count: tasks.length, acceptance_count: acceptance.length, gates: counts, product_acceptance: 'NOT_IMPLIED' }, null, 2));
verifyDefectLedger();

/**
 * The defect ledger is the single current work order. It is only useful while it stays consistent
 * with itself and with the repository, so this check fails loudly instead of letting the numbers
 * drift: counts are recomputed from the items, every referenced file must exist, an item claiming a
 * repair must carry a test or a recorded manual verification, and anything not fully closed must
 * say what is still open.
 */
function verifyDefectLedger() {
  if (!existsSync('docs/defect-ledger.json')) throw new Error('缺少当前缺陷台账 docs/defect-ledger.json');
  const ledger = JSON.parse(readFileSync('docs/defect-ledger.json', 'utf8')) as {
    schema_version: string;
    items: { id: string; status: string; category: string; changed_files: string[]; tests: string[]; unverified: string[]; verified_manually?: string[]; remaining_work?: string }[];
    counts: { work_items: number; by_category: Record<string, number>; by_status: Record<string, number> };
    relation_to_previous_audit: { rule: string };
  };
  if (ledger.schema_version !== 'kff.defect-ledger.v1') throw new Error('缺陷台账 schema_version 必须是 kff.defect-ledger.v1');
  const items = ledger.items;
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('缺陷台账存在重复编号');
  if (ledger.counts.work_items !== items.length) throw new Error(`台账 work_items=${ledger.counts.work_items} 与实际 ${items.length} 项不一致`);
  const tally = (key: 'category' | 'status') => items.reduce<Record<string, number>>((all, item) => ({ ...all, [item[key]]: (all[item[key]] ?? 0) + 1 }), {});
  for (const [key, declared] of [['category', ledger.counts.by_category], ['status', ledger.counts.by_status]] as const) {
    const actual = tally(key);
    for (const name of new Set([...Object.keys(actual), ...Object.keys(declared)])) {
      if ((actual[name] ?? 0) !== (declared[name] ?? 0)) throw new Error(`台账 ${key} 统计 ${name} 声明 ${declared[name] ?? 0} 与实际 ${actual[name] ?? 0} 不一致`);
    }
  }
  const statuses = new Set(['repaired_and_verified', 'partially_repaired', 'pending', 'blocked']);
  for (const item of items) {
    if (!statuses.has(item.status)) throw new Error(`${item.id} 状态无效：${item.status}`);
    if (!Array.isArray(item.unverified)) throw new Error(`${item.id} 必须显式记录未验证范围`);
    for (const file of [...item.changed_files, ...item.tests]) if (!existsSync(file)) throw new Error(`${item.id} 引用了不存在的文件：${file}`);
    if (item.status === 'repaired_and_verified' && !item.tests.length && !(item.verified_manually ?? []).length) throw new Error(`${item.id} 声明已修复验证，却没有测试或人工验证记录`);
    if (item.status === 'partially_repaired' && !item.remaining_work) throw new Error(`${item.id} 声明部分修复，必须写明剩余工作`);
    if (item.status !== 'repaired_and_verified' && !item.unverified.length) throw new Error(`${item.id} 未完全关闭，必须列出未验证或剩余项`);
  }
  if (!/NOT added|不与|不得/.test(ledger.relation_to_previous_audit.rule)) throw new Error('台账必须写明与旧审计的合计口径');
  console.log(`缺陷台账通过：${items.length} 项，均已登记状态、测试与未验证范围。`);
}
