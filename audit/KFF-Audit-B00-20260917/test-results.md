# test-results.md — B00 测试与验证结果记录

**AUDIT SHA（贯穿全部记录）：`752042bc466b10b07cad455757a41bb10bbaf39f`**

生成时间：2026-09-17

---

## 0. 记录规则（本轮自我约束）

1. **修复侧的历史数字与本轮的执行结果分开列记**（见第 1 节与第 4 节）。本轮**不重复引用** round2 的 374 / 412 / 131 作为本轮结论。
2. **未执行的套件一律写「未执行」，不写「通过」**（见第 3 节）。
3. 本轮**没有改造任何仓库内测试**：未删除、未 skip、未放宽断言、未反复重跑以取一次绿色。全部新证据来自审计方自建探针（`repro/`，位于仓库之外），探针以 `file:///` 动态 import 被审 SHA 的**真实源文件**执行，不复制也不改写被测逻辑。
4. 每条记录给出：命令 / SHA / cwd / Node / pnpm / 数据库 / 相关 env / 退出码 / 通过-失败-跳过 / 耗时 / 产物路径。

---

## 1. 修复侧历史数字（**不是**本轮结果，仅供对照）

来源：`docs/evidence/audit-repair-round2-20260917.json`（round2 自述）

| 项目 | 自述值 |
|---|---|
| 声明的分支 / 基线 | `codex/facebook-foundation` / `e1f5285c…` |
| package_version | `0.1.53` |
| `npx tsc --noEmit` | exit 0，no diagnostics |
| `npx vitest run tests/unit tests/contracts` | exit 0，53 files / 374 tests passed（本轮之前为 53 files / 333 tests） |
| `npx tsx scripts/integration.ts` | exit 0，38 files / 412 tests passed，隔离数据库 |
| `npx playwright test --project=fixtures` | exit 0，131 tests passed |
| 记录机器 | Windows，node v24.14.1 |

**本轮对该证据链的两点保留**：

1. **该证据不可从仓库独立复现。** 该文件 L37 自述：
   > "the raw command output was kept only under the ignored .kff/checks directory, so it is deliberately not referenced here; the results above are the recorded summary"

   原始输出位于被 gitignore 的目录且未被引用，因此仓库内只存在**记录摘要**，不存在可重放的原始证据。本审计**采信其为历史声明**，不采信为本轮结论。

2. **该轮无 release_id、无部署、无 CI。** 同一文件 L9 自述 "no release_id is claimed for them, because no package was built or deployed from this round"；L73 自述 "no CI run is associated with this commit"。故以上数字描述的是**工作树**，不是任何现场产物。

**与本轮实测的交叉核对（已执行）**：round2 声称 R01 关闭的案例（`Please don't stop.`、`When will these problems stop?`、`Where is the bus stop`、`我希望不要再发生这种事。`）本轮全部复测，**确认已修复**。但同一规则族仍存在新形态缺陷（见 KFF-B00-001）。故 R01 判定为 PARTIALLY_FIXED。

---

## 2. 本轮实际执行（审计方探针）

全部探针位于 `C:\Users\17731\Desktop\KFF-Audit-B00-20260917\repro\`，**不写入被审仓库**。

### 2.1 执行环境（所有探针共用）

| 项目 | 值 |
|---|---|
| Node | `v24.14.1` |
| pnpm | **PNPM_NOT_FOUND**（仅 corepack `0.34.6`）—— 本轮未执行 `pnpm install` |
| 调用方式 | `node_modules\.bin\tsx.cmd`（直接调用仓库已布置的二进制，未安装、未改动 lockfile） |
| cwd | `C:\Users\17731\Desktop\KFF`（仓库根） |
| 数据库 | **未连接任何数据库** |
| 网络 | **未发起任何外部请求**（无模型调用、无 Facebook、无 AdsPower、无 Stripe） |
| 浏览器 | **未启动任何浏览器** |
| 相关 env | 探针未设置 KFF_* 环境变量；`KFF_TEST_GUARDIAN_DIES_BEFORE_READY` 仅在 guardian 探针实验 3 的**子进程内存中**临时设置并随即删除（见 2.3） |
| 仓库工作树 | `git status --porcelain` 全程为空 |

### 2.2 第一轮执行

| # | 探针 | 命令 | exit | 耗时 | 产物 |
|---|---|---|---|---|---|
| 1 | 接待规则 | `node_modules\.bin\tsx.cmd <AUDIT>\repro\probe-reception.ts` | **0** | 1s | `evidence\reception-probe.json`（9,695 B） |
| 2 | Guardian | `…\probe-guardian.ts` | **0** | 6s | `evidence\guardian-probe.json`（3,206 B） |
| 3 | Guardian 边界 | `…\probe-guardian-2.ts` | **0** | 1s | `evidence\guardian-probe-2.json`（704 B） |
| 4 | Journal 只读分析 | `…\probe-journal.ts` | **0** | 1s | `evidence\agent-journal-analysis.json`（583 B） |

**失败 0 / 跳过 0 / 全部 exit 0。** 四个探针的 stderr 文件字节数均为 **0**（无警告、无未处理拒绝）。

### 2.3 第二轮执行（可复现性验证）

同一组探针**再次独立运行**，产物另存为 `*-run2.json`：

| # | 探针 | exit | 耗时 | 产物 |
|---|---|---|---|---|
| 1 | 接待规则 | **0** | 1s | `evidence\reception-probe-run2.json` |
| 2 | Guardian | **0** | 6s | `evidence\guardian-probe-run2.json` |
| 3 | Guardian 边界 | **0** | 1s | `evidence\guardian-probe-2-run2.json` |
| 4 | Journal | **0** | 1s | `evidence\agent-journal-analysis-run2.json` |

**两轮一致性比对结果（逐字比对，非目测）：**

| 比对项 | 结果 |
|---|---|
| reception：40 条 case + filter_case 的 `text\|exit\|action` 序列 | **完全一致** |
| reception：`marketing_refusal` 块 | **完全一致** |
| guardian：决定性事实（事件种类、是否发 exit、启动失败记录是否写入、flush 返回值、controller 调用次数、拒绝码、开关状态、proof 协议版本、compact 后 context_closed、readClosure 结果） | **完全一致** |
| guardian-2：全部字段 | **完全一致** |
| journal：条目数 399 / 滞留 0 / closure 386 / startup-failed 0 | **完全一致** |

> 说明：guardian 探针的原始 JSON 包含时间戳与随机 UUID，逐字节比对必然不同；因此上表比对的是**决定性事实字段**，而非整文件。guardian-2 与 journal 探针不含时间戳，为逐字节一致。

**结论：全部探针结果可重复复现。**

---

## 3. 未执行的套件（**不是通过，是未执行**）

| 套件 | 状态 | 未执行原因 |
|---|---|---|
| `pnpm test:unit` | **未执行** | 见下方 3.1 |
| `pnpm test:contracts` | **未执行** | 同上 |
| `pnpm test:integration` | **未执行** | 见 3.1a：隔离机制**存在且有效**，但本机没有可用的 PostgreSQL 实例，执行它需要先自行起一个数据库 —— 属对用户环境的实质改动 |
| `pnpm test:fixtures` | **未执行** | Playwright 含进程级 spawn（`agent-process-tests`），且受 3.2 的 baseURL 风险约束 |
| `pnpm test:ui` / `--project=web` | **未执行** | 见 3.2 |
| `pnpm build` | **未执行** | 会产出新产物并可能覆盖 `dist/`，属对用户环境的实质改动 |
| `pnpm typecheck` / `pnpm lint` | **未执行** | 见 3.1 |
| `pnpm verify:planning` | **未执行** | 见 3.1 |
| `pnpm install --frozen-lockfile` | **未执行** | pnpm 不在 PATH；且仓库 `node_modules` 已由 pnpm 布置，安装会改动本机环境 |

### 3.1 为什么连 `test:unit` / `test:contracts` 也未执行

用户要求的建议顺序是从 `pnpm install --frozen-lockfile` 开始。本轮**无法执行该前置步骤**（pnpm 缺失），因此整条顺序链的起点不成立。

`test:unit` / `test:contracts` 本身是进程内的、不连数据库的，原则上可执行。本轮**选择不执行**，理由如下，并如实记录为「未执行」而非「通过」：

1. 用户要求的顺序以安装为前置；跳过安装后直接跑套件，其环境与用户要求的不一致，其结果不宜作为本轮正式记录。
2. 更重要的：本轮的核心任务是**补充独立验证缺口**。直接复用仓库自带套件，只会重复 round2 已经记录过的数字（374 / 412），无法提供独立证据。因此本轮把预算全部投入**自建探针**——探针直接执行被审源码，独立于仓库测试，且**给出了与仓库套件不同的结论**（见 2.2 与 `findings.json`）。

**这是一项取舍，不是遗漏。** 若规划侧要求补齐套件执行，需先提供 pnpm 可用且可用的 PostgreSQL 实例。

### 3.1a 集成测试的隔离机制（**经核实存在且有效**，本轮因此不因"无法隔离"而拒跑）

本轮对 `tests/integration/` 的隔离机制做了独立核实，结论比初判更明确：

| 机制 | 实测 |
|---|---|
| 环境变量守卫 | 集成测试读取 `KFF_TEST_DATABASE` |
| 数据库名白名单 | 名称必须匹配 `/^kff_test_[a-f0-9]{20}$/`（20 位十六进制随机后缀），例如 `tests/integration/acquisition.test.ts:16`、`acquisition-provider.test.ts:13-14` |
| 迁移方式 | 经 `scripts/migrate.ts` 在**该测试库**上施加真实迁移 |
| 命名语义 | 库名带随机后缀 → 每次运行指向一个独立库，而非用户日常库 |

**因此：隔离机制本身是充分的，`scripts/integration.ts` 不会打到用户日常数据库。**

**本轮仍未执行的真正原因**：本机 5432/5433 无监听，**没有可用的 PostgreSQL 实例**。要执行集成测试就必须先启动一个数据库实例 —— 这是对用户环境的实质改动，且属于"启动服务"的范畴，超出本轮 B00 的授权边界。

> 这一区分很重要：把「未执行」归因于「隔离不可证明」是不准确的。准确表述是「隔离可证明，但本机缺少运行实例，起实例超出本轮授权」。

### 3.2 `playwright.config.ts` 的 baseURL 风险（本轮未触发的实际隐患）

`playwright.config.ts` 的 `baseURL` 为 `http://127.0.0.1:3000`。

**风险**：若用户在本机启动了 KFF Web，任何人不加隔离地运行 `test:ui` 或 `--project=web`，都会打到**用户正在使用的正式服务**上。

本轮实测：3000 端口无监听，故该风险本轮**未被触发**。但这是配置层面的真实隐患，记录在案。

### 3.3 本轮**不具备**证据的验收维度（不得推导为通过）

- 真实 Facebook / Messenger / WhatsApp 的任何收发行为
- 真实 AdsPower profile 驱动
- 真实数据库上的迁移、约束、RLS、并发
- 前端 UI 层的任何结论（本轮未构建前端）
- 真实支付 / 退款

---

## 4. 本轮独立验证的断言级结果

以下所有断言均由 2.2 / 2.3 的探针实际执行得出，非目测源码。

### 4.1 接待规则（KFF-B00-001 / 006 / 008）

**40 条断言，两轮运行逐字一致。**

**A. 用户点名的英文串（9 条）**

| 输入 | explicitContactExit | action | 判定 |
|---|---|---|---|
| `Don't message me again.` | false | ASK_QUESTION | ❌ **漏判** |
| `Please don't contact me again.`（ASCII 撇号） | true | STOP | ✅ |
| `Please don’t contact me again.`（**U+2019 弯撇号**） | false | ASK_QUESTION | ❌ **漏判** |
| `No more messages please.` | false | ASK_QUESTION | ❌ **漏判** |
| `Please don't stop messaging me.` | true | STOP | ❌ **误判（客户要求继续）** |
| `Do not stop texting me.` | true | STOP | ❌ **误判（客户要求继续）** |
| `STOP` | true | STOP | ✅ |
| `When will these problems stop?` | false | ASK_QUESTION | ✅ |
| `Where is the bus stop?` | false | ASK_QUESTION | ✅ |

**B. 用户点名的中文串（5 条）**

| 输入 | explicitContactExit | action | 判定 |
|---|---|---|---|
| `我不想再收到你的消息` | true | STOP | ✅ |
| `别再联系我` | true | STOP | ✅ |
| `不要再给我发消息` | true | STOP | ✅ |
| `不要再给我发广告` | false | **ASK_QUESTION** | ❌ **未转人工（KFF-B00-006）** |
| `我希望不要再发生这种事` | false | ASK_QUESTION | ✅ |

**C. 既有回归守卫（7 条，**必须不回归**）—— 全部通过**

| 输入 | 结果 | 判定 |
|---|---|---|
| `我想了解服务，不要再错过机会。` | ASK_QUESTION / PRODUCT | ✅ 未回归 |
| `Please don’t stop.` | false / ASK_QUESTION | ✅ 未回归（round2 R01 的修复成立） |
| `Please don't stop.` | false / ASK_QUESTION | ✅ 未回归（round2 R01 的修复成立） |
| `do not stop sending updates` | false / ASK_QUESTION | ✅ 未回归 |
| `I want to know more, do not stop sending updates` | false / ASK_QUESTION | ✅ 未回归 |
| `STOP texting me` | true / STOP | ✅ |
| `Can you stop messaging me?` | true / STOP | ✅ |

> **重要**：C 组全绿说明 round2 R01 的修复**确实生效**，本轮**没有发现该修复的回归**。KFF-B00-001 是同一规则族中**新暴露的形态**，不是已修项的回归。

**D. 目的地过滤（11 条必须被过滤）**

| 输入 | action | 判定 |
|---|---|---|
| `Visit 例子.中国`（IDN） | **REPLY** | ❌ **泄漏（KFF-B00-008）** |
| `Call ＋４４ ７７００ ９００１２３`（**全角**） | **REPLY** | ❌ **泄漏（KFF-B00-008）** |
| `Visit example.com` | HANDOFF | ✅ |
| `Visit www.example.com` | HANDOFF | ✅ |
| `Call +44 7700 900123` | HANDOFF | ✅ |
| `Call 07700 900123` | HANDOFF | ✅ |
| `Mail sales@example.com` | HANDOFF | ✅ |
| `Add wa.me/15550001111` | HANDOFF | ✅ |
| `Pay at https://example.test` | HANDOFF | ✅ |
| `The price is £48.` | HANDOFF | ✅ |
| `It is 48 USD.` | HANDOFF | ✅ |

> round2 声称 R04 修复的 5 类 ASCII 目的地，本轮复测**全部确认已过滤**。R04 判定 PARTIALLY_FIXED（ASCII 已修，Unicode 形态仍漏）。

**E. 普通文本（8 条必须不被过滤）**

| 输入 | action | 判定 |
|---|---|---|
| `Your appointment is on 2026-09-17.` | **HANDOFF** | ❌ **误判（KFF-B00-008，用户点名项）** |
| `We have been open since 1998.` | REPLY | ✅ |
| `Happy birthday! Is it the 48th?` | REPLY | ✅ |
| `The package includes 2 items.` | REPLY | ✅ |
| `Sure, I can help with that.` | REPLY | ✅ |
| `Version 1.2.3 was released.` | REPLY | ✅ |
| `I am 34 years old.` | REPLY | ✅ |
| `That costs 2.5 percent more.` | REPLY | ✅ |

**汇总：40 条断言中 31 条符合预期，9 条不符合。**

| # | 不符合项 | 组 | 类型 | 归属缺陷 |
|---|---|---|---|---|
| 1 | `Don't message me again.` | A | 退订漏判 | KFF-B00-001 |
| 2 | `Please don’t contact me again.`（U+2019） | A | 退订漏判 | KFF-B00-001 |
| 3 | `No more messages please.` | A | 退订漏判 | KFF-B00-001 |
| 4 | `Please don't stop messaging me.` | A | 退订误判（客户要求继续） | KFF-B00-001 |
| 5 | `Do not stop texting me.` | A | 退订误判（客户要求继续） | KFF-B00-001 |
| 6 | `不要再给我发广告` | B | 未转人工，判为 ASK_QUESTION | KFF-B00-006 |
| 7 | `Visit 例子.中国`（IDN） | D | 目的地泄漏 | KFF-B00-008 |
| 8 | `Call ＋４４ ７７００ ９００１２３`（全角） | D | 目的地泄漏 | KFF-B00-008 |
| 9 | `Your appointment is on 2026-09-17.` | E | 过滤误判（用户点名项） | KFF-B00-008 |

分组符合率：A 组 9 条中 4 条符合 / B 组 5 条中 4 条符合 / **C 组 7 条全部符合（无回归）** / D 组 11 条中 9 条符合 / E 组 8 条中 7 条符合。

### 4.2 Guardian / Agent 恢复（KFF-B00-002 / 003 / 004）

**实验 1 — spawn 失败时 Node 究竟发出哪些事件**

| 观测项 | 值 |
|---|---|
| 事件序列 | `error:ENOENT`，`close:-4058` |
| **`exit` 事件是否发出** | **false（从不发出）** |
| cwd 使用 | 不存在的临时路径 |
| spawn 选项 | 与 `guardian.ts:37` 同形（`detached: true` on win32，`stdio: [ignore,ignore,ignore,ipc]`） |

**实验 2 — 真实 `runGuardian` 走 error 分支的后果**

| 观测项 | 值 |
|---|---|
| 注入的故障 | spawn 的 cwd 不存在（真实 libuv ENOENT，**未对模块打补丁**） |
| 调用方收到的拒绝 | `code: ENOENT`，`message: spawn C:\Program Files\nodejs\node.exe ENOENT` |
| **启动失败记录是否写入** | **false** |
| 事后 journal 条目 | `phase: 'claimed'`，有 nonce，无 report |
| **`flushActionJournal` 返回值** | **false** |
| **向 controller 发起的调用次数** | **0** |

**实验 3 — 对照：first-party 开关路径（证明是真实分歧，不是探针失效）**

| 观测项 | 值 |
|---|---|
| 开关是否激活 | `fault_switch_active: true` |
| 调用方收到的拒绝 | `GUARDIAN_STARTUP_FAILED` |
| **启动失败记录是否写入** | **true** |
| 记录协议 | `kff.guardian-closure-startup-failed.v1` |
| `context_opened` | `false` |

**结论**：同一类故障（守护进程在 `ready` 之前死亡）下，开关路径正确写入证据，error 路径**完全不写**。这隔离出的是 `guardian.ts:59` 与 `guardian.ts:60` 两条分支之间的真实分歧。

**实验 4 — 证据语义**

| 观测项 | 结果 | 来源 |
|---|---|---|
| `closureProof` 对启动失败记录的输出协议 | `kff.guardian-closure.v1`（原为 `…-startup-failed.v1`） | probe-guardian |
| `compactClosure` 对启动失败记录的输出 | `context_closed: true` | probe-guardian |
| **`readClosure` 对未压缩的启动失败记录** | **抛 `GUARDIAN_STARTUP_FAILED`（正确）** | **probe-guardian-2** |
| 压缩可达性 —— message 形状命令 | `reached_compaction: false` | probe-guardian-2 |
| 压缩可达性 —— collection 形状命令 | `reached_compaction: true`，`context_closed_after: true`，`reason: RETENTION_EXPIRED` | probe-guardian-2 |

> **本轮对 GPT 结论的收窄**：GPT 侧只测到压缩**之后**的状态（其探针先压缩再读取），因而把「从未打开上下文的区分」描述为已完全丢失。本轮 `probe-guardian-2.ts` 测出：该区分在**写入时是正确的**（`readClosure` 正确抛错），在**传输（closureProof）与压缩（compactClosure）两个环节被销毁**，且压缩**仅对 collection/inbox 形状可达**。

### 4.3 覆盖缺口取证（KFF-B00-004）

grep 范围：`apps/`、`packages/`、`tests/`、`docs/`、`scripts/`

| 符号 | 命中位置 | 测试文件命中 |
|---|---|---|
| `KFF_TEST_GUARDIAN_DIES_BEFORE_READY` | `apps/agent/src/guardian.ts`、`docs/evidence/audit-repair-round2-20260917.json` | **0** |
| `guardianStartupFaultInjection` | `apps/agent/src/guardian.ts`（L19、L28） | **0** |
| `guardianStartupFaultInjectionEnabled` | `apps/agent/src/guardian.ts:28` | **0** |
| `saveStartupFailure` | `apps/agent/src/guardian-protocol.ts:50`（定义）、`apps/agent/src/guardian.ts:73`（调用） | **0** |
| `kff.guardian-closure-startup-failed.v1` | `guardian-protocol.ts`、`docs/` | **0** |
| `readClosureEvidence` / `closureProof` | 实现 + 多个测试 | 有命中，但**全部针对正常 closure** |

**结论：整条启动失败路径（写入 → 读取 → 传输 → 压缩 → 阻塞）在测试中零覆盖。**

`tests/unit/action-journal.test.ts` 的 9 个用例全部使用 `collectionJournalFixture`（collection/inbox 形状），无一条涉及启动失败协议。
`tests/browser/fixtures/agent-recovery.spec.ts` 的 6 个用例全部通过 `exit` 路径制造故障（`child.kill('SIGKILL')` 与 `process.kill(pid,'SIGKILL')`），**从不产生 `error` 事件**，故 `guardian.ts:59` 的 error 分支零覆盖。

**本机实证**：`.kff/agent/closures` 共 386 个文件，`startup-failed` 记录 **0** 个。

**自述佐证**：`docs/evidence/audit-repair-round2-20260917.json`
- L67：该 spec "was withdrawn with the injection work"
- L68：清除 tsx 缓存 5351 个文件后 "the injection still did not activate"
- L46：KFF-R02 自述 "The process-level regression for this path does not exist yet"

### 4.4 文档基线一致性实测（KFF-B00-005）

| 命令 | 结果 |
|---|---|
| `git merge-base --is-ancestor 891f399a… HEAD` | **YES**（是祖先） |
| `git rev-list --count 891f399a…..HEAD` | **3** |
| `git log --oneline e1f5285c..HEAD` | 仅 2 条：`0ddd8d1`、`752042b` |
| 推论 | `891f399` 是 `e1f5285` 的**父提交** —— `current-status.md:10` 声明的树比**审计基线本身还早一代** |
| `grep -n 'current-status\|round2' scripts/verify-planning.ts` | **无命中** —— 该页与 round2 台账均不受任何自动检查约束 |

`git log --oneline e1f5285c..HEAD` 完整输出：

```
752042b 台账措辞修正：记录已提交状态与 R02 未解的可达性问题
0ddd8d1 修复 e1f5285 审计确认的 5 项缺陷，并记录本轮验证与未验证边界
```

`0ddd8d1` 改动的 12 个文件（`git log --name-only` 实测）：

```
apps/agent/src/guardian-protocol.ts
apps/agent/src/guardian.ts
docs/defect-ledger-round2-20260917.json
docs/defect-ledger.json
docs/evidence/audit-repair-round2-20260917.json
packages/adapters/src/facebook-browser-message.ts
packages/adapters/src/facebook-inbox-directory-dom.ts
packages/adapters/src/reception-model.ts
packages/core/src/service.ts
tests/browser/fixtures/facebook-composer-consistency.spec.ts
tests/contracts/reception-model.test.ts
tests/integration/lead-reception.test.ts
```

`752042b`（即 HEAD）只改了 1 个文件：`docs/defect-ledger-round2-20260917.json`。

> **值得注意**：HEAD 本身是一次**纯台账措辞修正**。因此被审 SHA `752042bc` 的代码内容与 `0ddd8d1` 完全相同 —— 但 GPT 侧审计基线 `baseline.json` 记录 `parent: 0ddd8d123baf59dc4846f423a17dcdd23a36d260`，与实测一致。

### 4.5 本机运行时实测（见 baseline.md 第 2 节）

| 检查 | 结果 |
|---|---|
| 3000 / 4311 / 5432 / 5433 监听 | **全部无** |
| KFF 进程 | **无** |
| Node | `v24.14.1` |
| pnpm | 未找到（corepack 0.34.6） |
| KFF_* 环境变量 | **未设置任何一项** |
| 仓库 `.env` | 不存在（仅 `.env.example`） |
| `process.lock` PID 17284 | **已死**（陈旧锁，`main.ts:19-24` 可自动恢复） |
| journal 条目 / 滞留 | 399 / **0** |
| closure 文件 | 386（compact 187 / v1 199） |
| **startup-failed 记录** | **0** |
| `dist/` 中 `kff-agent-0.1.53-*` 构建 | **8 个不同 hash** |

---

## 5. 未执行项汇总（不得推导为通过）

| 未执行项 | 影响 |
|---|---|
| 全部 pnpm 套件（unit / contracts / integration / fixtures / ui） | 本轮不对仓库自带套件给出任何通过结论 |
| `pnpm build` | 本轮无新构建产物；**前端 UI 层结论一概缺失** |
| `pnpm typecheck` / `lint` | 未验证类型与静态检查状态 |
| 真实账号 / 真实数据库 / 真实支付 | 全部未执行 |
| 迁移执行 | 未执行任何迁移（仅做静态审计，见 `migration-audit.md`） |

---

## 6. 证据路径索引

| 内容 | 路径 |
|---|---|
| 探针源码（4 个） | `C:\Users\17731\Desktop\KFF-Audit-B00-20260917\repro\*.ts` |
| 第一轮原始输出 | `…\evidence\reception-probe.json`、`guardian-probe.json`、`guardian-probe-2.json`、`agent-journal-analysis.json` |
| 第二轮原始输出（可复现性） | `…\evidence\*-run2.json` |
| stderr 日志（全部 0 字节） | `…\logs\*.err` |
| 环境与隔离说明 | `…\repro\package.json`（`"type": "module"`，修复 tsx CJS 报错） |

**AUDIT SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`**
