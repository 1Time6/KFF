# historical-regression.md — 历史声明与回归复核

**AUDIT SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`**

生成时间：2026-09-17
复核方：执行端（B00）

---

## 0. 复核规则

1. 历史文件中的「当前 / 已完成 / 通过 / 已修复并验证」**一律视为待验证声明**，不作为事实。
2. 判定依据只有三种：**在 AUDIT SHA 上实际执行源码得到的可复现结果**、**在 AUDIT SHA 上可复现的静态事实**、或明确标注 `CANNOT_VERIFY`。
3. **`CANNOT_VERIFY` 不计入 Bug 数。**
4. 历史状态取值域：`{FIXED, PARTIALLY_FIXED, NOT_FIXED, REGRESSED, OBSOLETE, CANNOT_VERIFY}`。

---

## 1. 两轮修复的台账结构（实测）

| 台账 | 项目数 | 声明状态 | 基线声明 |
|---|---|---|---|
| `docs/defect-ledger.json`（round1） | **25**（KFF-B01…B23、KFF-D01、KFF-D02） | `repaired_and_verified: 25`、`partially_repaired: 0`、`pending: 0` | 分支 `codex/facebook-foundation`，**`source_commit: 891f399a…`** |
| `docs/defect-ledger-round2-20260917.json`（round2） | **5**（KFF-R01…R05） | `repaired_and_verified: 4`、`partially_repaired: 1` | 分支同上，`source_commit: e1f5285c…` |

两轮**明令不得相加**（两份文件均写明）。round2 文件 L22 自述：
> "The external audit could verify only 3 of the previous 25 items and left 21 unverified. This round did not re-audit them, so they stay unverified and are not restated here."

**即：round1 的 25 项中，只有 3 项获得过外部核实，21 项为 `CANNOT_VERIFY`。**

---

## 2. round2 五项逐条复核

### KFF-R01 — 退订规则误读普通句子 → **PARTIALLY_FIXED**

| 声称 | 本轮实测 |
|---|---|
| `Please don't stop.` 不再被读为退订 | ✅ **成立**（实测 false / ASK_QUESTION） |
| `When will these problems stop?` 不再被读为退订 | ✅ **成立** |
| `Where is the bus stop` 不再被读为退订 | ✅ **成立** |
| `我希望不要再发生这种事。` 不再被读为退订 | ✅ **成立** |

**但同一规则族仍存在新形态缺陷**（`findings.json` KFF-B00-001）：

- `Please don’t contact me again.`（U+2019 弯撇号）→ **漏判**，而 ASCII 撇号版本正确
- `Don't message me again.` / `No more messages please.` → **漏判**
- `Please don't stop messaging me.` / `Do not stop texting me.` → **误判为退订**（客户要求继续）

**判定依据**：4 项声称的修复全部成立（7 条既有回归守卫实测全绿，**未发现回归**），但 `optOut` 仍缺少 `bareStop` 已有的否定守卫，且未做撇号归一化。故为 PARTIALLY_FIXED，不是 REGRESSED。

### KFF-R02 — Guardian 启动失败记录 → **PARTIALLY_FIXED（与自述一致，但未覆盖面比自述更窄）**

| 声称 | 本轮实测 |
|---|---|
| 父进程记录自己的启动失败记录 | ✅ **成立**（开关路径实测写入 `kff.guardian-closure-startup-failed.v1`，`context_opened: false`） |
| `readClosure` 拒绝该记录而非当作已关闭上下文 | ✅ **成立**（probe-2 实测：未压缩时抛 `GUARDIAN_STARTUP_FAILED`） |
| 进程级回归尚不存在 | ✅ **自述属实**（实测 tests/ 零覆盖） |

**本轮新增的决定性发现**：该修复**只覆盖 `exit` 分支，不覆盖 `error` 分支**。

- `guardian.ts:60` 的 `child.once('exit')` 承载全部终止证据逻辑，`L71-75` 的启动失败记录写入位于其内。
- 实测：spawn 失败时 Node **只发 `error` 与 `close`，从不发 `exit`**（`exit_event_emitted: false`）。
- 因此走 `guardian.ts:59` 的 error 分支时，**启动失败记录永不写入**，`flushActionJournal` 返回 `false`，controller 调用 **0 次**，Agent **永久拒绝接单且重启不自愈**。

故 KFF-R02 的修复方向正确，但**未覆盖它声称要解决的故障类**。判定 PARTIALLY_FIXED，并新增 P1 缺陷 KFF-B00-002。

### KFF-R03 — composer 标签归一化 → **本轮未复核（CANNOT_VERIFY）**

需真实 Chromium fixture 或真实 AdsPower profile。本轮未执行任何 Playwright 套件（见 `test-results.md` 第 3 节）。**标记 CANNOT_VERIFY，不计入 Bug。**

### KFF-R04 — 目的地过滤 → **PARTIALLY_FIXED**

| 声称已过滤 | 本轮实测 |
|---|---|
| `+44 7700 900123` | ✅ 已过滤（HANDOFF） |
| `+1 (202) 555-0123` | ✅（同类 ASCII 形态实测已过滤） |
| `www.example.com` | ✅ 已过滤 |
| `example.com/pay` | ✅（`example.com` 实测已过滤） |
| `sales@example.com` | ✅ 已过滤 |

**仍未覆盖**（`findings.json` KFF-B00-008）：

- `Visit 例子.中国`（IDN 域名）→ **REPLY（泄漏）**
- `Call ＋４４ ７７００ ９００１２３`（全角数字与全角加号）→ **REPLY（泄漏）**
- `Your appointment is on 2026-09-17.` → **HANDOFF（误判）**

故 ASCII 部分成立，Unicode 形态与日期误判未覆盖。判定 PARTIALLY_FIXED。

### KFF-R05 — WhatsApp referral 状态投影 → **本轮未复核（CANNOT_VERIFY）**

round2 自述其证据来自隔离 PostgreSQL 上的集成测试，且自述 `unverified: ["the concurrent cancel-versus-dispatch race was not exercised"]`。

本轮未执行集成测试（本机无 PostgreSQL 实例，见 `test-results.md` 3.1a），因此**无法独立复核**。**标记 CANNOT_VERIFY，不计入 Bug。**

> 注意：round2 自己已声明未覆盖并发 cancel-versus-dispatch 竞态。因此即使其单线程用例成立，**也不足以宣称该状态投影已完全关闭** —— 这一点 round2 记录正确。

---

## 3. KFF-D01 的回归（本轮最重要的历史发现）

### 3.1 该项的内容

`docs/defect-ledger.json` 的 **KFF-D01**（P2 / documentation / PR-05）：

> **summary**: The entry named 当前 still pointed at 0.1.47 and manual source selection
> **changed_files**: `docs/current-status.md`, `docs/next-step-current.md`, `docs/defect-ledger.json`, `scripts/verify-planning.ts`
> **tests**: `["scripts/verify-planning.ts"]`
> **status**: `repaired_and_verified`
> **unverified**: `[]`（声明**零**未验证范围）

即：round1 修过一次「唯一入口页指向陈旧基线」这一缺陷，并**改动了校验脚本** `scripts/verify-planning.ts`。

### 3.2 回归实测

**同类缺陷已重现：**

| 检查 | 实测 |
|---|---|
| `docs/current-status.md:10` 声明的 `source_commit` | `891f399a9c81aafb2d960046f1e3214dd893bf68` |
| 实际 HEAD | `752042bc466b10b07cad455757a41bb10bbaf39f` |
| `git rev-list --count 891f399..HEAD` | **3** |
| 与审计基线 `e1f5285` 的关系 | `891f399` 是 `e1f5285` 的**父提交** —— 该页声明的树**比被审计的基线还早一代** |
| `docs/defect-ledger.json` 的 `baseline.source_commit` | **同样是 `891f399a…`**（陈旧一致） |
| 该台账的 `note` | "Working-tree changes are uncommitted repairs" —— 而 round2 的修复**已提交**（`0ddd8d1`），该说明亦已陈旧 |

### 3.3 **为什么校验脚本没能拦住它 —— 这是回归的机制层原因**

本轮完整阅读了 `scripts/verify-planning.ts`（93 行）。其中 `verifyDefectLedger()`（**L62-92**，即 KFF-D01 声称改动的那部分）实际只做以下检查：

| 行 | 检查内容 |
|---|---|
| L63 | `docs/defect-ledger.json` 存在 |
| L70 | `schema_version === 'kff.defect-ledger.v1'` |
| L72 | 编号无重复 |
| L73 | `counts.work_items` 与实际项数一致 |
| L75-80 | `by_category` / `by_status` 统计与条目重算一致 |
| L83 | 状态值在允许集合内 |
| L84 | 每项必须显式记录 `unverified` |
| L85 | 引用的 `changed_files` / `tests` 文件真实存在 |
| L86-88 | 声明已修复须带测试或人工验证；未关闭须写明剩余工作 |
| L90 | 必须写明与旧审计的合计口径 |

**以上检查中，没有任何一条涉及：**

- ❌ `docs/current-status.md` —— **该校验器全文不读取该文件**
- ❌ `docs/defect-ledger-round2-20260917.json` —— **全文不读取该文件**
- ❌ 任何声明的 `source_commit` 与 `git rev-parse HEAD` 的比对
- ❌ 台账 `baseline` 字段的校验（L64-69 的类型注解中**根本不含 `baseline`**）

关于 L34 的 `execFileSync('git', ['rev-parse','HEAD'])`：它**仅**用于在 `docs/tasks/ledger.json` 不存在时（L33 守卫）给新任务卡盖章 `repository_commit_before`，**从不与任何声明比对**。在已存在的检出上它甚至不会执行。

### 3.4 结论

**KFF-D01 = `REGRESSED`。**

KFF-D01 修复了**内容**（把入口页从 0.1.47 更新到当时的基线），但没有增加能防止**该类缺陷再次发生**的检查。它把 `scripts/verify-planning.ts` 列入 `changed_files` 与 `tests`，从而在台账中获得「有测试」的可信外观；然而该校验器校验的是**台账自身的内部一致性**，而不是**入口页的基线时效性**。

结果：同类缺陷在 3 个提交后原样重现，且**没有任何自动检查会失败**。该项同时声明 `unverified: []` —— 声称零未验证范围，而其修复所针对的故障类实际处于无保护状态。

> 这一条与 `findings.json` 的 KFF-B00-005 是同一事实的两个面向：KFF-B00-005 记录当前状态，KFF-D01 记录它是一次**回归**而非首次发现。

---

## 4. round1 的 25 项：本轮复核能力与限制

| 分组 | 数量 | 本轮结论 |
|---|---|---|
| 本轮实际复核并确认成立 | 若干（见下） | FIXED |
| 本轮实际复核并确认不成立/不完整 | KFF-B05、KFF-D01 | PARTIALLY_FIXED / REGRESSED |
| 本轮未复核 | 其余 | **CANNOT_VERIFY（不计入 Bug）** |

### 4.1 本轮实际触及的 round1 条目

**KFF-B05**（P1，退订规则）—— round1 声称修复「standalone STOP 漏判 + 不要再/别再 过度匹配」；round2 已把它重新分类为 `partially_reopened`。

本轮实测：
- standalone `STOP` → ✅ 正确判为退订
- `我不想再收到你的消息` / `别再联系我` / `不要再给我发消息` → ✅ 均正确判为退订（round1 修复成立）
- 但 `不要再给我发广告` → ❌ 判为 ASK_QUESTION（KFF-B00-006）
- 且 U+2019 形态漏判、`don't stop + 动词` 误判（KFF-B00-001）

**判定：`PARTIALLY_FIXED`**（与 round2 的 `partially_reopened` 一致）。

**KFF-B06**（P1，价格过滤漏 GBP / ISO 货币码 / 英镑）—— 本轮实测：

| 输入 | 动作 | 判定 |
|---|---|---|
| `The price is £48.` | HANDOFF | ✅ 已过滤（GBP 符号成立） |
| `It is 48 USD.` | HANDOFF | ✅ 已过滤（ISO 货币码成立） |

**判定：`FIXED`**（在其声称的范围内实测成立；「英镑」中文形态本轮未单独构造用例，属未覆盖）。

**KFF-D01**（P2，入口页陈旧）—— **`REGRESSED`**，见第 3 节。

**KFF-D02**（P3，旧审计总数不可对账）—— 本轮确认 `docs/defect-ledger.json` 的 `relation_to_previous_audit.rule` 写明「NOT added to the previous 64 and no completion rate may be computed」，且 `verify-planning.ts:90` 强制该口径存在。**判定：`FIXED`**。其自述 `unverified: ["per-item deduplication against the previous 56 remaining entries needs the original list"]` 属实。

### 4.2 未复核的条目（CANNOT_VERIFY，不计入 Bug）

其余 round1 条目（KFF-B01…B04、B07…B23）本轮**未逐条复核**。原因：

- 其中 B07、B09、B10、B12、B13、B20、B21、B22 涉及**前端页面**，`current-status.md:55` 自述其断言只在重建前端后才覆盖工作树。本轮未构建前端。
- 其余需要集成数据库、真实浏览器或未提供的环境。

**一律标记 `CANNOT_VERIFY`，不计入 Bug 数，不得从台账的 `repaired_and_verified: 25` 推导为已验收。**

---

## 5. 台账内部矛盾（本轮实测，未被任何检查捕获）

| 来源 | 声明 | 冲突 |
|---|---|---|
| `docs/defect-ledger.json` `counts.by_status` | `repaired_and_verified: 25`, `partially_repaired: 0`, `pending: 0` | — |
| `docs/current-status.md:27` | 「25 项 = 已修复并验证 25」（全部落地） | — |
| `docs/defect-ledger-round2-20260917.json:22` | 外部审计**只能核实 25 项中的 3 项**，其余 **21 项 CANNOT_VERIFY** | **与上两行冲突** |
| `docs/defect-ledger-round2-20260917.json:20` | KFF-B05 `partially_reopened` | **与「25/25 全部已修复并验证」冲突** |
| 本轮实测 | KFF-D01 `REGRESSED` | **与「25/25 全部已修复并验证」冲突** |

`docs/current-status.md` 自称「接手人员**唯一**的当前状态入口」（L3），却**全文不含** `defect-ledger-round2-20260917.json`，也不含 KFF-R01…R05 中任何一项。因此 round2 的 5 项修复与 KFF-R02 的未完成状态，从「唯一入口」不可见。

**没有任何自动检查会因上述矛盾而失败** —— 见 3.3 的机制分析。

---

## 6. 台账基线字段不受校验（实测）

`docs/defect-ledger.json` 的 `baseline` 字段：

```json
{
  "branch": "codex/facebook-foundation",
  "source_commit": "891f399a9c81aafb2d960046f1e3214dd893bf68",
  "package_version": "0.1.53",
  "note": "The audit pinned origin/main at the same commit. Working-tree changes are uncommitted repairs; they are not yet a released package, so no release_id is claimed for them."
}
```

三处均与 AUDIT SHA 上的事实不符：

1. `source_commit` 落后 HEAD **3 个提交**。
2. `note` 称 "origin/main and this branch were both at [891f399]" —— 实测 `origin/main` 在 `e1f5285c`，而 `891f399` 是 `e1f5285c` 的父提交。该陈述不准确。
3. `note` 称修复是 "uncommitted working-tree changes" —— 实测 round2 修复**已提交**（`0ddd8d1`）。

`verify-planning.ts` 的 `verifyDefectLedger()` 的类型注解（L64-69）**不包含 `baseline`**，因此该字段完全不受校验。

注意佐证：`docs/defect-ledger-round2-20260917.json:9` 自己也说 "origin/main and this branch were both at e1f5285 when this round started" —— 这与 round1 台账的 `source_commit: 891f399` 直接矛盾。

---

## 7. 命名冲突（需规划侧裁定）

`docs/current-status.md:39` 提到：

> 历史上以 **R01–R12** 描述的能力，本轮不重述为「已做/未做」……

而 round2 台账使用 **KFF-R01…KFF-R05** 作为**缺陷编号**。

两套 `R0x` 编号共存于同一仓库的当前文档中，语义不同（一套是历史能力描述，一套是本轮缺陷 ID）。**存在引用歧义风险**：例如 "R02" 可能指历史能力 R02，也可能指 round2 的 Guardian 缺陷 KFF-R02。

本轮在 `findings.json` 中一律使用 `KFF-B00-xxx` 编号以避免叠加歧义。建议规划侧对历史 R01–R12 做显式改名或标注。

---

## 8. 关于「P1-B」

用户交接中提到的 **P1-B** 在仓库 `docs/` 内不存在（`grep -rn "P1-B" docs/` 无命中）。

**判定：P1-B 是审计输入包（GPT 侧）中的标签，不是本仓库的产物。**

用户对该项的指示（「探针没有输出」只是证据之一，不得据此推导出第二套调用链或缓存问题）本轮已遵守：

- 本轮**没有**基于「探针无输出」做任何推断。
- 本轮改用**最小、可重复的故障注入**（真实 spawn ENOENT + first-party 开关对照），把该问题定位到 `guardian.ts:59` 的 `error` 分支。
- 本轮**没有**引入第二套执行系统，**没有**基于缓存做假设。
- 与 GPT 侧的「tsx 缓存」假设相关的自述见 `docs/evidence/audit-repair-round2-20260917.json:68`（"the tsx compile cache under %TEMP% was cleared (5351 files) and the injection still did not activate"）。本轮实测给出了一个不依赖该假设的解释：**注入开关本身工作正常**（probe 实验 3 实测 `fault_switch_active: true` 且记录正确写入），因此 round2 当时「注入未激活」的原因不必然是可达性问题，更可能与当时的 harness 用法有关，而**该 harness 已被撤回**，无法复核。

---

## 9. 汇总表

| 条目 | 历史状态声明 | 本轮判定 | 依据 |
|---|---|---|---|
| KFF-R01 | repaired_and_verified | **PARTIALLY_FIXED** | 4 项声称成立，但规则族仍有新形态缺陷（B00-001） |
| KFF-R02 | partially_repaired | **PARTIALLY_FIXED** | 自述属实；本轮定位到 error 分支未覆盖（B00-002） |
| KFF-R03 | repaired_and_verified | **CANNOT_VERIFY** | 需真实/仿真浏览器，本轮未执行 |
| KFF-R04 | repaired_and_verified | **PARTIALLY_FIXED** | ASCII 成立；Unicode 与日期误判未覆盖（B00-008） |
| KFF-R05 | repaired_and_verified | **CANNOT_VERIFY** | 需隔离数据库，本轮未执行 |
| KFF-B05 | repaired_and_verified → partially_reopened | **PARTIALLY_FIXED** | 与 round2 一致 |
| KFF-B06 | repaired_and_verified | **FIXED** | 实测 GBP 与 USD 均被过滤 |
| KFF-D01 | repaired_and_verified | **REGRESSED** | 同类缺陷重现，且校验器结构上无法捕获（第 3 节） |
| KFF-D02 | repaired_and_verified | **FIXED** | 合计口径已写明且被强制 |
| 其余 18 项 round1 条目 | repaired_and_verified | **CANNOT_VERIFY** | 本轮未复核，不计入 Bug |
| P1-B | （不在仓库内） | **不适用** | 审计输入包标签 |

**统计：FIXED 2 / PARTIALLY_FIXED 4 / REGRESSED 1 / CANNOT_VERIFY 24**

> `CANNOT_VERIFY` **不计入 Bug 数**。

---

## 10. 证据路径

| 内容 | 路径 |
|---|---|
| 本轮探测的原始输出 | `C:\Users\17731\Desktop\KFF-Audit-B00-20260917\evidence\*.json` |
| 探针源码 | `…\repro\*.ts` |
| 覆盖缺口 grep 取证 | `…\test-results.md` 第 4.3 节 |
| 文档基线一致性实测 | `…\test-results.md` 第 4.4 节 |
| 本轮缺陷清单 | `…\findings.json` |

**AUDIT SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`**
