# executive-summary.md — B00 独立审计执行摘要

| 项 | 值 |
|---|---|
| **审计 SHA（冻结）** | `752042bc466b10b07cad455757a41bb10bbaf39f` |
| 分支 | `codex/facebook-foundation` |
| `origin/main` | `e1f5285c6cdd3089515cd4edce2746179a137465`（未变） |
| 包版本 | `0.1.53` |
| 审计日期 | 2026-09-17 |
| 审计性质 | **只读 + 隔离复现**。未改一行正式业务代码 |

---

## 1. 结论（一句话）

**未发现 P0。发现 3 个 P1，其中 1 个正在阻塞主业务链且重启不自愈；另有一个「修得不完整、且不完整本身也不可见」的结构性闭环，是本轮最有价值的系统性结论。安全侧（越权 / 注入 / 边界）未发现实质缺陷。**

---

## 2. 缺陷计数

| 严重性 | 数量 |
|---|---|
| **P0** | **0** |
| **P1** | **3** |
| **P2** | **8** |
| **P3** | **4** |
| **合计** | **15** |

| 状态 | 数量 |
|---|---|
| `CONFIRMED` | **14** |
| `HIGH_CONFIDENCE` | **1** |
| `NEEDS_RUNTIME_VERIFICATION` | **0** |

**`CANNOT_VERIFY` 共 11 项，按要求不计入 Bug 数**（见 `findings.json` 的 `cannot_verify`）。

---

## 3. 三个 P1

### ① `KFF-B00-002` — Guardian error 分支永久阻塞主链，且**重启不自愈**（最严重）

`apps/agent/src/guardian.ts`：`spawn` 派生失败（实测用不存在 cwd 制造 libuv ENOENT）只发 `error`+`close`，**从不发 `exit`**，而全部终止证据逻辑都挂在 `exit` 上。后果是 journal 永久停在 `phase:'claimed'` 无 closure → `main.ts:82` 每次返回 false → 无限 `GUARDIAN_UNCONFIRMED`。

- **已双次复现**（`evidence/guardian-probe.json`，run1/run2 一致），`controller_calls_made: []`——控制端全程未被通知，**无法自行发现**。
- `main.ts:73` 的 `await flushJournal()` 位于 `try/finally` **之外**，拒绝时被跳过，是第二个独立成因。
- ⛔ **修复工单必读**：`agent_single_execution_slot` 是部分唯一索引（`agent_commands(agent_id) WHERE state IN ('READY','CLAIMED')`），卡死命令**同时占住应用层门与数据库槽位**，因此**不能靠插入补偿命令绕过**——必须先把卡死命令移出 `CLAIMED`。

### ② `KFF-B00-001` — 退订判定**两个方向都错**

`packages/adapters/src/reception-model.ts`，40 条断言实测 9 条不符：

- **漏判**（客户说「别再联系我」仍继续接待）：中文弯引号 U+2019 使 `Please don’t contact me again.` 判为 `ASK_QUESTION`；`Don't message me again.`、`No more messages please.` 同样漏判。
- **误判**（客户说「请继续联系我」被判退订）：`Please don't stop messaging me.` / `Do not stop texting me.` → **STOP**，而命中后 `core/facebook-inbound.ts:105-110` **直接写库** `stage=BLOCKED / OPTED_OUT / PAUSED` —— **写库不可自动回滚，客户资产永久损失**。
- 根因是**同一文件内规则不一致**：`bareStop` L48 有 `dontstop|donotstop` 否定守卫，`optOut` 没有。
- ⚠️ 既有测试为何没发现：`tests/contracts/reception-model.test.ts:40` 用例名声称 "keeps a marketing-only Chinese opt-out **for human review**"，**断言却只有一句 `toBe(false)`** —— 名称声称的行为无任何断言。

### ③ `KFF-B00-006` — 限定类型拒绝 → AI 继续接触

「不要再给我发广告了」→ `ASK_QUESTION`。且 `core/reception-worker.ts:70` 除少数分支外**一律 `queueConversationReply`**，所以这**不是纯规则问题，会实际排出一条回复**。修复方向取决于规划侧的 **Q1**（是否按退订处理）。

---

## 4. 本轮最有价值的系统性结论

**`KFF-B00-004` + `KFF-B00-005` 构成一个闭环：缺陷修得不完整，而且「不完整」这件事本身也不可见。**

- **004**：`guardian.ts:19-28` 的故障注入开关导出与注释声称 "Exported for the unit contract that pins every condition this switch must satisfy"，但 `tests/` 下对 `guardianStartupFaultInjection`、`saveStartupFailure`、`KFF_TEST_GUARDIAN_DIES_BEFORE_READY`、`GUARDIAN_STARTUP_FAILED`、`compactClosure`、`startup-failed` 的**命中数全部为 0**——spec 因未能激活被撤回，导出与注释留在源码。其中一条是**安全边界**（必须用 `path.relative` 判定以封死 `.kff/agent-process-tests-production` 这类兄弟目录），**无任何测试保护**。
- **005（历史状态 `REGRESSED`）**：`docs/current-status.md` 自称唯一接手指引，却声明 `891f399a…`——落后 HEAD 3 个提交，且是**审计基线 `e1f5285` 的父提交**，即该页描述的树比被审基线**还早一代**；它只指向 round1 台账，声称「25 项已全部修复并验证」，而 round2 台账自述外部审计**只能核实 3 项**。根因：`scripts/verify-planning.ts` **只校验台账 schema，从不读取 `current-status.md`**，因此该页变陈旧时**没有任何检查会失败**。

> 为什么这比单条缺陷更重要：round1 修过同一类缺陷并标为 `repaired_and_verified`，但它加的检查校验的是**台账内部一致性**，不是**入口页的基线**——于是同一缺陷类**复发而无人知晓**。这也解释了 002 为何能长期潜伏。

---

## 5. 安全侧结论（未发现实质缺陷）

| 检查项 | 裁定 |
|---|---|
| HTTP 入口绕过 | ❌ 未发现。单一 catch-all 路由，任何非 chat/agent 路径都先经 `requestScope()` |
| 越权 / IDOR / BOLA | ❌ **未发现实例**。`requestScope` 从 `kff.memberships` 推导 org/brand/role，**从不取自请求体** |
| RLS 有效性 | ✅ 设计正确。88/91 表启用，3 个豁免（`local_users`/`sessions` 为作用域前身份表、`adapter_artifacts` 为无租户列的全局注册表）**均有正当理由**；缺 `FORCE ROW LEVEL SECURITY` 经分析**不是缺陷**（`kff_app` 非 owner 且 `NOBYPASSRLS`） |
| 授权模型 | ✅ 最小权限，且有亮点：对 4 张审计/批准/证据表 `REVOKE UPDATE` |
| 迁移基础设施 | ✅ 可靠：advisory lock + sha256 篡改检测 + 单事务原子性 + 幂等守卫；零非事务性 DDL；**无任何破坏性操作**（`DROP TABLE/COLUMN/DELETE FROM` 全零命中） |
| 真实浏览器外发 | ✅ **四重封堵**（`auto_reply` 必须关闭 → `canReply` → `conversationControl` → `queueConversationReply` 的 `prepare_only && HUMAN`），设计正确 |

**两点必须同时说明，否则会被误读：**

1. **RLS 只在 `scoped()` 路径生效**（`SET LOCAL ROLE kff_app`，`database/src/index.ts:21`）。`query()`/`transaction()` 完全不生效。实测分布：`scoped()` 190+ 处（合法），裸 `transaction()` 32 处（全部为 worker 跨租户认领），裸 `query()` 14 处（全部为作用域前解析）——**逐点核查未发现误用**。但**不存在任何自动检查能发现新增的误用**（KFF-B00-013）。
2. **四重封堵的代价**：接待类规则缺陷（001/006/008）在真实浏览器试点路径上**不可能被端到端测试暴露**。因此「真实路径已验收」**不能**作为这些规则的证据。

---

## 6. 证据强度：最薄弱的地方

**真实发送能力是全项目最关键的能力，也是证据最薄的。**

| 事件 | 结果 |
|---|---|
| 2026-09-13 首次真实发送 | ❌ 未自动验证 → `UNKNOWN_OUTCOME` → 人工裁定 |
| 解析器修复后 | ✅ **1 次**自动验证成功（`remote_id` 已记录，耗时 28850ms） |
| 后续真实运行 | ❌ fail-closed：`BLOCKED / INBOX_SOURCE_MISMATCH` |

**全项目历史上只有 1 次自动验证成功的真实发送。** 任何「真实发送链路已通」的说法若不限定为「1 次」即为过度概括。

本轮**未新增任何 `REAL_EVIDENCE`**（未触碰真实 Facebook / WhatsApp / Stripe）。`feature-matrix.md` 中的 `REAL_EVIDENCE` 全部是仓库内既存证据的归档核对。

---

## 7. 本轮**未**做的事（边界声明）

| 未做 | 原因 |
|---|---|
| 修改任何正式业务代码 / commit / push / merge / deploy | 用户明令 |
| **运行集成测试套件** | **无法证明与用户日常环境隔离**——依据见 `KFF-B00-015`：数据库确已隔离（`scripts/integration.ts:13` 注入 `DATABASE_URL`），但同一行把 `KFF_ROOT` 设为**真实项目根**，`local-supervision.test.ts:78` 会用真实运行目录派生真实 Worker |
| 数据库层测试 M1–M8 | 同上，需数据库实例 |
| 真实 Facebook / WhatsApp / Stripe 任何操作 | 用户明令 |
| 任何 `dist/` 写操作 | 属对用户环境的实质改动 |

**本轮的实测证据仅来自**：纯函数探针（`probe-reception.ts`，40 断言）、进程级探针（`probe-guardian.ts` / `-2.ts` / `probe-journal.ts`，覆盖 `process.cwd` 制造真实 ENOENT，不打补丁、不引入第二套执行系统）、以及静态源码核对。全部在仓库外的审计目录内运行。

---

## 8. 是否需要规划侧先决策

| # | 待决问题 | 阻塞 |
|---|---|---|
| **Q1** | 「限定类型的拒绝」（「不要再给我发广告了」）应路由到 **HANDOFF** 还是升级为**全局退订**？ | `KFF-B00-006` 修复方向 |
| **Q2** | 真实 Messenger 输入框的 **role 实际是什么**（textbox / combobox / 无 role）？ | `KFF-B00-011` 修复方向。**仓库内无此证据（CV-09）**——缺此事实就改定位器，等于用猜测替换猜测 |
| **Q3** | 已写库的 `OPTED_OUT` 是否需人工复核？ | `KFF-B00-001` 验收条件之一 |

---

## 9. 是否建议进入 B01

**建议进入 B01，但按以下顺序：**

1. **`KFF-B00-002`** —— 唯一影响**可用性**的 P1，且重启不自愈。必须先修行为。
2. **`KFF-B00-004`** —— **紧随其后**，固化 002 的修复。⚠️ **顺序不可颠倒**：先补测试会把当前错误行为固化成断言。
3. **`KFF-B00-003`** —— 同属启动失败证据链，与 004 同批。
4. **`KFF-B00-001`** —— P1，误判方向永久丢弃客户资产；纯函数、无迁移，成本低。
5. `KFF-B00-006`（待 Q1）；`KFF-B00-005` **建议在 B01 代码合并后定稿**，否则声明的 SHA 立即再次漂移。

**不建议**在 B01–B03 闭合前进入 B05 双账号试点。前置条件见 `repair-plan.md` B05-1。

---

## 10. 九项交付物

| # | 文件 | 内容 |
|---|---|---|
| 1 | `baseline.md` | 身份自验证（git remote / branch / SHA / 本地运行时身份） |
| 2 | `module-map.md` | 模块地图、三个信任边界、风险热图 |
| 3 | `test-results.md` | 本轮实测记录（command / SHA / cwd / 退出码 / 证据路径） |
| 4 | `findings.json` | 15 条发现，字段齐全（含最小复现、证据路径、验收条件、回退方式） |
| 5 | `historical-regression.md` | 前轮状态复核（FIXED / PARTIALLY_FIXED / REGRESSED / CANNOT_VERIFY） |
| 6 | `migration-audit.md` | 33 个迁移逐条、RLS 判定、双路径发现、M1–M8 建议 |
| 7 | `feature-matrix.md` | 优先链逐节标签化 + 证据等级统计 |
| 8 | `repair-plan.md` | B01–B05 规划（**本轮不执行**） |
| 9 | `executive-summary.md` | 本文件 |

### 实测证据路径

| 路径 | 内容 |
|---|---|
| `repro/probe-reception.ts` | 退订规则探针（40 断言） |
| `repro/probe-guardian.ts` / `probe-guardian-2.ts` | Guardian 启动失败 / closure 协议探针 |
| `repro/probe-journal.ts` | journal 可达性探针 |
| `evidence/reception-probe.json`（+`-run2`） | 接待规则双次一致结果 |
| `evidence/guardian-probe.json`（+`-run2`） | Guardian ENOENT 双次一致结果 |
| `evidence/guardian-probe-2.json` | closure 压缩抹除 startup-failed |
| `evidence/journal-probe.json` | journal 门行为 |
| `logs/*.err` | 探针原始 stderr |

> 全部位于 `C:\Users\17731\Desktop\KFF-Audit-B00-20260917\`（**仓库之外**）。仓库工作树本轮全程干净，未产生任何 commit。

---

## 11. 停止

按用户指示，B00 到此结束。**未进入 B01，未改正式业务代码，未 commit / push / merge / deploy，未进行任何真实 Facebook / WhatsApp / Stripe 操作。**
