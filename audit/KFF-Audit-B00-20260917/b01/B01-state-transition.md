# B01 — 状态转换与证据表

一条命令从被 claim 到终止，Agent 侧会经过下列状态。本表说明每个状态下 **journal / 关闭证据 / command / action / attempt / lease / environment / quarantine / execution slot** 九个物件的期望取值。

三个贯穿全表的判据（`apps/agent/src/guardian.ts`）：

- `started` —— 父进程是否收到过 child 的 `ready`。**只有收到 `ready` 才会发 `start`，只有 `start` 才进 executor。**
- `submitted` —— 父进程是否收到过 child 的 `before-submit`。
- `contextOpened` —— 父进程是否收到过 child 的 `context-opened`。

child 消失时三者**全为 false** 才允许写启动失败证据；否则一律 `GUARDIAN_UNCONFIRMED` + 保持隔离。

事件序说明（本平台实测，见 `tests/unit/guardian-termination.test.ts` 场景 B / F）：

| 情形 | 真实事件序 | 是否发 `exit` |
| --- | --- | --- |
| spawn 失败（ENOENT） | `error`（`pid === undefined`） → `close`(-4058) | **否** |
| 成功启动后被杀 | `exit` → `close` | 是 |
| 对已死 child 做 IPC send | 失败送到 callback（`ERR_IPC_CHANNEL_CLOSED`），**不发** `error` 事件 | — |

因为spawn失败不产生 `exit`，终止判定不能挂在单一事件名上 —— 这是 KFF-B00-002 的根因，也是 `settle()` 一次性入口存在的原因。

---

## 1. PRE-SPAWN FAILURE

操作系统从未创建进程。`child.pid === undefined`。

| 物件 | 期望 | 依据 |
| --- | --- | --- |
| journal | `{phase:'claimed', guardian_nonce, collection_expires_at}`，**无** `guardian_pid`，**无** `quarantined`；flush 后 `acknowledged:true`、`quiesced:true`、`collection_redaction.reason:'DELIVERED'` | `main.ts:49`；集成实测 |
| 关闭证据 | `kff.guardian-closure-startup-failed.v1`，`context_opened: false`，**没有** `context_closed`，带 `result` | `guardian-protocol.ts` `saveStartupFailure` |
| command | `READY→CLAIMED`（claim 时）→ `DONE`（回执被接受后），随后 `quiesced_at` 非空 | `execution.ts:205` + `reconciliation.ts:18` |
| action | `PREPARING → CANCELED`，`error_code='GUARDIAN_STARTUP_FAILED'` | `acceptReport` L199；`transitions.PREPARING` 允许 `CANCELED` |
| attempt | 恰 1 行，`state='CANCELED'`，`completed_at` 非空，**`submitted_at` 为空** | `execution.ts:204` |
| lease | 已释放：`holder_attempt_id` 清空、`quarantined=false`、`expires_at` 过期 | `execution.ts:207`（`quarantine` 为 false） |
| environment | `state='IDLE'`；`browser_status` **不被改写**（只有 `kff.guardian-closure.v1` 才投影 `CLOSED`） | `execution.ts:208` + `reconciliation.ts:23` |
| quarantine | **无**。journal 无 `quarantined`；lease `quarantined=false`；environment 非 `QUARANTINED` | `execution.ts:206`：`quarantine` 仅在 `UNKNOWN_OUTCOME` 或 `AGENT_RESTART` 时为真 |
| execution slot | **释放**。`state IN ('READY','CLAIMED')` 计数 0，且 `quiesced_at` 非空 → `dispatchOne` 的占用检查不再命中 | `execution.ts:73`；集成断言实测为 0 |

**这是 B01 修复的核心场景。** 零平台写入由 wire 证明：该命令只出现 `commands/<id>/status` 与 `commands/<id>/quiescence` 两个端点。

---

## 2. SPAWNED

进程已创建（`child.pid > 0`），但尚未发 `ready`。`started=false`。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'claimed', guardian_nonce, …}`，**仍无** `guardian_pid`（`onSpawn` 只在 `ready` 时触发） |
| 关闭证据 | 尚无（终止时才由父进程写） |
| command | `CLAIMED`，`quiesced_at IS NULL` |
| action | `PREPARING` |
| attempt | 1 行，进行中 |
| lease | 由该 attempt 持有（`holder_attempt_id = attempt_id`），未 quarantine |
| environment | 未投影 |
| quarantine | 无 |
| execution slot | **占用**（`CLAIMED` 且 `quiesced_at IS NULL`） |

**此状态死亡 = 与 PRE-SPAWN FAILURE 同一条路径。** 理由：`guardian-child.ts` 在模块加载时、任何浏览器工作之前就 `process.send({type:'ready'})`，所以"从未收到 `ready`"本身就证明 executor 从未被触达。二者在证据上是**同一事实的两种到达方式**，因此共用同一份启动失败证据。

---

## 3. READY

child 已发 `ready`。父进程置 `started=true`，调用 `onSpawn(pid)`，然后发 `start`。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'claimed', guardian_pid: <pid>}` ← `onSpawn` 回调写入 |
| 关闭证据 | 尚无 |
| command | `CLAIMED`，`quiesced_at IS NULL` |
| action | `PREPARING` |
| attempt | 1 行，进行中 |
| lease | 仍由该 attempt 持有 |
| environment | 未投影（`browser_status` 尚未变） |
| quarantine | 无 |
| execution slot | **占用** |

**此状态死亡 → `GUARDIAN_UNCONFIRMED`，保持隔离，不写启动失败证据。** 因为 `started=true`。保守但正确：`start` 已经在路上，无法从证据上排除 executor 被触达。单元测试 D 覆盖同类事实。

---

## 4. CONTEXT OPENED

child 已发 `context-opened`。父进程置 `contextOpened=true`，写 journal，并向 controller 报 `context-opened`。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'context_open', guardian_pid}` |
| 关闭证据 | 尚无 |
| command | `CLAIMED` |
| action | `PREPARING` |
| attempt | 1 行，进行中 |
| lease | 由该 attempt 持有 |
| environment | `browser_status='RUNNING'`（`recordBrowserOpened`） |
| quarantine | 无 |
| execution slot | **占用** |

**此状态死亡 → `GUARDIAN_UNCONFIRMED`，保持隔离。** 存在无人证明已关闭的 context。

---

## 5. INTENT REQUESTED

child 已发 `before-submit`。父进程置 `submitted=true`，写 journal，然后调用 `hooks.beforeSubmit()`。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'intent_requested', guardian_pid}` |
| 关闭证据 | 尚无 |
| command | `CLAIMED` |
| action | `PREPARING`（`beginSubmission` 尚未返回） |
| attempt | 1 行，`submitted_at` **仍为空** |
| lease | 由该 attempt 持有 |
| environment | `browser_status='RUNNING'` |
| quarantine | 无 |
| execution slot | **占用** |

**此状态死亡 → `GUARDIAN_UNCONFIRMED`，保持隔离。** 单元测试 E 用真实 child 覆盖：`asked === true`（父进程确实收到过 `before-submit`），结果必须是 `GUARDIAN_UNCONFIRMED` 且**没有** closure 文件。

---

## 6. INTENT GRANTED

`hooks.beforeSubmit()` 返回成功 —— controller 的 `commands/<id>/submit` 已受理。父进程发 `submit-granted`，写 journal。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'submitting', guardian_pid}` |
| 关闭证据 | 尚无 |
| command | `CLAIMED` |
| action | **`SUBMITTING`**（`beginSubmission` 已持久化提交意图） |
| attempt | 1 行，**`submitted_at` 非空** |
| lease | 由该 attempt 持有 |
| environment | `browser_status='RUNNING'` |
| quarantine | 无 |
| execution slot | **占用** |

**此状态之后死亡 → `GUARDIAN_UNCONFIRMED`。** 一旦 `submitted_at` 存在，"什么都没发生"就不再可证。

---

## 7. SUBMITTING

executor 正在向平台写入。这是**唯一**可能产生真实平台副作用的状态。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'submitting'}` |
| 关闭证据 | 尚无 |
| command | `CLAIMED` |
| action | `SUBMITTING` |
| attempt | `submitted_at` 非空 |
| lease | 由该 attempt 持有 |
| environment | `browser_status='RUNNING'` |
| quarantine | 无 |
| execution slot | **占用** |
| 其它 | `assertControlled()` 在每步前检查保留期与控制权；被 abort 时 child 落 `CANCELED` |

**此状态死亡或超时 → `UNKNOWN_OUTCOME`，且 quarantine 生效。** 两条路径都如此：
- 回执侧：`acceptReport` 的 `quarantine` 判据包含 `outcome === 'UNKNOWN_OUTCOME'`。
- 租约侧：`recoverExpired` 对 `SUBMITTING`/`SUBMITTED` 且非 `READY` 的命令给 `UNKNOWN_OUTCOME` + `LEASE_EXPIRED`，并置 `quarantined=true`、environment `QUARANTINED`，**且不设置 `quiesced_at`**。

---

## 8. SUBMITTED

平台已接受写入，回执正在核验途中。

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'submitting'}`（journal 不区分 SUBMITTING / SUBMITTED，该区别只在 DB） |
| 关闭证据 | 尚无 |
| command | `CLAIMED` |
| action | `SUBMITTED` |
| attempt | `submitted_at` 非空 |
| lease | 由该 attempt 持有 |
| environment | `browser_status='RUNNING'` |
| quarantine | 无 |
| execution slot | **占用** |

**此状态死亡的处置与 SUBMITTING 相同**（`UNKNOWN_OUTCOME` + quarantine）。

---

## 9. RECEIPT VERIFIED

两条子路径，都产生真正的正常关闭证据。

### 9a. `VERIFIED_SUCCEEDED`

| 物件 | 期望 |
| --- | --- |
| journal | `{phase:'submitting'}` → flush 后 `acknowledged:true`、`quiesced:true` |
| 关闭证据 | `kff.guardian-closure.v1`，`context_closed: true`，带 `result`；retention 后可能是 `kff.guardian-closure-compact.v1`（丢掉 `result`，保留 `proof_sha256`/`result_sha256`），但 `closureProof` 仍以 `kff.guardian-closure.v1` 出行 |
| command | `DONE`，`quiesced_at` 非空 |
| action | `VERIFIED_SUCCEEDED` |
| attempt | `state='VERIFIED_SUCCEEDED'`，`completed_at` 非空 |
| lease | 释放，`quarantined=false` |
| environment | `state='IDLE'`，`browser_status='CLOSED'`（由 `recordQuiescence` 投影） |
| quarantine | 无 |
| execution slot | **释放** |

### 9b. `CANCELED` / `BLOCKED` / `NEEDS_HUMAN` / `VERIFIED_FAILED`（正常关闭但结果非成功）

同上，差别只在 `action.state`、`attempt.state`、`command.task/run status` 的映射。**关键不变式：只要有 `kff.guardian-closure.v1`，`browser_status` 就投影为 `CLOSED`。** 集成测试 Command 2 走的就是这条路径。

---

## 10. UNKNOWN

### 10a. `GUARDIAN_UNCONFIRMED` —— 已进入执行但关闭状态不明

| 物件 | 期望 |
| --- | --- |
| journal | 停留在原 phase（`claimed` 带 `guardian_pid` / `context_open` / `intent_requested` / `submitting`），**无** `quiesced` |
| 关闭证据 | **没有文件**（`readClosureEvidence` 返回 `null`） |
| command | `CLAIMED`，`quiesced_at IS NULL` |
| action | `PREPARING` 或 `SUBMITTING`/`SUBMITTED`（视路径） |
| attempt | 视路径，`submitted_at` 可能非空 |
| lease | 视路径，超时后 `quarantined=true` |
| environment | 超时后 `QUARANTINED`、`browser_status='UNKNOWN'`、`browser_error_code='GUARDIAN_UNCONFIRMED'` |
| quarantine | 超时路径**生效** |
| execution slot | **占用**（`state='CLAIMED'`，且 `quiesced_at IS NULL`） |

**这是安全语义，不是缺陷。** `flushActionJournal` 对没有 closure 的条目返回 `false`，主循环闸门抛 `GUARDIAN_UNCONFIRMED` 并暂停接单 —— 安全优先，不吞掉不确定性。

### 10b. `UNKNOWN_OUTCOME` —— 提交边界之后结果未知

| 物件 | 期望 |
| --- | --- |
| journal | 停在 `submitting`；若 retention 已到期，回执 outcome 被改写成 `UNKNOWN_OUTCOME`（`flushActionJournal` L55 对 `SUBMITTING`/`SUBMITTED` 的既有行为） |
| 关闭证据 | 仍在时照常携带；已清理由 `GUARDIAN_UNCONFIRMED` 挡住（`flushActionJournal` L53） |
| command | `DONE`（有回执）或 `EXPIRED`（租约超时） |
| action | `UNKNOWN_OUTCOME` |
| attempt | `UNKNOWN_OUTCOME` |
| lease | `quarantined=true` |
| environment | `QUARANTINED` |
| quarantine | **生效**，需 `releaseQuarantine` 且必须先有 `VERIFIED_*`/`NEEDS_HUMAN` 裁定 |
| execution slot | `DONE` 路径：`quiesced_at` 设置后释放；`EXPIRED` 路径：`quiesced_at` **保持 NULL** → 仍占用 |

### 10c. KFF-B01-NEW-01 —— 已启动但停滞的 child（新增 P1，本轮未修）

| 物件 | 期望（即实际观测） |
| --- | --- |
| journal | `{phase:'claimed', guardian_pid: <pid>}`，**永久**停在此处，无 `quiesced` |
| 关闭证据 | **永不产生** |
| command | `CLAIMED`，`quiesced_at IS NULL` |
| action | `PREPARING` |
| attempt | 进行中，永不结束 |
| lease | 永不释放 |
| environment | profile 目录已创建（`binding.json` / `owner.lock` / `user-data/Default`），`browser_status` 停在 `RUNNING` |
| quarantine | 无 |
| execution slot | **永久占用** |

触发路径：child 发出 `ready`、收到 `start` 之后卡住，`error` / `exit` / `close` **一个都不来** → `runGuardian` 的 promise 永不 settle → `main.ts` 的 `finally` 永不执行 → flush 永不执行。Agent 主循环卡在 `await runGuardian(...)` 内部，重启不自愈。**这与 KFF-B00-002 的用户可见症状相同，但本轮修复覆盖不到**，需规划端裁定（见 B01-summary.md §4）。

### 10d. 本平台不产生的事件组合

| 组合 | 结论 | 依据 |
| --- | --- | --- |
| `error` 单独出现（无 `close`） | **NOT_OBSERVED** | spawn 失败固定为 `error → close` |
| `error` 后跟 `exit` | **NOT_OBSERVED** | 唯一 `error` 来源是 spawn 失败（不产生 `exit`）与 IPC send 失败；生产的 send 路径既检查 `child.connected` 又始终传 callback，失败被送到 callback。场景 F 用真实探针钉住了这两半事实 |
| `error + close` | **OBSERVED**，且必须只产生一次终止判定 | 场景 B：恰好一份 closure（第二次判定会变成 `IDEMPOTENCY_CONFLICT`） |
| `exit + close` | **OBSERVED** | 场景 C / D / E |

---

## 11. 十状态 → 启动失败证据资格

| 状态 | `started` | `submitted` | `contextOpened` | 死亡后写启动失败证据？ |
| --- | --- | --- | --- | --- |
| PRE-SPAWN FAILURE | false | false | false | **是** |
| SPAWNED | false | false | false | **是**（同一事实） |
| READY | true | false | false | 否 → `GUARDIAN_UNCONFIRMED` |
| CONTEXT OPENED | true | false | true | 否 → `GUARDIAN_UNCONFIRMED` |
| INTENT REQUESTED | true | true | 视路径 | 否 → `GUARDIAN_UNCONFIRMED` |
| INTENT GRANTED | true | true | 视路径 | 否 → `GUARDIAN_UNCONFIRMED` |
| SUBMITTING | true | true | 视路径 | 否 → `GUARDIAN_UNCONFIRMED` |
| SUBMITTED | true | true | 视路径 | 否 → `GUARDIAN_UNCONFIRMED` |
| RECEIPT VERIFIED | true | 视路径 | 视路径 | 不适用（已有正常 closure） |
| UNKNOWN | — | — | — | 否 → 保持隔离 / quarantine |

**同一 child 生命周期只做一次终止判定**：`error` / `exit` / `close` 中任意组合到达，`settled` 标志保证 `decide()` 只执行一次，`clearInterval(keepalive)` 与 `removeEventListener('abort', stop)` 也只在这一次执行。
