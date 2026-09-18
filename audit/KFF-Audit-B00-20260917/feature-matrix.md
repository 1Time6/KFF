# feature-matrix.md — 功能矩阵与证据等级

审计对象 SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`

## 标签定义（本轮统一口径）

| 标签 | 含义 | 证明力 |
|---|---|---|
| `IMPLEMENTED` | 源码中真实存在且被调用 | 仅证明"写了" |
| `TESTED_SYNTHETIC` | 用手写 DOM / 假数据跑**生产过程代码** | 证明内部自洽，**不证明真实平台可用** |
| `TESTED_ISOLATED_DB` | 用隔离测试库跑通链路 | 证明数据库语义，**不证明浏览器可用** |
| `REAL_EVIDENCE` | 有真实账号/真实页面的**可归档证据** | 最强，但**单次样本** |
| `MANUAL_STEP` | 必须人工操作才能完成 | 属功能缺口 |
| `UNVERIFIED` | 无法核实 | **不得当作通过** |

> **本轮不新增任何 `REAL_EVIDENCE`**（未触碰真实 Facebook/WhatsApp/Stripe）。下表的 `REAL_EVIDENCE` 全部是**仓库内既存证据**，本轮只做**归档核对**，未做新验证。

---

## 1. 优先业务链主表

| 链节 | 功能 | 标签 | 证据 / 说明 |
|---|---|---|---|
| ① | Apify 数据集导入来源 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `tests/integration/acquisition-provider.test.ts`、`tests/contracts/apify*.test.ts` |
| ① | **Facebook 浏览器搜索发现** | `IMPLEMENTED` + `TESTED_SYNTHETIC` | `adapters/facebook-search.ts`；fixture `tests/browser/fixtures/facebook-search.spec.ts` |
| ① | **人工选定来源** | **`MANUAL_STEP`** | ⚠️ **仍然必需**：无任何代码路径能在无人工输入下创建**第一个**来源。`connectApifySource(scope)` 需操作员提供凭据引用；手动 Apify Run ID 亦由操作员键入 |
| ① | 派生监控自动续跑 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `acquisition-continuation.ts:47-94 deriveCommentMonitors()`；worker `main.ts:29` 自动调用；`tests/contracts/acquisition-continuation.test.ts`、`tests/integration/acquisition.test.ts` |
| ② | Facebook 帖子采集 | `IMPLEMENTED` + `TESTED_SYNTHETIC` | `browser-collections` + fixture |
| ② | Facebook **评论**采集 | `IMPLEMENTED` + `TESTED_SYNTHETIC` | `tests/browser/fixtures/facebook-comments.spec.ts`、`tests/contracts/facebook-browser-comment.test.ts` |
| ② | 真实浏览器采集 | `IMPLEMENTED` + `TESTED_ISOLATED_DB`（真实运行=**未验证**） | `tests/integration/real-browser-collections.test.ts` 是**隔离库**测试；真实采集本轮无新证据 |
| ③ | 候选筛选 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `collection-filter.ts`、`target-snapshots` |
| ④ | Lead 生成 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `tests/integration/acquisition.test.ts`、`lead-management.test.ts` |
| ⑤ | 受控互动任务（许可 + 成本 + 排期） | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `permits.ts`/`costs.ts`/`schedules.ts`，各有 integration 测试 |
| ⑥ | Inbox 收件（合成） | `IMPLEMENTED` + `TESTED_SYNTHETIC` | `browser-inbox` + fixture |
| ⑥ | Inbox 收件（真实页面） | `REAL_EVIDENCE` | `docs/evidence/c-inbox-recheck-diagnostic-043-20260914.json:16-27`：从**真实页面**解析出 `{thread_id:"2234491403949554", display_name:"XiangHuan Master"}` |
| ⑥ | Inbox 身份核验 | `REAL_EVIDENCE` | `c-whatsapp-043-20260914.json:96` 真实 `actual_account_id:"61594402378582"` |
| ⑦ | AI 接待（LOCAL_RULES） | `IMPLEMENTED` + **本轮实测**（探针 40 断言） | ⚠️ 9/40 不符，见 `findings.json` KFF-B00-001 |
| ⑦ | AI 接待（OPENAI_COMPATIBLE / DeepSeek） | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `tests/contracts/reception-model.test.ts`、`reception-transport.test.ts`；**真实模型调用未执行** |
| ⑦ | 人工接管 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `conversationControl`、`handling_mode` |
| ⑧ | WhatsApp 移交投影 | `IMPLEMENTED`（静态核查为 **SAFE**） | 7 条终态路径均在同一事务内调 `projectMessageOutcome`；锁序（run→action）串行化取消 vs 派发；`WHERE state IN ('QUEUED','UNKNOWN')` 状态守卫；`protect_referral` 版本触发器；`action_id` NOT NULL UNIQUE。**但并发场景零测试覆盖** |
| ⑨ | 客户记录与结果追踪 | `IMPLEMENTED` + `TESTED_ISOLATED_DB` | `contacts.ts`、`customers/*`、`costs.ts` |
| ⑨ | WhatsApp 真实发送 | **`UNVERIFIED`** | 本轮未执行，也未发现既存真实证据 |

---

## 2. 真实发送能力：全仓库真实证据盘点

**这是全项目最关键的能力，也是证据最薄的地方。**

| 顺序 | 事件 | 结果 | 证据 |
|---|---|---|---|
| 1 | 2026-09-13 首次真实发送 | ❌ **未自动验证**——旧解析器漏掉真实的 `"5分钟前发送"` 纯文本状态 → `UNKNOWN_OUTCOME` → **人工裁定** | `docs/api/real-browser-message.md:20-22` |
| 2 | 解析器修复后 | ✅ **1 次真实自动验证发送**：`state:"VERIFIED_SUCCEEDED"`, `remote_id:"100050174601107@msgr.7505288161128367482"`, 耗时 28850ms | `docs/evidence/c-whatsapp-043-20260914.json:87-101,124-150` |
| 3 | 后续真实运行 | ❌ 解析阶段 fail-closed：`BLOCKED / INBOX_SOURCE_MISMATCH` | `c-whatsapp-correction-044-20260914.json:88-89` |

**结论：全项目历史上只有 1 次自动验证成功的真实发送，1 次人工裁定，1 次 fail-closed。**
第二次独立真实发送 → **UNVERIFIED**。第三方审计的"真实发送链路已通"若不限定为"1 次"，即为过度概括。

---

## 3. 冻结模块（范围 A）— 只审"能否被误达 / 是否影响 V1"

用户明确：**不把完整支付重构列为 Facebook 试点前置条件**。故本节只回答四个问题。

| 问题 | 裁定 |
|---|---|
| 能否从当前 UI/API 误达？ | **能，且已接线**。`/orders` 段有效；路由在 `route.ts:180-192` 全部可达。**这不是缺陷，是产品意图** |
| 是否真能发起扣款/退款？ | **能，但受闸**。`payments.ts:25` `LIVE_DISABLED`：要求 `connection.mode==='TEST'` 或 `KFF_ENABLE_LIVE==='true'`。默认关闭 → 真实扣款需**显式开启环境变量 + 注册真实连接** |
| 是否有越权 / 数据损坏风险？ | ❌ **未发现**。角色门控（退款/连接/产品=admin，订单/结账=operator）；RLS + 复合外键 + 事务内 scope；无 IDOR |
| 是否影响 Facebook V1？ | ❌ **不影响**。独立表、独立队列、独立 worker 循环 |

### 3.1 ⚠️ 本节唯一值得记录的观察（记为 P3）

**人工确认闸在"入队时刻"，而非"发起时刻"。**
- `payment-worker.ts:81` 会自动创建 Stripe Checkout Session
- `refund-worker.ts:40` 会自动发起 Refund
- 两者都是 **worker 自动执行**，从队列取出即发，**没有第二次人工确认**

即：管理员点了"退款"，退款申请入队；之后 worker **自行**调用 Stripe。若此时管理员反悔，窗口只在入队到 worker 取件之间。
- **缓解**：`cancelUnsubmittedRefund` 存在（`refunds.ts:57`，admin 门控）→ 可在未提交前取消
- **裁定**：属**已知设计取舍**（队列即授权），非缺陷。但**应在 B02/B04 之外单独知会产品**，因为它是"钱"的路径。

### 3.2 支付模块的完整性边界（本轮**未**验证）

未执行：真实 Stripe 调用、退款全流程、对账、争议处理。`tests/integration/payments.test.ts` / `refunds.test.ts` 均为**隔离库**测试。
→ 支付模块整体为 `TESTED_ISOLATED_DB`，**真实链路 `UNVERIFIED`**。

---

## 4. 明确推迟的能力（范围 A，本轮只确认"未偷偷启用"）

| 能力 | 状态 | 核实方式 |
|---|---|---|
| Instagram | 未实现 | 源码无 IG 适配器 |
| Threads | 未实现 | 同上 |
| AI 自动刷帖养号 | **未实现** | 无自动浏览/养号循环 |
| 30 账号并发 | **无数据** | `audit-repair-round2-20260917.json:74` 自述 "no load"；本机实测最多同时存在 1 个 agent 执行槽（`agent_single_execution_slot` 部分唯一索引） |
| 大规模自动外发 | 受 `pilot_permits` + 成本预算 + 频率限制约束 | `permits.ts`、`costs.ts` |

> `agent_single_execution_slot`（`agent_commands(agent_id) WHERE state IN ('READY','CLAIMED')` 唯一索引）是**数据库层的并发上限**：一个 agent 同时只能有一条命令。"30 账号并发"在数据模型上需要 30 个 agent 记录，目前**从未验证过**。

---

## 5. 证据等级统计（本轮口径）

| 标签 | 链节数 | 备注 |
|---|---|---|
| `REAL_EVIDENCE` | **4** | 全部为**仓库内既存**证据，本轮未新增；且**样本数极小**（真实发送 = 1 次） |
| `TESTED_ISOLATED_DB` | 12 | 需数据库，本轮**未复跑**（无法证明隔离） |
| `TESTED_SYNTHETIC` | 4 | 手写 DOM，不含真实 Messenger |
| `IMPLEMENTED`（无测试或仅契约） | 3 | — |
| `MANUAL_STEP` | 1 | **人工选定来源** |
| `UNVERIFIED` | 2 | WhatsApp 真实发送、支付真实链路 |

---

## 6. 最容易被误读的三句话（本轮纠偏）

1. **"Facebook 采集已实现"** → 准确说法：**发现环节仍需人工选定来源**，自动化只覆盖"已选定来源之后的续跑"。
2. **"真实发送已验证"** → 准确说法：**历史上 1 次自动验证成功**，第 2 次独立验证 `UNVERIFIED`。
3. **"25 项缺陷已全部修复并验证"** → 准确说法：外部审计**只能核实 25 项中的 3 项**，其余 21 项为 `CANNOT_VERIFY`，且 `KFF-B05` 被重新打开（`docs/defect-ledger-round2-20260917.json:22`）。**`CANNOT_VERIFY` 不能统计成已修复。**
