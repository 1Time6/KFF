# B01 — 代码与测试改动清单

基线：`752042bc466b10b07cad455757a41bb10bbaf39f`（branch `codex/facebook-foundation`，未 commit）。

```
 apps/agent/src/guardian-protocol.ts         | 16 ++++++--
 apps/agent/src/guardian.ts                  | 50 ++++++++++++++---------
 apps/agent/src/main.ts                      |  9 ++++-
 packages/contracts/src/index.ts             |  6 ++-
 packages/core/src/reconciliation.ts         |  6 ++-
 scripts/integration.ts                      |  2 +-
 tests/helpers/collection-journal.ts         | 36 +++++++++++++++--
 tests/integration/local-supervision.test.ts |  8 ++--
 tests/unit/action-journal.test.ts           | 62 ++++++++++++++++++++++++++++-
 9 files changed, 160 insertions(+), 35 deletions(-)
```

新增文件（untracked，未 commit）：
```
 tests/integration/guardian-recovery.test.ts
 tests/unit/guardian-closure-proof.test.ts
 tests/unit/guardian-startup-fault-injection.test.ts
 tests/unit/guardian-termination.test.ts
```

总计：**9 个已跟踪文件被修改**（其中 6 个是业务代码 / 脚本，3 个是测试与辅助）+ **4 个新测试文件**。`git status --porcelain` 计数 13。

---

## 1. 业务代码改动（6 个文件）

### 1.1 `apps/agent/src/guardian.ts` — 终止判定改为一次性 settle（KFF-B00-002）

**改前：** 终止证据逻辑只挂在 `exit` 上，而 spawn 失败只发 `error`，命令永远等不到闭环。

**改后：**
- 新增 `settled` 标志 + `settle(decide)`，把 `clearInterval(keepalive)` / `removeEventListener('abort', stop)` / `decide()` 收进同一个一次性入口。
- `settleTerminal` 由 `error`（仅当 `child.pid === undefined`）、`exit`、`close` 三处共同指向。
- `child.once('error')`：`pid === undefined` 说明操作系统从未创建进程且 `exit` 不会再来 → 走终止判定；`pid` 存在时仍只 `reject(error)`，不替 child 下结论。
- `settleTerminal` 内：先 `readClosure`，读到即 resolve；读不到且 `!started && !submitted && !contextOpened` → `saveStartupFailure(...)` 并抛 `GUARDIAN_STARTUP_FAILED`；否则抛 `GUARDIAN_UNCONFIRMED`（保持隔离）。
- 第 27 行注释修正为与实现一致（指出 `tests/unit/guardian-startup-fault-injection.test.ts` 逐条钉住该开关的每个条件）。

**没有做的事：** 没有新增守护状态机、没有新增 journal、没有旁路 recovery scheduler、没有超时兜底 deadline。

### 1.2 `apps/agent/src/main.ts` — 启动失败也要 flush（KFF-B00-002 第二处成因）

**改前：** `finally` 里 `flushJournal()` 在 run reject 时被跳过 → 已写好的启动失败证据不会被送出去 → slot 仍被占住。

**改后：** `await flushJournal().catch(...)` 无条件执行，错误只本地记录（`GUARDIAN_UNCONFIRMED` 等），不覆盖原始错误。释放 slot 与"无证明就挡新单"是两件事，循环闸门 `requireCondition(await flushJournal(), 'GUARDIAN_UNCONFIRMED', ...)` 保持原样。

### 1.3 `apps/agent/src/guardian-protocol.ts` — 事实不被压缩改写（KFF-B00-003）

- 新增 `startupFailedProtocolVersion = 'kff.guardian-closure-startup-failed.v1'` 与 `startupFailureSchema`（`context_opened: literal(false)`，**没有** `context_closed`，带 `result`）。`ClosureEvidence` 成为三选一的联合类型。
- 新增 `saveStartupFailure(...)`：只由父进程写，只写一次（`IDEMPOTENCY_CONFLICT` 守卫）。
- `closureProof`：startup failure 以自己的版本出行；普通与 compact 记录都保留 `kff.guardian-closure.v1` → **已入库的 proof 逐字节不变**。
- `compactClosure`：现在**只**接受 `kff.guardian-closure.v1`。compact 记录与 startup-failed 记录都原样返回。因此"从未打开 context"永远不可能被改写成 compact schema 所携带的 `context_closed: true`。
- `readClosure`：遇到 startup failure 时抛 `GUARDIAN_STARTUP_FAILED`，仍然拒绝把它当作"context 已关闭"使用。

### 1.4 `packages/contracts/src/index.ts` — 协议扩展是显式 schema 扩展

- 新增 `guardianClosureProtocols = ['kff.guardian-closure.v1', 'kff.guardian-closure-startup-failed.v1'] as const`。
- `quiescenceInput.protocol_version` 从 `z.literal(...)` 改为 `z.enum(guardianClosureProtocols)`。

这是**显式 schema / 状态扩展**，不是对字符串做特判。

### 1.5 `packages/core/src/reconciliation.ts` — 释放与投影分离

- `quiesced_at` 对两种事实都设置（这才是释放 slot 的动作）。
- `browser_status='CLOSED'` **只在** `proof.protocol_version === 'kff.guardian-closure.v1'` 时投影。startup failure 说的事实相反，用它去清 `browser_status` 会记录一次从未发生的关闭。

### 1.6 `scripts/integration.ts` — 允许为一次运行指定独立 KFF_ROOT（B00-015）

`KFF_ROOT: path.resolve('.')` → `KFF_ROOT: process.env.KFF_ROOT ?? path.resolve('.')`。未设置时行为与之前完全一致。

**注意（记录在案）：** 本轮实测发现 `KFF_ROOT` 在本仓库里同时承担"项目根"（`supabase/migrations`、adapter implementation digest、`scripts/` 路径）与"运行根"（`<root>/.kff`）两种角色。指向一个**裸临时目录**会改变产品行为，并让 `tests/integration/local-supervision.test.ts` 的 Worker drain 用例挂住（实测：裸临时根 30s 超时；镜像根 4.1s 通过）。本轮采用的独立 KFF_ROOT 是：临时目录 + 指向真实 `supabase/packages/apps/scripts/node_modules` 的 junction + 自己的 `.kff`（含 `local-config.json` 副本）。这样 `.kff` 真正独立，而源码路径仍然解析得到。详见 B01-test-results.md §3。

---

## 2. 测试改动

### 2.1 新增测试文件（4 个，全部为本轮新增，没有删除任何原测试）

| 文件 | 内容 |
| --- | --- |
| `tests/unit/guardian-termination.test.ts` | A–F 六个场景，全部走真实 `runGuardian` + 真实 child 进程 |
| `tests/integration/guardian-recovery.test.ts` | 2 个端到端场景：failure → recovery → 下一个合法命令；lost-ack + restart |
| `tests/unit/guardian-closure-proof.test.ts` | closureProof / compactClosure / readClosure 的事实保持 |
| `tests/unit/guardian-startup-fault-injection.test.ts` | 逐条钉住 fault-injection 开关的三个条件 |

场景 A–F 与目标状态的对应关系：

| 场景 | 事实 | 期望 |
| --- | --- | --- |
| A | child 在被启动前就死掉 | `GUARDIAN_STARTUP_FAILED` + `context_opened: false` 记录；`spawned === false`、`submitRequested === false` |
| B | 失败 spawn 的真实事件序 | `['error','close']`，**没有** `exit`；恰好一份 closure（第二次判定会变成 `IDEMPOTENCY_CONFLICT`） |
| C | child 正常启动并完成 | `kff.guardian-closure.v1` + `context_closed: true` |
| D | child 已启动但关闭状态不明 | `GUARDIAN_UNCONFIRMED`，**没有** closure 文件（保持隔离） |
| E | 已进入提交意图边界后死亡 | `GUARDIAN_UNCONFIRMED`；`asked === true` 证明父进程确实收到过 `before-submit` |
| F | 平台事实：失败 IPC send 的落点 | 送到 callback（`ERR_IPC_CHANNEL_CLOSED`），**不发** `error` 事件 |

A、B、C、D、E 被显式当作**五种不同的终止状态**，没有被归并。

### 2.2 修改的测试文件（3 个；其中 `guardian-termination.test.ts` 本身是本轮新增文件，下面是它在新增之后又做的清理改动）

**`tests/unit/action-journal.test.ts`（+62 行，只增不改）** — 新增两个用例：
- 「releases the slot exactly once for a proven startup failure and never restates it as a closed context」：flush 两次只产生一次 slot 释放 / 一次 report；retention 之后记录仍无 `context_closed`；重复 `maintainActionJournal`（含从磁盘 reload 后）使文件逐字节不变。
- 「rewrites a startup failure to UNKNOWN_OUTCOME when the action state says submission had begun」：当 controller 报 `action_state: SUBMITTING` 时，启动失败记录的 `CANCELED` 必须被改写成 `UNKNOWN_OUTCOME`，且 proof 仍以 startup-failed 版本出行。

**`tests/unit/guardian-termination.test.ts`（B00-015 清理，非断言语义变更）**
- `withUnusableWorkingDirectory`：临时目录现在登记进 `roots`，由 `afterAll` 清理（此前会遗留 `kff-b01-missing-*`）。
- `afterAll` 守卫正则从 `/^kff-b01-guardian-/` 放宽为 `/^kff-b01-(guardian|missing)-/`，以覆盖新登记的那批目录。守卫仍然同时校验 `path.dirname(root) === os.tmpdir()`。
- 移除未使用的 `closureFile` import（lint）。

**`tests/integration/local-supervision.test.ts`（B00-015 清理）**
- 临时根从项目内 `.kff/local-supervision-<rand>` 改为 `os.tmpdir()/kff-local-supervision-<rand>`，并在 `finally` 中按前缀 + 父目录双重校验后删除。
- 第 75 行写 `.kff/checks/local-supervision-agent-<mode>.json` **保持不变**：`.kff/checks/` 是本仓库既定的证据输出位置（`scripts/integration.ts` 同样写这里），B00-015 本身也判定它"不是数据安全缺陷"。

### 2.3 测试辅助改动（1 个）

**`tests/helpers/collection-journal.ts`**
- 临时根从项目内 `.kff/collection-journal-tests/<uuid>` 改为 `os.tmpdir()/kff-collection-journal-<rand>`（此前自 9/16 起已在真实项目根下累积了数百个 uuid 目录）。
- 新增清理：在 helper 模块作用域注册 vitest 的 `afterAll`，按前缀 + 父目录双重校验后删除本文件创建的全部临时根。
  - 实现记录：最初用的是 `process.on('exit')`，实测**在 vitest 的 worker thread 里不触发**（一次运行遗留 52 个目录）。改用 `afterAll` 后实测一次运行遗留 0 个目录。
- 新增 `startupFailureJournalFixture()`：构造生产 journal 中该场景**真实的样子**——`phase: 'claimed'`、`guardian_nonce` 存在、**没有** `report`（report 由 flush 从记录推导）。

### 2.4 删除的测试

**无。** 本轮没有删除任何原测试。B01 之前存在的全部测试文件仍在。

### 2.5 断言语义变更

**没有任何断言被弱化或改写以适配当前行为。**

唯一的既有断言改动是上表 2.2 中 `guardian-termination.test.ts` 的 `afterAll` 目录守卫正则——它是一条**清理安全检查**，不是产品行为断言，且改动方向是**收紧覆盖范围**（从只认 `guardian-` 前缀，扩大到同时认 `missing-` 前缀，代价是同时保留原有的 `dirname === os.tmpdir()` 校验）。

集成测试中的两处断言是在本轮**新增**的测试里，用于适配真实归档行为而非放宽要求：
- Command 2 的 closure 可能已被 retention 压缩成 compact 版本（丢掉 `result`），因此断言改为 `closure.context_closed === true` + `closureProof(closure).protocol_version === 'kff.guardian-closure.v1'`，并把 outcome 从权威来源 `kff.actions.state` 读取。
- retention 红action 与断言之间存在约 1 秒竞态，改用 `expect.poll(...)` 等待 `collection_redaction.reason === 'DELIVERED'`。这是测试自身的竞态，不是产品缺陷。
