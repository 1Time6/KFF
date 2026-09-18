# baseline.md — B00 独立审计基线

生成时间：2026-09-17
审计方：执行端（B00 独立审计与验证补充）
性质：**独立审计与验证补充，不是全仓库验收，不构成发布授权。**

---

## 1. 审计对象（冻结 SHA）

| 项目 | 值 | 核实方式 |
|---|---|---|
| 仓库 | `https://github.com/1Time6/KFF` | `git remote -v` |
| 被审分支 | `codex/facebook-foundation` | `git branch -a` |
| **AUDIT SHA** | **`752042bc466b10b07cad455757a41bb10bbaf39f`** | 本地 HEAD `git rev-parse HEAD` |
| origin 同名分支 | `752042bc466b10b07cad455757a41bb10bbaf39f` | `git ls-remote origin`（只读，未 fetch） |
| `origin/main` | `e1f5285c6cdd3089515cd4edce2746179a137465` | `git ls-remote origin`（只读） |
| 工作树状态 | 干净（`git status --porcelain` 无输出） | 未产生任何仓库内改动 |
| 本地源码路径 | `C:\Users\17731\Desktop\KFF` | 本机实际目录 |
| package 版本 | `0.1.53` | `package.json` |

**SHA 漂移结论：未观察到漂移。** 用户提供的三个 SHA 全部独立复核通过：
- `752042bc…` = 被审分支当前 HEAD ✅
- `e1f5285c…` = main ✅
- 冻结审计 SHA 未被移动、未被追加提交。

**未默认 main 为最新**：`origin/main` 停在 `e1f5285c`，`codex/facebook-foundation` 领先它 2 个提交（`e1f5285c` → `891f399` → `752042bc`… 见第 5 节实测）。

---

## 2. 本地运行时身份（用户要求逐项核实）

> 用户明确要求："GitHub 源码更新不得当作本机程序已更新的证据。" 以下逐项实测，无法核实者一律写 UNVERIFIED，不猜测。

| 项目 | 实测值 | 状态 |
|---|---|---|
| 当前工作目录源码 SHA | `752042bc…`（干净） | ✅ 已核实 |
| KFF Web 进程 PID | 无 | ✅ 未运行 |
| KFF Worker 进程 PID | 无 | ✅ 未运行 |
| KFF Agent 进程 PID | 无 | ✅ 未运行 |
| 3000 端口监听 | 无 | ✅ 已核实 |
| 4311 端口监听 | 无 | ✅ 已核实 |
| 5432 / 5433 端口监听 | 无 | ✅ 已核实 |
| Node 版本 | `v24.14.1` | ✅ 已核实 |
| pnpm 版本 | **PNPM_NOT_FOUND**（仅 corepack `0.34.6`） | ⚠️ 见第 3 节 |
| KFF_ROOT | **环境变量未设置** | ⚠️ 未显式声明 |
| Agent journal 路径 | `C:\Users\17731\Desktop\KFF\.kff\agent\journal.json` | ✅ 存在，274,083 字节，mtime `2026-09-17 02:19` |
| 仓库 `.env` | 不存在（只有 `.env.example`） | ✅ 已核实 |
| `process.lock` | 内容 `17284`，该 PID **已死**（`tasklist` 无此 PID） | ✅ 陈旧锁，可自动恢复（`main.ts:19–24`） |
| **current release_id** | **UNVERIFIED** — `docs/current-status.md:12` 自述"未声明"；无存活进程可查询 | ❌ |
| **实际正在运行的代码/构建身份** | **UNVERIFIED** — 无任何 KFF 进程在运行，不存在"正在运行的构建" | ❌ |
| **已安装的包/构建版本** | **UNVERIFIED** — 见下方 0.1.53 构建歧义 | ❌ |
| **AdsPower / Profile 绑定状态** | **UNVERIFIED** — 未读取 AdsPower 配置，未连接任何 profile | ❌ |
| **实际数据库实例** | **UNVERIFIED** — 无 5432/5433 监听，无嵌入式实例在跑；本轮未打开任何数据库 | ❌ |

### 2.1 「0.1.53」不是身份——本机实测证据

本机 `dist/` 中同时存在 **8 个不同的 `kff-agent-0.1.53-win32-x64-<hash>` 构建**：

```
0.1.53 hash=067f39e00a40    0.1.53 hash=660e67dac2d6
0.1.53 hash=09426d5344c9    0.1.53 hash=7b5073d59dc3
0.1.53 hash=153bd4ef175d    0.1.53 hash=7f1bf4d37bad
0.1.53 hash=e6542c29878b    0.1.53 hash=f5c2a048f338
```

外加多个 `kff-controller-0.1.53-win32-x64-<hash>`。

**这是"只凭版本号套用现场证据是错的"的实证**：同一版本号下有 8 个互不相同的 Agent 构建。任何"0.1.53 已验证"的结论，若不指明具体 hash 与 `release_id`，在本机都无法落到具体产物上。

`docs/evidence/audit-repair-round2-20260917.json:9` 亦自述：
> "no release_id is claimed for them, because no package was built or deployed from this round."

即 **round2 的 5 项修复从未打包、从未部署**。当前 `dist/` 里的 0.1.53 产物**早于** round2 修复，不能用它们的现场表现推断被审 SHA 的行为。

### 2.2 实测运行历史（Agent journal 分析）

对 `journal.json` 只读分析（`repro/probe-journal.ts`，未写入）：

| 指标 | 值 |
|---|---|
| 条目总数 | 399 |
| phase 直方图 | `context_open: 244`、`submitting: 138`、`reported: 13`、`claimed: 4` |
| 未 quiesce（滞留）条目 | **0**（全部已 quiesce） |
| closures 目录文件数 | 386 |
| closure 协议直方图 | `kff.guardian-closure-compact.v1` 187 / `kff.guardian-closure.v1` 199 |
| **`startup-failed` 记录数** | **0** |

**关键事实：启动失败（startup-failure）路径在本机真实运行中从未触发过。** 用户指出的 P1-B 历史（探针无输出）与本机 0 条记录一致——该路径既无真实证据，也无测试证据（见 `findings.json` KFF-B00-002）。

---

## 3. 工具链与隔离声明

### 3.1 pnpm 缺失与实际处置

`pnpm` 不在 PATH，仅有 corepack `0.34.6`。

**处置：本轮未执行 `pnpm install`，未安装任何依赖，未改动 lockfile。**
依据：仓库 `node_modules` 已由 pnpm 布置（`node_modules/.modules.yaml` 存在），所需二进制均在 `node_modules/.bin`（vitest / tsx / tsc / eslint / playwright / next）。因此全部工具以 `node_modules\.bin\<tool>.cmd` 直接调用。

这同时满足用户"不得修改正式业务代码"与"不得让本机环境漂移"的约束。

### 3.2 本轮执行的隔离边界

| 约束 | 本轮执行情况 |
|---|---|
| 未修改正式业务代码 | ✅ 仓库工作树 `git status` 干净 |
| 未 commit / push / merge / deploy | ✅ 全部未执行 |
| 未重启用户正在使用的 KFF 服务 | ✅ 无 KFF 进程，未启动任何服务 |
| 未修改用户日常数据库 | ✅ 未打开任何数据库；无 5432/5433 实例 |
| 未使用真实 Facebook 账号发消息/评论 | ✅ 未执行 |
| 未使用真实 WhatsApp 做客户操作 | ✅ 未执行 |
| 未使用真实 Stripe 或任何真实支付 | ✅ 未执行 |
| 未为让测试通过而删测试/skip/放宽断言/重跑制造全绿 | ✅ 见 3.3 |

### 3.3 关于"制造全绿"的自律声明

本轮**没有改造任何仓库内测试**：未删除、未 skip、未放宽断言、未反复重跑以取一次绿色。
本轮的验证证据**全部来自审计方自建探针**（`repro/` 目录，位于仓库之外），探针直接动态 import 被审 SHA 的**真实源文件**执行，不复制、不改写被测逻辑。

### 3.4 未执行的测试套件及原因（不是通过，是未执行）

| 套件 | 是否执行 | 原因 |
|---|---|---|
| `test:unit` / `test:contracts` | ⚠️ 见 `test-results.md` | 进程内，但见下条说明 |
| `pnpm test:integration` | ❌ **未执行** | `scripts/integration.ts` 需创建数据库实例；**无法证明与用户日常环境隔离**，按用户规则"如果无法证明和用户日常环境隔离：不要执行" |
| `pnpm test:fixtures` | ❌ **未执行** | Playwright 含进程级 spawn，且见下条 baseURL 风险 |
| `pnpm test:ui` / `--project=web` | ❌ **未执行** | `playwright.config.ts` 的 `baseURL` 指向 `http://127.0.0.1:3000`；若用户启动本地 Web，会打到**正在使用的正式服务**。且用户明确要求 UI 必须打本轮新构建，本轮未构建 |
| `pnpm build` | ❌ **未执行** | 会产出新产物、可能覆盖 `dist/`，属对用户环境的实质改动 |

> **`playwright.config.ts` 的 `baseURL: 'http://127.0.0.1:3000'` 是一个真实的操作风险**：任何人不加隔离地运行 `test:ui`，都会打到该端口上正在服务的实例。本轮因此未执行。

### 3.5 参考材料的使用方式

`C:\Users\17731\Desktop\KFF-Audit-752042bc-20260917`（GPT 侧审计包）与 `executor-instructions.md` 仅作为**审计输入与线索**。

**凡与本轮代码事实、可复现探针、原始证据冲突者，以后者为准。** 本轮已实际推翻/收窄了其中若干结论，逐条见 `findings.json` 的 `divergence_from_prior_audit` 字段。

`C:\Users\17731\Desktop\KFF`（本地源码）为被审对象本体。

---

## 4. 三个范围的分层（防止历史文件被当作现状）

| 范围 | 内容 | 本轮判定依据 |
|---|---|---|
| **A. 原始完整产品规划** | Facebook + Instagram + Threads、AI 自动刷帖养号、30 账号并发、完整支付订单模块 | 已推迟。**冻结模块仍须检查安全影响与误触发路径**（见 `feature-matrix.md`） |
| **B. 后续收窄的 Facebook V1** | 来源发现 → 采集 → 候选筛选 → Lead → 受控互动 → Inbox → AI 接待 → WhatsApp 移交 → 客户记录 | 本轮主审范围 |
| **C. 当前修复/加固阶段** | round1（25 项）+ round2（5 项） | 本轮复核其**声明是否成立**，不继承其结论 |

**判定规则（本轮实际执行）**：历史文件中的"当前 / 已完成 / PASS"**一律不作为事实**，只作为待验证声明；以 SHA、日期与实际源码为准。

已实际发现的历史声明与事实冲突：
- `docs/current-status.md:10` 声明源码提交 `891f399a…`，而实际 HEAD 为 `752042bc…`，落后 3 个提交（见第 5 节）。
- `docs/current-status.md:27` 声明"25 项 = 已修复并验证 25"，而 `docs/defect-ledger-round2-20260917.json:22` 自述：外部审计**只能核实 25 项中的 3 项**，其余 21 项为 `CANNOT_VERIFY`，且 `KFF-B05` 为 `partially_reopened`。
- `apps/agent/src/guardian.ts:27` 声明"Exported for the unit contract that pins every condition"，而该 unit contract **不存在**（`docs/evidence/audit-repair-round2-20260917.json:67` 自述"that spec was withdrawn with the injection work"）。

---

## 5. 提交谱系（实测）

```
e1f5285c6cdd3089515cd4edce2746179a137465   origin/main，被审分支的合并基点
   └─ 891f399a9c81aafb2d960046f1e3214dd893bf68   "审计并修复「界面可选、服务端必拒」缺陷，交付 0.1.53 控制端包"
        └─ 752042bc466b10b07cad455757a41bb10bbaf39f   ← HEAD / AUDIT SHA（round2 修复）
```

实测命令与结果：
- `git merge-base --is-ancestor 891f399 HEAD` → **YES**（是祖先）
- `git rev-list --count 891f399..HEAD` → **3**

**结论**：`docs/current-status.md` 自称"接手人员**唯一**的当前状态入口"，但它声明的基线落后当前 HEAD **3 个提交**，且**完全未引用** round2 台账。这意味着 round2 的 5 项修复与 `KFF-R02 部分修复` 这一事实，从"唯一入口"不可见。

**机制层原因（本轮实测，非推测）**：`scripts/verify-planning.ts` 只在第 63–70 行校验 `docs/defect-ledger.json` 的存在与 schema_version，**从不读取 `docs/current-status.md`**，也**不校验**该页声明的源码提交（第 34 行的 `git rev-parse HEAD` 仅用于自身记录，未与页面声明比对）。因此该页变陈旧时**没有任何检查会失败**。

---

## 6. 本轮未覆盖 / 无法核实的范围（不得当作通过）

- 真实 Facebook / Instagram / WhatsApp 账号的任何收发行为：**未执行**。
- 真实 AdsPower profile 驱动：**未执行**。
- 任何真实支付 / 退款 / Stripe 操作：**未执行**。
- 生产库或本地运营库的读取与比对：**未执行**（含"已有多少客户被旧规则误写为 OPTED_OUT"这一未知量）。
- 2 / 5 / 30 账号并发容量与稳定性：**无数据**（`audit-repair-round2-20260917.json:74` 亦自述"no load"）。
- 实机安装包、干净电脑、无系统 Node 的交付场景：**未执行**。
- 全部 33 个数据库迁移：见 `migration-audit.md`（外部审计只读了 5 个；本轮独立复核结果另记）。
- 前端 UI 层结论：**未执行**（未构建本轮前端，未跑 `--project=web`）。
- 已冻结的支付/退款模块的完整重构：**明确不在本轮范围**，仅审"是否仍可从当前 UI/API 误达、是否真能发起扣款/退款、是否影响 Facebook V1"。

---

## 7. 证据路径索引

| 证据 | 路径 |
|---|---|
| 本基线文件 | `C:\Users\17731\Desktop\KFF-Audit-B00-20260917\baseline.md` |
| AI 接待规则探针源码 | `…\KFF-Audit-B00-20260917\repro\probe-reception.ts` |
| Guardian 探针源码 | `…\repro\probe-guardian.ts` |
| Guardian 边界探针源码 | `…\repro\probe-guardian-2.ts` |
| Journal 只读分析源码 | `…\repro\probe-journal.ts` |
| 接待规则原始输出 | `…\evidence\reception-probe.json` |
| Guardian 原始输出 | `…\evidence\guardian-probe.json` |
| Guardian 边界原始输出 | `…\evidence\guardian-probe-2.json` |
| Journal 分析原始输出 | `…\evidence\agent-journal-analysis.json` |
| stderr 日志 | `…\logs\*.err` |

**AUDIT SHA 贯穿全部证据：`752042bc466b10b07cad455757a41bb10bbaf39f`**
