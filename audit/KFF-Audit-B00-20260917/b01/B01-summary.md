# B01 — Guardian trust closure

**Scope actually executed:** Guardian / Agent 启动失败、终止证据、journal 恢复、quiescence、execution slot 释放这一条信任链。范围没有扩大。

**Base:** 未混合基线。
- branch `codex/facebook-foundation`
- `HEAD` = `origin/codex/facebook-foundation` = `752042bc466b10b07cad455757a41bb10bbaf39f` = B00 AUDIT SHA
- 开始前与结束时各确认一次，两次一致。本轮**没有** commit / push / merge / deploy。

---

## 1. 结论速览

| 项目 | 结果 |
| --- | --- |
| KFF-B00-002 | **FIXED** |
| KFF-B00-004 | **FIXED** |
| KFF-B00-003 | **属于本批，已处理**（属于 Guardian closure / compactClosure / quiescence 信任链） |
| 目标 regression | **先红后绿**（红：`Error {"code":"ENOENT"}`；绿：见 B01-test-results.md） |
| Command 1 零平台写入 | **证明**（wire 上只有 `status` + `quiescence`） |
| Command 1 零重放 | **证明**（claim 一次、report 一次、attempt 一次） |
| Command 2 真正执行完成 | **证明**（真实 child、真实 context、`VERIFIED_SUCCEEDED`、DONE + quiesced） |
| journal 恢复 | **证明**（含 lost-ack + restart 场景） |
| execution slot 正常释放 | **证明**（`READY`/`CLAIMED` 计数为 0，无索引绕过、无删记录） |
| 是否仍存在 UNKNOWN path | **是** — 见 §4 新增 P1 |
| 新发现 P0/P1 | **1 个 P1（KFF-B01-NEW-01）**，未修，已上报 |
| 是否建议进入 B02 | 建议，但需先由规划端裁定 KFF-B01-NEW-01 |

---

## 2. KFF-B00-002 —— FIXED

**原缺陷链：** `spawn` 失败只发 `error`，永不发 `exit`；终止证据逻辑挂在 `exit` 上 → 无启动失败闭环证据 → journal 无法 flush → 永久 `GUARDIAN_UNCONFIRMED` → 命令占住执行链 → `agent_single_execution_slot` 也被占住 → Agent 停摆，重启不自愈。

**修复方式：** 把"终止判定"从单个事件名上摘下来，改成一次性的 settle。

- `apps/agent/src/guardian.ts`：`error` / `exit` / `close` 三个事件都指向同一个 `settle`，`settled` 标志保证**同一 child 生命周期只做一次终止判定**。
- `error` 分支区分两种事实：`child.pid === undefined`（操作系统从未创建进程，`exit` 不会再来）走终止判定；`pid` 存在（可能已经拥有 context）仍只把 error 原样交给调用方，不会替它下结论。
- 判定时先读 closure 记录；读到就用它 resolve。读不到、且 `!started && !submitted && !contextOpened`（即 child 从未发过 `ready`，父进程因此从未发 `start`，executor 从未被触达）才写启动失败证据。其余情况**保持 `GUARDIAN_UNCONFIRMED` 与隔离**。
- `apps/agent/src/main.ts`：`finally` 中 `flushJournal()` 不再因为 run reject 而被跳过——启动失败同样要在这一步释放 slot；同时保留"无证明就挡住新单"的循环闸门。

**为什么这不是"伪造 startup failure"：** `guardian-child.ts` 在模块加载时、任何浏览器工作之前就先 `process.send({type:'ready'})`。父进程只有收到 `ready` 才会发 `start`，只有 `start` 才进 executor。因此"从未收到 `ready`"本身就证明了：没有 browser context、没有提交意图、没有平台写入。这是既有状态机已经能证明的事实，不是新造的。

---

## 3. KFF-B00-004 —— FIXED

测试必须真正走进生产 Guardian 启动失败路径，并证明目标分支被命中，不能只构造相似对象 / 测试辅助 / mock 返回值 / 观察 exit code 0。

- `tests/unit/guardian-termination.test.ts`：全部场景走**真实 `runGuardian`** + **真实 child 进程**。故障注入用的是"把 `process.cwd()` 指到一个不存在的路径"——因为生产调用点就是 `spawn(process.execPath, ..., { cwd: process.cwd() })`，于是那一次 `spawn` 本身产生真实的 libuv ENOENT。没有替换、没有 stub、没有第二套执行系统。
- `tests/integration/guardian-recovery.test.ts`：真实 `apps/agent/src/main.ts` 进程 + 真实 guardian child + 真实隔离数据库 + 真实浏览器 fixture。故障注入用"把 node 二进制的副本改名"——Agent 从一个 copy 启动，测试期间把 copy 改名，Agent 内部的 `spawn(process.execPath, …)` 就产生真实 ENOENT，之后再改回来给第二个命令用。可逆、确定、零生产代码改动。
- 分支命中的可验证证据：closure 文件里是 `kff.guardian-closure-startup-failed.v1` 且 `context_opened: false`；journal `phase` 停在 `claimed` 且**没有** `guardian_pid`；wire 上该命令只有 `status` 与 `quiescence` 两个端点。

---

## 4. KFF-B00-003 —— 属于本批并已处理；另发现一个新的 P1

**"从未打开 context" 与 "打开过 context，后来确认关闭" 是两种不同事实。** 本轮把它当成硬约束实现：

- 新增独立协议版本 `kff.guardian-closure-startup-failed.v1`，带 `context_opened: literal(false)`，**刻意不带** `context_closed`。
- `compactClosure` 现在只接受 `kff.guardian-closure.v1`；compact 记录与 startup-failed 记录都会原样返回，所以"从未打开"永远不可能被改写成 compact schema 所携带的 `context_closed: true`。
- `closureProof` 保留事实本身：startup failure 以自己的版本出行，接收端能分辨两者；普通与 compact 记录都保留原版本，因此**已入库的 proof 逐字节不变**。
- `recordQuiescence`：释放命令对两种事实都执行（这是 slot 释放的来源），但 `browser_status='CLOSED'` **只在 `kff.guardian-closure.v1` 时**才投影。

**真实路径验证（不是单元断言）：** 在集成测试里，条目被 retain pass 以 `DELIVERED` 理由真的跑过一次 `compactClosure`；随后磁盘上的记录仍然是 `kff.guardian-closure-startup-failed.v1`、`context_opened: false`、且**没有** `context_closed`。

### 新发现 P1：KFF-B01-NEW-01 —— 已启动但停滞的 child 没有任何终止事件

**症状与 002 完全相同，触发路径不同，B01 的修复覆盖不到。**

- child 被 spawn、发出 `ready`、收到 `start`，然后**卡住**，此时 `error` / `exit` / `close` **一个都不来**。
- 于是 `runGuardian` 的 promise 永不 settle → `main.ts` 的 `finally` 永不执行 → `flushActionJournal` 永不执行 → 命令停在 `CLAIMED`、`quiesced_at IS NULL`、journal 停在 `phase: "claimed"` 且带 `guardian_pid`、磁盘上没有 closure。
- Agent 主循环**卡在 `await runGuardian(...)` 内部**，只有命令内的心跳定时器还在发心跳；重启不自愈（没有 closure，循环闸门照样抛 `GUARDIAN_UNCONFIRMED`）。

**证据（上一轮采集）：** journal 条目 `{phase:"claimed", guardian_pid:15388}` / `{phase:"claimed", guardian_pid:17248}`；无 closure 文件；profile 目录**已**被创建（`binding.json` / `owner.lock` / `user-data/Default`）；controller `seen` 日志在 claim 之后**只有重复的 `heartbeats`**（没有 `/status`、没有 `/action-reports`、没有 `/quiescence`）；DB 行 `state: CLAIMED, quiesced_at: null`；两个 `node-copy.exe` guardian-child 进程在父进程死后仍然存活（Windows 上 `detached: true`）。

**卡点定位：** `packages/adapters/src/browser-inbox.ts` 在 `openManagedBrowser(...)` 之后**无条件**调用 `hooks.onContext(...)`。journal `phase` 仍是 `claimed` 说明 `onContext` 从未被调用，因此卡点在 `openManagedBrowser` 内部——即 `chromium.launchPersistentContext(userData, { …, timeout: 20000 })`（或其之前的步骤）。已启动的 chromium 进程数为 0，说明浏览器进程没有活下来。

**本轮为什么不修：** 第八阶段禁止创建第二套 Guardian 状态机 / 第二套 journal / 旁路 recovery scheduler。父进程侧的"无进展即中止"deadline 会在合法的长浏览器作业上误触发，除非 child 主动上报进展——那是一次协议扩展，属于规划端决策。按"无法证明就保持 UNKNOWN / quarantine"的原则，**没有**为了恢复而吞掉这份不确定性。

**观测率（诚实记录）：** 上一轮约 30 次运行中观测到 2 次（约 10%）。清理掉遗留的孤儿 guardian 进程与 34 个遗留 temp root 之后，本轮观测 11/11 通过，**未再复现**。这不能证明缺陷已消失，只能说明本轮的样本里没有出现。为此 `waitForProof()` 会在超时时直接打印 `journal.phase` / `journal.guardian_pid` / `controller.state` / `controller.quiesced_at`，下次复现时失败信息本身就能定位到 KFF-B01-NEW-01，而不是一个裸的超时。

---

## 5. 恢复语义（本轮的验收核心）

必须证明的是"失败 → 恢复 → 下一个合法命令真的跑完"，而不是"数据库可以再次 claim"。

- **Command 1**（真实 pre-start spawn 失败）：正确的启动失败证据 → journal 可恢复 → Controller 接受该终止证据 → 未产生提交权限 → 零平台写入 → 零重放 → 通过正常状态机释放 slot。
- **Command 2**（独立合法命令）：Agent 能 claim → Guardian READY → executor 真的执行 → 命令正常完成 → 按场景产生 receipt/result → Command 1 没有被再次执行。
- 两者在**同一次测试流程**内完成。
- 额外的耦合证据：`browser-inbox.ts` 只在 `quiesced_at` 已设置时才清 `current_task_id`，所以第二个页面能被排队本身就是修复在生产语义里的表达。

---

## 6. UNKNOWN path 现状

启动失败路径的 UNKNOWN 已经闭合。仍然存在的 UNKNOWN：

1. **KFF-B01-NEW-01**（§4）—— 已启动但停滞的 child：命令永久停在 `CLAIMED`，无任何终止证据。**新增 P1。**
2. **child 在 `start` 之后、`ready` 之后死亡** —— 按设计保持 `GUARDIAN_UNCONFIRMED`、保持隔离，这是正确行为而不是缺陷（单元测试 D、E 覆盖）。
3. **`SUBMITTING` / `SUBMITTED` 阶段的启动失败记录** —— 单元层面证明会被改写成 `UNKNOWN_OUTCOME` 而不是 `CANCELED`；实际生产中这条组合不可达（启动失败必然发生在 `PREPARING` 之前）。
4. **`error + exit` 事件组合** —— 本平台**不会产生**。已用真实探针记录原因：唯一的 `error` 来源是 spawn 失败（不产生 `exit`）与 IPC send 失败，而生产的 send 路径既检查 `child.connected` 又始终传 callback，失败被送到 callback 而不会发 `error` 事件。见 `tests/unit/guardian-termination.test.ts` 场景 F。

---

## 7. 本轮明确没有处理

KFF-B00-001、KFF-B00-006、Reception opt-out、"不要发广告"、历史 OPTED_OUT、Messenger role、Inbox locator、Acquisition、WhatsApp referral、`current-status.md`。规划端已经裁定的 Q1 / Q2 / Q3 一律没有动。B01 只解决 Guardian trust closure。

完整 unit / contracts / integration / fixtures / build / UI 按要求留到 B04。

**完成 B01 后即停止，未进入 B02。**
