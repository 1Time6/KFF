# repair-plan.md — 修复规划（B01–B05）

> ## ⚠️ 本轮**不执行任何修复**
> 用户指示：「本轮只执行 B00：补充独立审计和验证缺口。暂时禁止修改正式业务代码。」
> 本文件是**规划产物**，供规划侧（GPT-5.6 Sol）审定后下发。**本审计方未改动一行正式业务代码**，仓库工作树在本轮全程干净。

审计 SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`

---

## 0. 批次总览

| 批次 | 主题 | 缺陷 | 性质 |
|---|---|---|---|
| **B01** | Guardian / Agent 恢复 | 002, 003, 004, 005 | 1×P1 + 3×P2 |
| **B02** | AI 接待 | 001, 006, 007, 008 | 2×P1 + 2×P2 |
| **B03** | Facebook 主链断点 | 010, 011 | 2×P2 |
| **B04** | 全量回归 + 验证缺口 | 009, 012, 013, 014, 015 + M1–M8 | 3×P2 + 2×P3 + 8 项测试 |
| **B05** | 2 账号受控试点 | — | **仅规划** |

### 0.1 必须先决定的三个前置问题（规划侧输入）

| # | 问题 | 影响 | 若不定会怎样 |
|---|---|---|---|
| **Q1** | 「限定类型的拒绝」（如「不要再给我发广告了」）应路由到 **HANDOFF** 还是升级为**全局退订**？ | 决定 `KFF-B00-006` 的修复方向 | 修错方向会过度丢弃客户或让 AI 继续骚扰 |
| **Q2** | 真实 Messenger 输入框的 **role 实际是什么**（textbox / combobox / 无 role）？ | 决定 `KFF-B00-011` 的修复方向 | **仓库内无此证据**（CV-09）。在缺少该事实的情况下改定位器，等于用猜测替换猜测 |
| **Q3** | 已写库的 `OPTED_OUT` 是否需要人工复核？ | `KFF-B00-001` 的验收条件之一 | 修复了规则但历史误判客户永久沉默 |

> Q1/Q2 需要规划侧或一次受控真实页面观察；**本轮无法提供**（未接触真实 Facebook）。

---

## B01 — Guardian / Agent 恢复

### B01-1　`KFF-B00-002`（P1, CONFIRMED, 历史 NOT_FIXED）—— 最高优先级

| 项 | 内容 |
|---|---|
| 文件 | `apps/agent/src/guardian.ts` |
| 函数 | `runGuardian` |
| 行号 | `L37`(spawn) / `L59`(`child.once('error')`) / `L60-78`(`exit` 回调内的全部终止证据逻辑) / `L71-75`(启动失败记录写入) |
| 触发条件 | `spawn` 无法派生进程（实测：`cwd` 指向不存在路径 → libuv ENOENT）。同类：node.exe 被替换/隔离、目录被删、fd 耗尽 |
| 实际行为 | 发出 `error:ENOENT` + `close:-4058`，**从不发 `exit`** → L60 回调不执行 → 不写启动失败记录 → L59 以裸 ENOENT 拒绝 → `main.ts:73` 的 `flushJournal()` 被跳过 → journal 永久停在 `phase:'claimed'` 无 closure → `main.ts:82` 每次返回 false → **无限 `GUARDIAN_UNCONFIRMED`，重启不自愈** |
| 预期行为 | 与「子进程启动阶段退出」同一处置：写 `kff.guardian-closure-startup-failed.v1`(`context_opened:false`)，使条目可获终止证据并 quiesce |
| 跨模块原因 | ① `guardian.ts` 把全部终止证据逻辑挂在 `exit` 上，而 Node 的 spawn 失败不发 `exit`；② `main.ts:73` 的 `await flushJournal()` 位于 `try/finally` **之外**，拒绝时被跳过 |
| 影响范围 | **主业务链永久阻塞**：采集、受控互动、Inbox 回复全部停止；controller 全程未被通知（`controller_calls_made: []`），控制端无法自行发现 |
| 最小复现 | `node node_modules/.bin/tsx ../KFF-Audit-B00-00917/repro/probe-guardian.ts`（覆盖 `process.cwd` 制造真实 ENOENT，不打补丁、不引入第二套执行系统） |
| 证据 | `evidence/guardian-probe.json`（run1 + run2 双次一致） |
| 需补测试 | ① error 分支后必须写入 startup-failure 记录且 `flushActionJournal` 返回 true；② 同一故障下 Agent 必须能继续接单；③ 重启后该条目已 quiesce；④ 新增用例必须真实产生 `error` 事件（而非 `exit`） |
| 最小修复 | 把 L60 `exit` 回调中的终止证据逻辑提取为可复用的 `handleTermination()`，在 L59 `error` 回调中一并调用；`error` 分支需先判定 `child.pid` 是否存在，以区分「未派生」与「已派生但通信失败」 |
| 允许涉及文件 | `apps/agent/src/guardian.ts`（`main.ts:73` 的移入 try 内建议**同批**，但属独立改动，须单列评审） |
| 依赖 | 无。不涉及数据库、迁移、控制端协议 |
| 风险 | **若把 error 一律当「启动失败」，可能在子进程仍持有浏览器上下文时提前释放隔离。** 必须在回调内区分 `child.pid` |
| 回退 | 单文件 `git revert`。**因为改错方向的后果是隔离被提前释放，本条的回归优先级最高** |
| 验收 | ① error 分支后记录存在且 `context_opened:false`；② `flushActionJournal` 返回 true，Agent 继续接单；③ 子进程已派生但 send 失败时，必须证明浏览器上下文已关闭或子进程已终止；④ CI 中真实产生 `error` 而非 `exit` |

> ### ⛔ B01-1 的一个隐藏陷阱（本轮新发现，必须写进修复工单）
> `supabase/migrations/20260911175746_g1_agent_slot_guard.sql` 全文只有一行：
> ```sql
> CREATE UNIQUE INDEX agent_single_execution_slot ON kff.agent_commands(agent_id) WHERE state IN ('READY','CLAIMED');
> ```
> 即**一个 agent 在 `READY`/`CLAIMED` 状态最多只能有一条命令**。
>
> 后果：卡死的命令**同时占住应用层的 journal 门和数据库层的执行槽位**。因此修复**不能靠「再插一条补偿命令」**——必须先让卡住的命令**退出 `CLAIMED` 状态**，否则补偿插入会直接违反该部分唯一索引。
> 任何热修复脚本若绕过这一点，会在生产上撞到唯一约束冲突而失败。

---

### B01-2　`KFF-B00-003`（P2, CONFIRMED, 历史 PARTIALLY_FIXED）

| 项 | 内容 |
|---|---|
| 文件 | `apps/agent/src/guardian-protocol.ts` |
| 函数 / 行号 | `closureProof` (L76-78) / `compactClosure` (L79-91) |
| 触发条件 | 存在 `startup-failed.v1`(`context_opened:false`) 记录，且该命令随后 flush（`closureProof` 改写协议）或被压缩（`compactClosure`） |
| 实际行为 | `closureProof` 无条件把协议改写为 `kff.guardian-closure.v1`，丢弃 `context_opened`；`compactClosure` 硬编码 `context_closed: true` |
| **本轮重要收窄** | 压缩**之前** `readClosure` 是**正确的**（probe-2 实测抛 `GUARDIAN_STARTUP_FAILED`）。区分在**传输**与**压缩**两个环节被销毁，且压缩**仅对 collection/inbox 形状可达**（message 形状被 `action-journal.ts:19` 守卫跳过，实测 `reached_compaction: false`） |
| 跨模块原因 | `core/reconciliation.ts:19 recordQuiescence` 依据该证据把 `environments.browser_status` 置为 `CLOSED` |
| 影响范围 | 取证/审计完整性，非运行安全 |
| 最小复现 | `node node_modules/.bin/tsx ../KFF-Audit-B00-.../repro/probe-guardian-2.ts` |
| 证据 | `evidence/guardian-probe-2.json` |
| 需补测试 | ① `closureProof` 对 startup-failed 必须保留「从未打开」语义或拒绝处理；② `compactClosure` 不得把 `context_opened:false` 压成 `context_closed:true`；③ collection 形状压缩后仍可辨 |
| 最小修复 | `closureProof` 拒绝 startup-failed 记录（或在输出保留 `context_opened`）；`compactClosure` 依源记录取值而非硬编码 |
| 允许涉及文件 | `apps/agent/src/guardian-protocol.ts`, `apps/agent/src/action-journal.ts`, `tests/unit/action-journal.test.ts` |
| 依赖 | 与 004 同属启动失败证据链，**建议同批** |
| 风险 | 输出形状变化会影响 `reconciliation.ts` 的 quiescence 校验；须同步确认 zod schema（`guardian-protocol.ts:27-32`）兼容 |
| 回退 | 单文件 `git revert` |

---

### B01-3　`KFF-B00-004`（P2, CONFIRMED）—— 验证缺口

| 项 | 内容 |
|---|---|
| 文件 | `apps/agent/src/guardian.ts` L19-28（`guardianStartupFaultInjection` / `guardianStartupFaultInjectionEnabled`） |
| 触发条件 | 静态事实，`grep` 可复现 |
| 实际行为 | L27 注释声称 "Exported for the unit contract that pins every condition this switch must satisfy"，但 **`tests/` 下对 `guardianStartupFaultInjection`、`guardianStartupFaultInjectionEnabled`、`saveStartupFailure`、`KFF_TEST_GUARDIAN_DIES_BEFORE_READY`、`GUARDIAN_STARTUP_FAILED`、`compactClosure`、字符串 `startup-failed` 的命中数全部为 0**（本轮逐符号实测）。本机 386 个 closure 文件中 startup-failed 记录 **0** 个 |
| 自述 | `docs/evidence/audit-repair-round2-20260917.json:67` 自述该 spec "was withdrawn with the injection work"；L68 自述清缓存 5351 文件后 "the injection still did not activate" |
| 根因 | 注入 spec 因未能激活被撤回（未作为 failing/skipped 提交），但导出与注释留在源码 |
| 跨模块原因 | 三个条件中含一个**安全边界**：runtime 必须位于 `<KFF_ROOT>/.kff/agent-process-tests/` 内，且必须用 `path.relative` 判定，以便让 `.kff/agent-process-tests-production` 这类**兄弟目录保持封死**。该边界**无任何测试保护**——将来有人换成 `startsWith`，不会有测试失败 |
| 影响范围 | 验证缺口 + 安全边界失去回归保护。**这也是 002 为何长期未被发现的结构性原因** |
| 需补测试 | ① 三个条件各自的反例；② `.kff/agent-process-tests-production` 兄弟目录必须保持封死；③ 启动失败路径的进程级端到端回归；④ 002 的 error 分支回归 |
| 最小修复 | **先修 002 行为，再补测试**；随后恢复条件测试，或删除 L27-28 的导出与注释使声明与事实一致 |
| 顺序约束 | ⚠️ **必须先修行为再补测试**，否则会把当前错误行为固化成断言 |
| 回退 | 不适用（不改生产行为） |

---

### B01-4　`KFF-B00-005`（P2, CONFIRMED, 历史 **REGRESSED**）—— 本轮头条历史发现

| 项 | 内容 |
|---|---|
| 文件 | `docs/current-status.md` + `scripts/verify-planning.ts` |
| 行号 | `current-status.md` L3(自称唯一入口) / L10(声明 SHA) / L18(只指向 round1 台账) / L27(统计声明) |
| 实际行为 | ① L10 声明 `891f399a…`，而 HEAD 是 `752042bc…`，**落后 3 个提交**；② `891f399` 是 `e1f5285`（**审计基线本身**，即 `origin/main` 与被审分支的合并基点）的**父提交** → 该页声明的树比被审基线**还早一代**；③ L18 只指向 `docs/defect-ledger.json`，全文未出现 round2 台账或 KFF-R01..R05 任何一项；④ L27 声明「25 项 = 已修复并验证 25」，而 round2 台账 L22 自述外部审计**只能核实 3 项**、其余 21 项 `CANNOT_VERIFY`，L20 另记 `KFF-B05 = partially_reopened` |
| 根因（实测） | `verify-planning.ts` L63-70 **只校验 `docs/defect-ledger.json` 的存在与 schema_version**，**从不读取 `current-status.md`**，也不校验该页声明的源码提交（L34 的 `git rev-parse HEAD` 仅用于自身记录）。**因此该页变陈旧时没有任何检查会失败。** |
| 为何是 REGRESSED | round1 的 `KFF-D01` 修的正是**这一类**缺陷，改了 `verify-planning.ts`，并被标为 `repaired_and_verified` 且 `unverified: []` —— 但它加的检查校验的是**台账内部一致性**，不是**入口页的基线**。于是同一缺陷类**复发而没有任何检查失败** |
| 影响范围 | 接手指引失真 + 验证债不可见。与 002/004 构成闭环：缺陷修得不完整，**且不完整这件事也不可见** |
| 需补测试 | `verify-planning` 增加三项：① `current-status.md` 声明的提交必须等于 HEAD（或显式声明差异与理由）；② 若存在 `defect-ledger-round2-*.json`，该页必须引用或显式声明排除；③ 该页的统计声明必须与所指向台账的计算结果一致 |
| 最小修复 | 更新 SHA 为 HEAD；显式登记 round2 台账与 KFF-R02 未完成状态；把上述三项加入 `verify-planning.ts` |
| **顺序约束** | ⚠️ **建议在 B01 代码合并之后再定稿该页**，否则 SHA 立即再次漂移 |
| 风险 | 只把 SHA 更新为 `752042bc` 会用**准确 SHA 包装出不准确的完成度**。必须同时登记 round2 的未验证范围 |
| 回退 | 纯文档 + 校验脚本，`git revert` |

---

## B02 — AI 接待

### B02-1　`KFF-B00-001`（P1, CONFIRMED, 历史 PARTIALLY_FIXED）

| 项 | 内容 |
|---|---|
| 文件 | `packages/adapters/src/reception-model.ts` |
| 函数 / 行号 | `optOut`(L33) / `bareStop`(L39-53，L48 有否定守卫) / `explicitContactExit`(L54) |
| 触发条件 | 客户发送含**中文弯引号 U+2019** 的英文退订句；或 `Don't message me again.`；或 `No more messages please.`；或以 `don't stop`/`do not stop` + 联系类动词结尾的句子 |
| 实际行为（实测） | `Please don’t contact me again.`(U+2019) → `explicitContactExit:false`, `ASK_QUESTION`；`Don't message me again.` → false；`No more messages please.` → false；**`Please don't stop messaging me.` → true / STOP**；**`Do not stop texting me.` → true / STOP**；ASCII 撇号版 `Please don't contact me again.` → true / STOP |
| 预期行为 | 前三条必须 STOP/OPTED_OUT（与 ASCII 版一致）；**后两条不得判为退订**（客户要求继续联系） |
| 根因 | ① `optOut` 用 ASCII 撇号 U+0027，全文**未对 U+2019 / U+02BC 归一化** → 同一句话仅因字符不同而结果相反；② `bareStop` L48 有 `if(/dontstop|donotstop/.test(compact))return false;` 而 **`optOut` 没有对应守卫**，且 `optOut` 的 `stop texting` 分支先于任何否定判断命中 → **同一文件内部规则不一致**；③ `'message me again'` / `'no more messages'` 不在短语表中 |
| 跨模块原因 | `core/facebook-inbound.ts:105-110` 在**摄入侧直接消费** `explicitContactExit`：命中即写 `stage=BLOCKED` / `OPTED_OUT` / `PAUSED` 并 opt out `contact_targets`。**误判方向会写库并永久丢弃客户，且写库不可自动回滚** |
| 影响范围（两方向） | 误判方向：把「请继续联系我」的客户**永久写成 OPTED_OUT** → 客户资产损失；漏判方向：客户明确说「别再联系我」后系统仍继续接待 → 符合用户 P1 定义「明确拒绝后仍继续联系」 |
| 严重性边界 | 见 `KFF-B00-007`：真实浏览器试点路径对 AI 自动回复有**四重封堵**，本条在该路径为**潜伏态**；对 `transport !== 'BROWSER'` 的连接与合成账号**可达** |
| 最小复现 | `node node_modules/.bin/tsx ../KFF-Audit-B00-.../repro/probe-reception.ts` |
| 证据 | `evidence/reception-probe.json`（run1 + run2 双次一致，40 条断言中 31 条符合、9 条不符合） |
| 既有测试为何没发现 | `tests/contracts/reception-model.test.ts:18-37` 的既有回归守卫本轮**全部仍通过（未回归）**，但它们只覆盖 ASCII 撇号与显式短语，**未覆盖 U+2019，也未覆盖 `don't stop + 动词` 这一否定形态** |
| 需补测试 | ① U+2019/U+02BC 与 ASCII 同判；② `Don't/Do not stop <verb>ing me` 一律不得判为退订；③ `Don't message me again` / `No more messages please` 必须判为退订；④ 对 `optOut` 与 `bareStop` 施加**同一组**否定守卫参数化用例，**防止两者再次分叉** |
| 最小修复 | 在 `explicitContactExit` 入口做一次撇号归一化（U+2019/U+02BC → U+0027）；把 `bareStop` 的否定守卫提升为两者**共用**的前置判断；补齐两条短语 |
| 允许涉及文件 | `packages/adapters/src/reception-model.ts`, `tests/contracts/reception-model.test.ts` |
| 风险 | 放宽/收紧短语表都会改变已有客户的退订判定；风险集中在**过度收紧导致真实退订被漏判** |
| 回退 | 单文件纯函数，`git revert`；无数据迁移、无 schema 变更 |
| 验收 | ① 5 条 actual 全部翻转为 expected；② L18-37 既有守卫保持通过（**不得回归**）；③ 新增撇号与否定形态参数化用例；④ 对「已写库的 OPTED_OUT 是否需人工复核」给出明确处置意见（**本轮不执行数据修复**） |

---

### B02-2　`KFF-B00-006`（P1, CONFIRMED, 历史 CANNOT_VERIFY）

| 项 | 内容 |
|---|---|
| 文件 | `packages/adapters/src/reception-model.ts` |
| 函数 / 行号 | `localReceptionRules`(L78-88) / `enforceReceptionDecision`(L55-77) |
| 触发条件 | 客户发送**限定类型的拒绝**：「不要再给我发广告了」 |
| 实际行为（实测） | `explicit_contact_exit: false`；`local_rules_action: ASK_QUESTION`；`intent: OTHER`；`reason: 需要进一步了解客户需求`；模型回复时 `enforce → REPLY` |
| 预期行为 | 负面偏好表达应**至少进入人工接管（HANDOFF）** |
| 根因 | `localReceptionRules` 只识别「全局退订」与显式 HANDOFF 触发词，**对「限定类型的拒绝」没有分支**，落入默认 `ASK_QUESTION` |
| 跨模块原因 | `core/reception-worker.ts:70 completeReception` —— 除 STALE/STOPPED/DRAFT_READY/DECIDED 之外**一切分支都调 `queueConversationReply`**。因此 `ASK_QUESTION` 会**实际排入一条回复**，而非转人工。**这不是纯规则问题。** |
| 影响范围 | 客户明确表达「别再给我发广告」后，系统以「需要进一步了解客户需求」继续接触 → 符合 P1「明确拒绝后仍继续联系」 |
| 政策依赖 | **是否应按退订处理由规划侧决定（Q1）**。本轮把**可执行行为**标为 CONFIRMED，政策判定留给规划侧 |
| 既有测试为何没发现 | `tests/contracts/reception-model.test.ts:40` 用例名为 `'keeps a marketing-only Chinese opt-out for human review: %s'`，**断言却只有 `expect(explicitContactExit(text)).toBe(false)`** —— 用例名声称的行为（for human review）**没有任何断言**。一条名称与内容不符的用例长期给出虚假覆盖感 |
| 需补测试 | ① 「不要再给我发广告了」必须产生 HANDOFF（或经政策确认的其他明确分支），**不得为 ASK_QUESTION**；② 断言必须覆盖用例名所声称的行为；③ 同类限定拒绝参数化（「别再给我推销」「不要发促销」） |
| 最小修复 | 在 `localReceptionRules` 增加「限定类型拒绝」分支路由到 HANDOFF；**同时修正 L40 用例使其断言实际声称的行为** |
| 依赖 | **先答 Q1** |
| 风险 | 升级为全局退订会过度丢弃客户；只转人工则依赖人工及时处理。**方向须由规划侧决定** |
| 回退 | 单文件纯函数，`git revert` |

---

### B02-3　`KFF-B00-008`（P2, CONFIRMED, 历史 PARTIALLY_FIXED）

| 项 | 内容 |
|---|---|
| 文件 / 函数 / 行号 | `packages/adapters/src/reception-model.ts` / `enforceReceptionDecision` / **L74** |
| 触发条件 | AI 回复中出现**全角 Unicode 电话/IDN 域名**；或出现 ISO 日期 |
| 实际行为（实测） | **泄漏**：`Visit 例子.中国` → REPLY；`Call ＋４４ ７７００ ９００１２３` → REPLY。**误判**：`Your appointment is on 2026-09-17.` → HANDOFF |
| 预期行为 | 前两条 HANDOFF；**日期必须 REPLY**（用户点名要求重点检查的情形） |
| 已正确工作 | 9 条已正确过滤：`example.com`、`www.example.com`、`+44 7700 900123`、`07700 900123`、`sales@example.com`、`wa.me/15550001111`、`https://example.test`、`£48`、`48 USD`。7 条普通文本全部 REPLY：`We have been open since 1998.`、`Happy birthday! Is it the 48th?`、`The package includes 2 items.`、`Sure, I can help with that.`、`Version 1.2.3 was released.`、`I am 34 years old.`、`That costs 2.5 percent more.` |
| 根因 | ① 过滤基于 ASCII 数字区间与显式 scheme，**未对全角数字（U+FF10–FF19）与全角加号（U+FF0B）归一化**；域名判定不覆盖 IDN（非 ASCII 标签 + 非 ASCII TLD）；② `2026-09-17` 的分段数字形态落入电话号码判定 |
| 跨模块原因 | 误判方向（日期→HANDOFF）代价是转人工，**是安全方向**（损失人工注意力而非正确性）；泄漏方向会把联系方式送进客户可见回复 |
| 影响范围 | 泄漏方向的现实影响取决于 provider 是否真会产出全角形态（**CV-02：本轮未调用任何真实模型**）。误判方向是可确认的即时成本 |
| 最小复现 | 同上探针，见 `reception-probe.json` 的 `filter_cases` |
| 既有测试缺口 | `tests/contracts/reception-model.test.ts:46-48` 覆盖 ASCII 目的地与普通文本，**未覆盖全角数字、IDN、ISO 日期** |
| 需补测试 | ① 全角数字/加号归一化后必须被过滤；② IDN 必须被过滤；③ **ISO 日期、版本号、年龄、小数、订单号必须不被过滤**；④ 既有 ASCII 用例全部保持通过 |
| 最小修复 | 过滤前做 **NFKC 归一化**；域名判定扩展至 IDN；电话判定中排除 ISO 日期形态（如 `\d{4}-\d{2}-\d{2}`） |
| 风险 | 过滤是启发式的。收紧↑误判，放宽↑泄漏。**NFKC 会改变其他规则对同一文本的判定，必须回归全部既有用例** |
| 回退 | 单文件纯函数，`git revert` |

---

### B02-4　`KFF-B00-007`（P2, CONFIRMED）—— 不是缺陷，是**必须固化的安全设计**

| 项 | 内容 |
|---|---|
| 文件 / 行号 | `core/facebook-inbound.ts:25`(configure) / `:61`(canReply) / `:116`(排队)；`core/lead-reception.ts:106`(conversationControl) / `:136-137`(queueConversationReply) |
| 内容 | 真实浏览器试点路径对 AI 自动回复存在**四重封堵**：① 真实 BROWSER 账号必须 `!auto_reply`；② `canReply` 对非合成 BROWSER 为 false，故不排队接待；③ `conversationControl` 拒绝非合成 BROWSER 的 AI 模式（`SOURCE_NOT_CONFIGURED`）；④ `queueConversationReply` 要求 `prepare_only && actor_kind==='HUMAN' && contact_permission_id && account_type==='profile'`（否则 `CONTACT_BASIS_MISSING`） |
| 裁定 | **四重封堵是正确的安全设计，不是缺陷** |
| 两个后果 | ① 把 001/006 在真实浏览器试点路径上的严重性限定为**潜伏态**；② 意味着接待类规则缺陷**不可能**在真实路径上被端到端测试暴露 → **「真实路径已验收」不能作为这些规则的证据** |
| 需补测试 | ① 断言真实 BROWSER 账号不得开启 AI 自动回复；② **断言四道封堵中任意一道被移除时测试失败**（当前四道各自独立，**无测试保证它们同时存在**） |
| 最小修复 | n/a。建议把四重封堵固化为显式断言，避免被无意移除 |
| 允许涉及文件 | `tests/` |
| 风险 | 无（仅补测试） |

---

## B03 — Facebook 主链断点

> B03 的两条同源：写路径定位器与读路径探针的接受集合不一致，导致「读侧认为可用」的输入框「写侧找不到」。

### B03-1　`KFF-B00-011`（P2, CONFIRMED）—— 英文界面 / combobox 形态下**发送能力完全不可用**

| 项 | 内容 |
|---|---|
| 文件 / 行号 | `packages/adapters/src/facebook-inbox-directory-dom.ts` **L94-101**(读探针接受集合) / **L63**(读侧 squash) / **L23-25**(`composerNamePattern`)；`packages/adapters/src/facebook-browser-message.ts` **L30**(写定位器) |
| 触发条件 | ① 真实 Messenger 输入框以 `role=combobox` 暴露，或以裸 `contenteditable` 暴露而无 textbox 角色；② Facebook 界面语言为**英文**（标签形如 `Message Alice`） |
| 实际行为 | **读侧** L96 查询 `[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]`，L63 用 `replace(/\s+/g,'').toLowerCase()` 归一化 → **接受** combobox/无 role，且**大小写不敏感**。**写侧** L30 只有 `page.locator('main').getByRole('textbox',{name:composerNamePattern(...)})`，而 L23-25 的正则**未加 `i` 标志** → `Message Alice` 与 `^(?:...|message)\s*Alice$` 不匹配（`M` ≠ `m`）。两个分歧都使写侧 `count()===0` |
| 预期行为 | 读侧与写侧对「哪个输入框是目标」必须给出同一答案；写侧无法寻址读侧已接受的输入框时，应报出**定位器分歧本身** |
| 方向 | 两个分歧都 **fail-closed**：写侧阻塞，**不会误发到错误线程** |
| 根因 | 同一规则被实现了**两份**：读侧是 DOM 遍历 + 归一化比较，写侧是 Playwright role 定位器 + 未归一化正则。文件 L4-10 的注释声称两者共用同一套规则，但共用的只是**前缀表与 peer 名**，**role 范围与大小写敏感度并未共用** |
| 跨模块原因 | 英文形态现实可达：环境 locale 校验（`environment-child.ts:32-35`）**不会阻止 Facebook 自身以英文渲染**——仓库内已有实例：某真实 profile 配置 `locale: en-US` 却抓到中文标签（`docs/evidence/c-inbox-fixed-043-20260914.json:31`），说明 **Facebook UI 语言与浏览器 locale 相互独立** |
| 影响范围 | 英文界面或 combobox 形态下**整个发送能力不可用**（阻塞而非误发）。KFF 目标市场含中英客户 → **功能性缺口**，非纯诊断问题 |
| 既有测试为何没发现 | `facebook-composer-consistency.spec.ts` 的 7 条用例**全部为中文标签**；唯一英文用例在 `facebook-inbox-directory.spec.ts:205` 且**只覆盖读侧**。该 fixture 用手写 `<main>` 合成 DOM，**不覆盖真实 Messenger 的 role 形态** |
| 需补测试 | ① 读侧接受的每一种 role 形态都必须能被写侧寻址，否则必须报出分歧；② 英文标签的**写侧**定位器用例；③ 既有中文用例不得回归 |
| 最小修复 | 让写侧复用读侧接受集合：给 `composerNamePattern` 加 `i` 标志并对 peer/前缀做同一套 squash，或改为复用读侧同一套 DOM 探针 |
| **依赖（阻塞项）** | **Q2**：真实 Messenger 的输入框 role 是什么？**仓库内无此证据（CV-09）**。在缺少该事实时改定位器等于用猜测替换猜测 → **建议该项修复前先做一次受控真实页面观察（属 B05 范畴）** |
| 风险 | 放宽写侧定位会降低「不唯一即拒绝」的严格性；**必须保持 `count>1` 时仍拒绝**（`THREAD_COMPOSER_AMBIGUOUS`） |
| 回退 | 单文件 `git revert`。**改错方向会导致定位到非目标输入框，回退优先级高** |
| 验收 | ① 读侧接受的任一 role 形态写侧均能寻址或明确报出分歧；② 英文标签下写侧可寻址；③ **`count>1` 仍拒绝，不得退化为「取第一个」**；④ 既有中文 fixture 全部通过 |

---

### B03-2　`KFF-B00-010`（P3, CONFIRMED）—— 误报 `DRAFT_PRESENT`

| 项 | 内容 |
|---|---|
| 文件 / 函数 / 行号 | `packages/adapters/src/facebook-browser-message.ts` / `executeFacebookBrowserMessage` / **L32** |
| 实际代码 | `requireCondition(await editor.count()===1&&!(await editor.innerText()).trim(),'DRAFT_PRESENT','原会话已有草稿，请先人工处理');` |
| 触发条件 | `count()===0`（成因可为：输入框确实不存在 / B03-1 的 role 分歧 / B03-1 的大小写分歧）或 `count()===1` 但已有文本（**这一种报告是正确的**） |
| 实际行为 | `count===0` 时 `count()===1` 为 false → 条件 false → 抛 `DRAFT_PRESENT`「原会话已有草稿，请先人工处理」。**操作员被要求清理一个并不存在的草稿**，照做无法解决，且系统不提供真实原因 |
| 预期行为 | 输入框不存在或定位器无法寻址时应报出**可辨原因**（如 `THREAD_COMPOSER_ABSENT`），与「已有草稿」区分 |
| 根因 | 两条语义不同的前置条件被 `&&` 合并进一个 `requireCondition`，并**共用同一个错误码与文案**。`count===0` 与「有草稿」在布尔上无法区分 |
| 跨模块原因 | 与 B03-1 同源叠加时，操作员会看到一个**既无法解释也无法处理的死胡同** |
| 影响范围 | 诊断与人工处置效率。方向安全（一律阻塞，不会误发） |
| 最小复现 | 源码事实，无需运行：读 L32 即可 |
| 需补测试 | ① `count===0` 必须抛专门错误码，不得为 `DRAFT_PRESENT`；② `count===1` 且已填文本时仍必须为 `DRAFT_PRESENT`；③ 两种情形必须可区分 |
| 最小修复 | 拆成两个 `requireCondition`：先断言 `count()===1`（失败报 `THREAD_COMPOSER_ABSENT`），再断言无草稿（失败报 `DRAFT_PRESENT`） |
| 依赖 | **与 B03-1 同批**，否则只改错误码仍会让操作员面对「读侧说可用、写侧说没有」的矛盾 |
| 回退 | 单文件 `git revert` |

---

## B04 — 全量回归 + 验证缺口

### B04-1　`KFF-B00-012`（P2, CONFIRMED）—— 测试名称与覆盖范围不符

| 项 | 内容 |
|---|---|
| 文件 | `tests/integration/real-browser-message.test.ts` |
| 实测事实 | `grep -c 'executeFacebookBrowserMessage' <该文件>` → **0**。该测试的 import 清单中**没有任何 `packages/adapters` 的导入**（只 import `scripts/migrate`、`scripts/seed`、`@kff/database`、`@kff/contracts`、`@kff/core` 与 `packages/core/src` 下的领域函数） |
| 它实际测什么 | **纯 Postgres 契约测试**：手工构造 `inbox_page` 报告对象与 `browser_message` 回执对象，断言数据库管线（许可、`acceptReport` 校验、echo 归并、幂等去重、UNKNOWN_OUTCOME 隔离、adjudication） |
| 同类 | `tests/integration/messenger-pilot.test.ts` 同为纯数据库姿态（自设 `KFF_FACEBOOK_APP_SECRET` 伪造已签名 webhook） |
| 唯一的执行器测试 | `tests/contracts/facebook-browser-message.test.ts:21-24`，**仅**断言 `KFF_ENABLE_LIVE` 关闭时执行器以 `LIVE_DISABLED` 拒绝 |
| 影响范围 | **验收与发布决策所依赖的证据基础。** 任何以「有 real-browser-message 测试」为由认定浏览器链路已验收的判断都不成立 |
| 需补测试/改动 | ① 若保留该名称，应至少有 1 条测试真实调用 `executeFacebookBrowserMessage`（哪怕只是 fail-closed 断言）；② 或重命名为 `browser-message-pipeline.test.ts` 使名称与覆盖一致；③ 对 `facebook-composer-consistency.spec.ts` **显式标注「合成 DOM，不证明真实 Messenger」** |
| 最小修复 | 重命名或显式声明覆盖边界。**不建议为此引入真实浏览器依赖**（属 B05 范围） |
| 风险 | 重命名会影响 CI 脚本与 `package.json` 中的套件划分，需同步 |

### B04-2　`KFF-B00-013`（P2, CONFIRMED）—— RLS 三出口边界无自动检查

| 项 | 内容 |
|---|---|
| 文件 / 行号 | `packages/database/src/index.ts`：`query`(**L11**) / `transaction`(**L12-17**) / `scoped`(**L18-24**，隔离开关在 **L21** `SET LOCAL ROLE kff_app`) |
| 实测事实 | 只有 `scoped()` 切换角色；`query()`/`transaction()` 均以 `DATABASE_URL` 用户身份运行（L8 的 `options` 仅 `-c timezone=UTC`，不含 role）。分布：`scoped()` **190+ 处**（core 域层人驱动路径）；裸 `transaction()` **32 处**；裸 `query()` **14 处** |
| 本轮核对 | **32 处 `transaction()` 全部属于「worker 跨租户认领队列」；14 处 `query()` 全部属于「作用域尚不存在的前置解析」（agent token、webhook page_id、`channelScope`、支付连接）。未发现误用。** |
| 裁定 | **这是自洽的架构，不是缺陷。** RLS 是**纵深防御层**，不是全局兜底；全局兜底仍是每个查询手写的 `WHERE organization_id=... AND brand_id=...` |
| 风险 | 不存在任何测试/lint/运行时断言能发现「本应用 `scoped()` 却用了 `query()`/`transaction()`」的新代码 |
| 需补测试 | **M1–M3、M7**（见下） |
| 最小修复 | n/a。补测试即可 |

### B04-3　`KFF-B00-009`（P3, HIGH_CONFIDENCE）—— 不完整构建产物

`dist/` 中 `kff-controller-0.1.53-win32-x64-2c82a35912bf` 与 `-e3d87581551d` **只有 `.zip.sha256`，无 `.zip` 也无目录**；`-984bc7dad026` 有 `.zip` 与校验和但无解包目录。成因 **UNVERIFIED**（本轮未调查）。
**风险提示：删除 `dist/` 内容属对用户环境的实质改动，本轮未执行任何 `dist/` 写操作。** 修复前需先确认这些 hash 是否被现场环境引用。

### B04-4　`KFF-B00-014`（P3, CONFIRMED）—— 支付模块人工闸位置（**仅知会，不修复**）

`payment-worker.ts:81` 自动创建 Stripe Checkout Session、`refund-worker.ts:40` 自动发起 Refund —— **人工确认发生在入队时刻，之后 worker 取出即发，没有第二次人工确认**。缓解：`cancelUnsubmittedRefund`（`refunds.ts:57`，admin 门控）可在未提交前取消。安全闸：`payments.ts:25` `LIVE_DISABLED` 默认关闭。

**属设计取舍（队列即授权），不是缺陷。** 但它位于「钱」的路径上，应单独知会产品。
**用户已明确：不得把完整支付重构列为 Facebook 试点前置条件。本项不进入 B01–B05 的修复范围。**

### B04-5　`KFF-B00-015`（P3, CONFIRMED）—— 集成测试的隔离边界（**本轮新增，且是本轮方法论的直接依据**）

| 项 | 内容 |
|---|---|
| 文件 / 行号 | `scripts/integration.ts` **L13**；`tests/integration/local-supervision.test.ts` **L73 / L78**；`tests/integration/existing-database.test.ts` **L31** |
| 实测事实（**分两半，缺一不可**） | **① 数据库隔离成立。** `scripts/integration.ts:13` 向子进程显式注入 `DATABASE_URL`（指向 `kff_test_<20hex>`）与 `KFF_TEST_DATABASE`，退出码为 0 时 `DROP DATABASE`；38 个集成测试中 37 个走 `migrate()`+`seed()` 建库。**任何测试都不会写用户日常库。** <br>**② 运行目录未隔离。** 同一行 `env` 又把 **`KFF_ROOT` 显式设为真实项目根** `path.resolve('.')`。于是 `local-supervision.test.ts:78` 用 `env: process.env` 派生的**真实 Worker**（`apps/worker/src/main.ts`）继承到真实根，其运行目录就是用户日常的 `.kff/`；而**同文件 L51** 的 Agent 用例却把 `KFF_ROOT` 钉到临时目录 —— 同一文件内两个用例策略不一致。 |
| 另外 | `local-supervision.test.ts:73` 与 `existing-database.test.ts:31` 以**固定文件名**把报告写进真实 `.kff/checks/`（`local-supervision-agent-<mode>.json`、`existing-database.json`），而该目录是仓库约定的共享证据目录 |
| 未发现 | 经全仓 `grep`，`existing-database.json` **只有该测试一个写入方**，不存在被它覆盖的「真实证据」。故本条**不是**证据污染缺陷 |
| 跨模块后果 | 若用户日常 Worker 正在运行，该用例会向同一 `.kff/` 派生第二个 Worker。是否互斥取决于 Worker 侧是否持有 `process.lock`（Agent 侧确有）—— **本轮未核实（CV-11）** |
| 影响范围 | 仅影响测试/审计的隔离性与可复现性，**不影响生产运行路径，不写用户日常库** |
| **为什么必须收录** | 这是本轮判定「不能执行集成套件」的**具体依据，而依据不是数据库**。用户要求「如果无法证明和用户日常环境隔离：不要执行」——本条给出了该证明的边界在哪 |
| 需补测试 | ① 断言集成测试全部运行期写入位于 `mkdtemp` 根内；② 若确需写共享证据目录，断言文件名含 `synthetic` 或唯一后缀 |
| 最小修复 | `local-supervision.test.ts:78` 的 `env` 改为显式构造（与 L51 一致，钉 `KFF_ROOT` 到临时根）；两处报告写入改到临时根 |
| 风险 | 钉 `KFF_ROOT` 后 Worker 将读临时根下的 `agent-config.json`，该文件可能不存在 → **可能直接令该用例失败，修复前必须先验证这一点** |
| 回退 | 纯测试文件，`git revert` |
| 验收 | ① 套件运行前后真实 `.kff/` 无新增/改动；② 两个用例 `KFF_ROOT` 处理一致；③ 仍能验证 Worker 的 `RUNNING→DRAINING→DRAINED` |

> **本轮先怀疑该用例会写用户日常库，随后被 `scripts/integration.ts:13` 的 `DATABASE_URL` 注入否证。** 数据库隔离成立，故降级为 P3 并明确它不属于数据安全缺陷。这条自我否证过程记录在此，以免后续读者重复该怀疑。

---

### B04-6　数据库层测试缺口（`migration-audit.md` 第 10 节，M1–M8）

| # | 测试 | 目的 |
|---|---|---|
| **M1** | **RLS 越权读取** | 以租户 A 的 scope 经 `scoped()` 读租户 B 的对象，断言**空结果**。**这是唯一能证明 RLS 真正生效的测试** |
| M2 | `kff_app` 能力 | 断言对 `audit_events`/`approval_decisions`/`content_versions`/`inbound_events` 四表的 UPDATE **被拒绝** |
| M3 | 三出口守卫 | 静态/运行时断言：处理租户数据的函数**必须**经 `scoped()` |
| M4 | 重复 migrate 幂等 | 连跑两次 `migrate()`，第二次全跳过且无错 |
| M5 | migrate 失败回滚 | 注入含错迁移，断言 `schema_migrations` 无残留、库回到迁移前 |
| M6 | 迁移篡改检测 | 改动已应用迁移的字节，断言抛 `Applied migration changed` |
| M7 | `agent_single_execution_slot` | 断言同 agent 第二条 `CLAIMED` 命令被唯一约束拒绝；**并断言 B01-1 修复后卡死命令能退出 `CLAIMED`** |
| M8 | 并发 cancel vs dispatch | WhatsApp referral 投影的取消/派发竞争（静态核查为 SAFE，但**无任何测试覆盖**） |

> **全部未执行。** 原因：均需数据库实例，而本轮**无法证明与用户日常环境隔离**。
> 执行前置：`KFF_TEST_DATABASE` 存在且库名匹配 `/^kff_test_[a-f0-9]{20}$/`（`packages/database/src/runtime.ts` 强校验），再经 `scripts/migrate.ts` 应用。
> **不得当作通过。**

---

## B05 — 2 账号受控试点（**仅规划，本轮不执行**）

### B05-0 用户明确禁止的事项（试点时同样适用）

❌ 使用真实 Facebook 账号发送消息 ❌ 使用真实 Facebook 账号发表评论 ❌ 使用真实 WhatsApp 做客户操作 ❌ 使用真实 Stripe 或任何真实支付
**以上禁令在 B05 工单获批前持续有效。** 本规划**不含**任何真实外发步骤。

### B05-1 试点前必须闭合的前置

| # | 前置 | 来源 | 阻塞理由 |
|---|---|---|---|
| 1 | `KFF-B00-002` 修复 | B01-1 | 主业务链永久阻塞且重启不自愈。**唯一影响可用性的 P1** |
| 2 | `KFF-B00-004` 补测 | B01-3 | 否则 002 的修复无回归保护，且注入开关的安全边界继续裸奔 |
| 3 | `Q2` 的真实页面 role 观察 | B03-1 | 无此事实无法正确修复 B03-1；而 B03-1 决定「英文界面下能否发送」 |
| 4 | `M1` RLS 越权测试 | B04-5 | 「RLS 生效」目前**无直接证据** |
| 5 | `M7` 执行槽位断言 | B04-5 | 与 002 的修复路径直接相关（**不能靠插补偿命令**） |
| 6 | `Q1` 政策裁定 | B02-2 | 决定 006 修复方向 |
| 7 | `Q3` 历史 OPTED_OUT 处置 | B02-1 | 决定 001 是否需配套数据复核 |

### B05-2 试点规模与观察点（规划建议）

- **规模**：2 个账号（用户已推迟 30 账号并发；本机 `agent_single_execution_slot` 部分唯一索引意味着并发上限受数据模型约束，**从未验证过**）
- **观察点**：① 单次发送的收据验证是否可达（历史上仅 1 次自动验证成功）；② `GUARDIAN_UNCONFIRMED` 是否出现；③ journal 是否产生滞留条目；④ `unknown_outcome` / `adjudication` 触发次数；⑤ 接待规则在真实流量下的判定分布
- **明确不观察**：接待类规则缺陷（**被四重封堵挡住，见 B02-4，真实路径无法暴露它们**）
- **中止条件**（建议）：出现任何 `UNKNOWN_OUTCOME`、任何 `ACCOUNT_MISMATCH`/`THREAD_IDENTITY_UNVERIFIED`、或 journal 出现滞留条目 → 立即停止并保留 closure 证据

### B05-3 容量问题（明确无数据）

2 / 5 / 30 账号的并发容量与稳定性：**无数据**。`audit-repair-round2-20260917.json:74` 自述 "no load"。本轮亦未做任何负载测试。**不得以「架构上支持」替代容量证据。**

---

## 批次依赖图

```
Q1(政策) ──► B02-2 (006)
Q2(真实role) ──► B03-1 (011) ──► B03-2 (010)      ← Q2 缺失则 B03-1 被阻塞
Q3(历史数据) ──► B02-1 验收 (001)

B01-1 (002) ──► B01-3 (004)          ← 必须先修行为再补测试,否则固化错误行为
     │               │
     └───────────────┴──► M7 ──► B05

B01-4 (005) ──► 建议在 B01 代码合并后定稿（否则 SHA 立即漂移）

B02-3 (008) 独立,B02-4 (007) 独立
B04-1 (012)/B04-2 (013)/B04-5 (M1–M8) 独立（补测试）
B04-4 (014) 仅知会,不修复
```

### 建议执行顺序

1. **B01-1**（唯一影响可用性的 P1）
2. **B01-3**（紧随其后，固化 002 的修复）
3. **B01-2**（同属启动失败证据链，与 B01-3 同批）
4. **B02-1**（P1，误判方向永久丢弃客户资产；纯函数、无迁移，成本低）
5. **B02-2**（待 Q1）
6. **B01-4**（待 B01 代码合并后定稿）
7. **B03-1 → B03-2**（待 Q2）
8. **B04-1 / B04-2 / B04-5**（补测试，可与上面并行）
9. **B05**（前置全闭合后）

---

## 明确的「不做」清单

| 不做 | 依据 |
|---|---|
| 完整支付/退款模块重构 | 用户明确：「不要把完整支付重构列为 Facebook 试点前置条件」 |
| 30 账号并发压测 | 用户已推迟；本轮无数据 |
| Instagram / Threads | 用户已推迟 |
| AI 自动刷帖养号 | 用户已推迟 |
| 大规模自动外发 | 用户已推迟 |
| 改动 `dist/` 内容 | 属对用户环境的实质改动 |
| 本轮任何修复 / commit / push / merge / deploy | 用户明确：「本轮只执行 B00……完成 B00 后立即停止」 |
