# B01 — 测试结果

基线：`752042bc466b10b07cad455757a41bb10bbaf39f`（branch `codex/facebook-foundation`，未 commit）。
所有命令都在 `C:\Users\17731\Desktop\KFF` 下执行。

---

## 1. 先红后绿

### 1.1 RED（对冻结基线，修任何代码之前）

原始日志：`b01-red.log`（本目录）。

```
# B01 Phase 1 - RED against frozen baseline 752042bc466b10b07cad455757a41bb10bbaf39f
?? tests/unit/guardian-termination.test.ts
--- unmodified: apps/agent/src/guardian.ts 344a12a5ee004410b9205ea5f1c419233a3f73dc
--- npx vitest run tests/unit/guardian-termination.test.ts
 × A: a child killed before it can ever start is settled as a proven startup failure
   → expected Error: spawn C:\Program Files\nodejs\node… to match object { code: 'GUARDIAN_STARTUP_FAILED' }
        + Error { "code": "ENOENT" }
 × B: the failing spawn emits error then close and never exit, and produces exactly one terminal decision
   → 同上
 ✓ C / ✓ D / ✓ E
 Tests 2 failed | 3 passed (5)
```

**关键点：** 旧代码把 libuv 的原始 `Error { code: "ENOENT" }` 直接抛给调用方——这正是"只有 `error`、没有 `exit`、没有闭环证据"的直接表现。C / D / E 在旧代码上就是绿的，因为它们断言的是**不应改变**的行为（正常启动、隔离保持），本轮没有把它们改成"先红"。

集成层面的红同样已观测：Command 1 在旧代码上永不产生终止证据，命令停在 `CLAIMED`、`quiesced_at IS NULL`、journal 停在 `phase: claimed`。

### 1.2 GREEN

见 §2、§3。

---

## 2. 单元测试

```
npx vitest run tests/unit
 Test Files  13 passed (13)
      Tests  77 passed (77)
   Duration  17.58s
```

按第七阶段顺序的定向单元集合：

```
npx vitest run tests/unit/guardian-closure-proof.test.ts \
               tests/unit/guardian-startup-fault-injection.test.ts \
               tests/unit/guardian-termination.test.ts \
               tests/unit/action-journal.test.ts \
               tests/unit/inbox-journal.test.ts
 Test Files  5 passed (5)
      Tests  30 passed (30)
```

其中 `tests/unit/guardian-termination.test.ts` 六个场景全绿：

```
✓ A: a child killed before it can ever start is settled as a proven startup failure
✓ B: the failing spawn emits error then close and never exit, and produces exactly one terminal decision
✓ C: a child that really starts closes its context and the run resolves with that proof
✓ D: a child that had started and left no proof keeps its isolation instead of being written off as a startup failure
✓ E: a child that died after asking for submission authority is never recorded as a startup failure
✓ F: a failed IPC send goes to its callback, so no error event can follow exit
```

---

## 3. 集成测试

### 3.1 隔离环境（B00-015）

| 项目 | 值 |
| --- | --- |
| `DATABASE_URL` | `postgresql://kff_local:<redacted>@127.0.0.1:55432/kff_test_<20hex>`（由 `scripts/integration.ts` 生成，运行成功即 drop） |
| `KFF_TEST_DATABASE` | `kff_test_<20hex>`，由测试首行强制校验 `/^kff_test_[a-f0-9]{20}$/` 且必须等于 `current_database()` |
| `KFF_ROOT` | `%TEMP%\kff-b01-run-<8hex>`（本轮独立临时根，见下） |
| 运行时目录 | `<KFF_ROOT>\.kff`（journal / closures / browser-environments / local-config.json 全在这里） |
| 日志文件 | `<KFF_ROOT>\.kff\agent\journal.json` |

**独立 KFF_ROOT 的构造（实测结论，记录在案）：** `KFF_ROOT` 在本仓库里同时是"项目根"（`supabase/migrations`、adapter implementation digest、`scripts/` 路径）与"运行根"（`<root>/.kff`）。指向一个**裸临时目录**会改变产品行为，并让 Worker drain 用例挂住：

| KFF_ROOT | local-supervision 结果 |
| --- | --- |
| 裸临时目录 | 2 passed / 1 failed（Worker drain 30s 超时） |
| 裸临时目录 + `local-config.json` | 同上（`supabase/migrations` 找不到，3 files failed） |
| 临时目录 + junction(`supabase`,`packages`,`apps`,`scripts`,`node_modules`) + 自己的 `.kff` | **3 passed / 3 passed** |
| 项目根（缺省） | 3 passed |

本轮实际使用的是**第三种**：`.kff` 真正独立于用户项目根，源码路径通过 junction 解析，内容一致因此 adapter digest 不变。

### 3.2 验收主流程（failure → recovery → 下一个合法命令）

`npx tsx scripts/integration.ts tests/integration/guardian-recovery.test.ts tests/integration/local-supervision.test.ts tests/integration/agent-closure-gate.test.ts tests/integration/execution.test.ts tests/integration/durability.test.ts`

```
 Test Files  5 passed (5)
      Tests  45 passed (45)
   Duration  118.77s

 ✓ tests/integration/guardian-recovery.test.ts (2 tests) 13690ms
   ✓ recovers a real pre-start spawn failure through the normal state machine and then really runs the next command 7696ms
   ✓ resumes the same original proof after a lost acknowledgement and a restart during recovery 5669ms
 ✓ tests/integration/local-supervision.test.ts (3 tests) 19961ms
   ✓ preserves the original receipt after lost acknowledgement and drain 8098ms
   ✓ preserves the original receipt after lost acknowledgement and parent-disconnect 7560ms
   ✓ drains the actual Worker and closes its database pool through local IPC on Windows 3974ms
 ✓ tests/integration/agent-closure-gate.test.ts (8 tests) 14827ms
 ✓ tests/integration/execution.test.ts (28 tests)
 ✓ tests/integration/durability.test.ts (4 tests) 16140ms
```

Command 1 的具体断言（全部通过）：

| 断言 | 观测值 |
| --- | --- |
| journal `phase` | `claimed` |
| journal `guardian_pid` | `undefined`（从未 spawn 成功） |
| journal `quarantined` | `undefined` |
| closure 版本 | `kff.guardian-closure-startup-failed.v1`，`context_opened: false` |
| closure 是否含 `context_closed` | **不含** |
| 该命令在 wire 上的端点 | **恰好** `['commands/<id>/status', 'commands/<id>/quiescence']` → 零 `/submit`、零 `/context-opened`、零平台写入 |
| 回执数 | 1 |
| `kff.agent_commands.state` | `DONE` |
| `quiesced_at` | 非空 |
| `kff.actions.state` | `CANCELED`（`GUARDIAN_STARTUP_FAILED`） |
| `state IN ('READY','CLAIMED')` 计数 | **0** → slot 经正常状态机释放 |
| `action_attempts` 计数 | 1 |
| `action.reported` 审计事件 | 1 |
| `guardian.quiesced` 审计事件 | 1 |
| retention pass | 真的跑过 `compactClosure`（`collection_redaction.reason === 'DELIVERED'`），磁盘记录**仍是** startup-failed 版本、仍无 `context_closed` |
| `browser_inbox_monitors.current_task_id` | 最终为 `null`（只在 `quiesced_at` 设置后才清） |

Command 2 的具体断言（全部通过）：

| 断言 | 观测值 |
| --- | --- |
| `kff.actions.state` | `VERIFIED_SUCCEEDED` |
| `kff.agent_commands.state` / `quiesced_at` | `DONE` / 非空 |
| closure | `context_closed === true`，`closureProof(closure).protocol_version === 'kff.guardian-closure.v1'` |
| `guardian_pid` | > 0（真实 child） |
| wire | 含 `commands/<id>/context-opened`（真实浏览器 context） |
| Command 1 被再 claim 次数 | 1（零重放） |
| Command 1 回执数 | 1 |
| `action_attempts` 计数 | 1 |
| 该 Agent 命令总数 | 2 |
| controller 端错误 | `[]` |

第二个场景（lost-ack + restart）额外证明：重启后的 Agent 重发**同一个** `event_id`，被 `kff.inbound_events` 吸收（`duplicate: true`，无副作用），并续上**同一份** proof；`guardian.quiesced` 恰好 1 条、命令行 1 条、`inbound_events` 1 条、`quiesced_at` 未被重写。

### 3.3 稳定性采样

`npx tsx scripts/integration.ts tests/integration/guardian-recovery.test.ts` 连续 8 次：

```
run1: PASS   run5: PASS
run2: PASS   run6: PASS
run3: PASS   run7: PASS
run4: PASS   run8: PASS
```

加上 §3.2 的验收运行与本轮的其它运行，`guardian-recovery.test.ts` 本轮 **11/11 通过**。

**诚实说明：** 上一轮曾在约 30 次运行中观测到 2 次失败（约 10%），失败形态是 KFF-B01-NEW-01（已启动但停滞的 child，无任何终止事件）。本轮清理掉遗留孤儿 guardian 进程与 34 个遗留 temp root 之后未再复现。**这不能证明该缺陷已消失。** 本轮没有通过重跑制造全绿：每次失败都被保留并归因，`waitForProof()` 现在会在超时时打印 `journal.phase` / `journal.guardian_pid` / `controller.state` / `controller.quiesced_at`，下次复现时失败信息本身即可定位。

---

## 4. B00 原始 repro 探针重跑（第七阶段顺序第 1 项）

对**修复后**的代码重跑 B00 自己的探针，输出保存在本目录。

| 探针 | 输出 | 结果 |
| --- | --- | --- |
| `repro/probe-guardian.ts` | `b01-probe-guardian.after.json` | 调用方拿到 `GUARDIAN_STARTUP_FAILED`（不再是裸 ENOENT）；写入的记录为 `kff.guardian-closure-startup-failed.v1` / `context_opened: false`；`closureProof` 保留同一版本；`readClosure` 抛 `GUARDIAN_STARTUP_FAILED` |
| `repro/probe-guardian-2.ts` | `b01-probe-guardian-2.after.json` | message 与 collection 两条命令的 compactClosure **都没有触达**（`reached_compaction: false`），磁盘上仍是 startup-failed 版本，`context_closed` 为 `null` |
| `repro/probe-journal.ts` | `b01-probe-journal.after.json` | 读的是用户**真实** journal（只读）：399 条目、386 个 closure 文件、`phase` 分布 `{reported:13, submitting:138, context_open:244, claimed:4}`、**stranded_count: 0**、**startup_failure_records: []** |

---

## 5. typecheck / lint

```
npm run typecheck   →  tsc --noEmit   （无输出，通过）
npm run lint        →  eslint .       （无输出，通过）
```

lint 首次运行报出 1 个真实问题（`tests/unit/guardian-termination.test.ts` 中未使用的 `closureFile` import），已删除该 import 后重跑通过。

---

## 6. 数据安全验证

| 检查 | 结果 |
| --- | --- |
| 用户真实 journal `.kff/agent/journal.json` mtime | `2026-09-17 02:19:39`（本轮所有运行都在 17:xx 之后，未被写入） |
| 用户真实 `.kff/agent/process.lock` mtime | `2026-09-17 02:14:47`（同上） |
| 用户真实 `.kff/browser-environments/` 最新目录 | `2026-09-17 15:06`（本轮未新增） |
| 测试内硬断言 | `guardian-recovery.test.ts` 在 `beforeAll` 快照 `.kff/agent/journal.json` 与 `process.lock` 的 `mtimeMs:size`，在 `afterAll` 断言两者完全一致 |
| 隔离数据库 | 每次运行创建 `kff_test_<20hex>`，成功即 drop；运行前强制校验 `current_database()` 必须等于 `KFF_TEST_DATABASE` 且匹配正则 |
| 遗留测试库清理 | 3 次失败运行共 retain 了 3 个库，已用 `drop-retained-test-databases.cjs` 全部 drop（脚本内置 `/^kff_test_[a-f0-9]{20}$/` 白名单，不触碰用户的 `kff`） |
| 进程泄漏 | 本轮结束后 `node-copy.exe` 计数 0；上一轮遗留的 2 个孤儿 guardian child（PID 15388 / 17248）已终止 |
| 临时目录泄漏 | 本轮结束后 `%TEMP%` 下 `kff-b01-*` / `kff-collection-journal-*` / `kff-local-supervision-*` 计数 0（测试自身现在负责清理） |
| 未启动任何正式服务 | 全轮只启动了嵌入式 Postgres（`127.0.0.1:55432`）用于隔离测试库，未启动 web / worker / agent 正式实例 |

**未触碰：** 用户真实 journal、真实 agent runtime、正式 browser profile、正式数据库（`kff`）、正式服务。

---

## 7. 本轮未运行的测试

按第七阶段要求，**完整** unit / contracts / integration / fixtures / build / UI 统一留到 B04。本轮只跑了与 Guardian trust closure 相关的定向单元与相关集成，加上全量 `tests/unit`（作为共享 helper 改动的回归保护）。
