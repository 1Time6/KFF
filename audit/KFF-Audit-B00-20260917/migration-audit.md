# migration-audit.md — 迁移、隔离与数据库不变式审计

审计对象 SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`
方法：**静态源码与 SQL 解析**。本轮**未打开任何数据库、未执行任何迁移、未连接 5432/5433**。

> 用户规则："**如果迁移必须执行，只能使用独立测试数据库。**"
> 本轮判定：**不需要执行迁移即可完成本次审计**——所有结论均可由 SQL 文本与调用图静态得出。因此**一条迁移都没有跑**，也就不存在污染用户日常库的可能。
> 若后续要做"重复 migrate / 失败回滚 / 已有库升级"的**动态**验证，必须按下方第 2.5 节的方式在独立测试库中进行。

---

## 1. 迁移全量枚举（33 / 33，非仅最新）

`supabase/migrations/*.sql` 实测 **33 个文件**（`ls | wc -l` = 33），与用户给出的数字一致。
外部审计只读了 5 个；本轮**逐文件解析了全部 33 个**。

| # | 迁移 | 主要产出对象 |
|---|---|---|
| 1 | `20260911164326_g1_execution_core` | 建 `organizations/brands/memberships/local_users/sessions/accounts/agents/environments/capabilities/content_versions/tasks/approval_decisions/runs/actions/action_attempts/resource_leases/jobs/agent_commands/inbound_events/diagnostic_bundles/audit_events`；**RLS 主体条款在此** |
| 2 | `20260911173241_g1_permits_reconciliation` | `pilot_permits`、`pilot_reservations`；`agent_commands+quiesced_at` |
| 3 | `20260911175249_g1_capability_evidence` | `capability_checks`、`adapter_artifacts`；`capabilities+implementation_digest` |
| 4 | `20260911175746_g1_agent_slot_guard` | **`CREATE UNIQUE INDEX agent_single_execution_slot ON kff.agent_commands(agent_id) WHERE state IN ('READY','CLAIMED')`** |
| 5 | `20260911181005_g1_stop_and_agent_management` | `organization_memberships`；`organizations/accounts+outbound_paused` |
| 6 | `20260911185039_g1_contact_eligibility` | `contact_targets`、`contact_permissions` |
| 7 | `20260911190913_g2_cost_ledger` | `cost_budgets`、`cost_entries`、`cost_reservations` |
| 8 | `20260911194100_g1_action_adjudication` | `action_adjudications`；`actions+adjudication_version`；触发器 `protect_action_transition` |
| 9 | `20260911200056_g2_template_versions` | `template_versions`、`template_previews`、`template_events` |
| 10 | `20260911203355_g2_collection_checkpoints` | `collection_queries/runs/pages/results/objects/observations/events`（**采集断点真身**） |
| 11 | `20260911213439_g2_import_export` | `import_files`、`import_previews`、`import_confirmations` |
| 12 | `20260911221017_g2_target_snapshots` | `target_snapshots`、`target_previews` |
| 13 | `20260911224129_g2_schedule_rules` | `schedules`、`schedule_versions`、`schedule_previews`、`schedule_occurrences` |
| 14 | `20260911235946_g3_owned_inbound` | `customers/customer_identities/customer_events/conversations/messages/site_channels/visitor_sessions`；`inbound_events+source_key/source_kind` |
| 15 | `20260912003348_g3_owned_order_snapshots` | `products`、`product_versions`、`orders`、`order_events`、`order_previews`、`commerce_currencies` |
| 16 | `20260912012250_g3_stripe_payments` | `stripe_connections`、`payment_checkouts`、`verified_payments`、`stripe_events`；触发器 `protect_order_snapshot` |
| 17 | `20260912022322_g3_stripe_refunds` | `refund_requests/postings/ledgers`、`stripe_refunds/disputes`、`financial_adjustments/observations`、`dispute_balance_entries` |
| 18 | `20260912031707_facebook_lead_inbound` | `facebook_connections`；`conversations+handling_mode/control_version/last_inbound_sequence/...`；`customers+lead_status/intent_level/...`；`check_owned_message_scope` |
| 19 | `20260912032804_lead_reception_execution` | `whatsapp_destinations`、`whatsapp_referrals`；`*/+stop_epoch`；`conversations+last_answered_sequence`；`messages+action_id/actor_kind` |
| 20 | `20260912034626_lead_automation_rules` | `facebook_connections+reception_policy`；`jobs+job_key/kind/payload/conversation_id/message_id/lease_*` |
| 21 | `20260912040653_lead_metrics_and_ingress_limits` | 4 个统计索引；触发器 `reception_payload_scope` |
| 22 | `20260912061549_acquisition_automation` | `acquisition_monitors/scans/evaluations/leads/suppressions/action_links` |
| 23 | `20260912121030_acquisition_external_sources` | `acquisition_sources/imports/prospects` |
| 24 | `20260912131442_browser_environment_runtime` | `environment_commands`；`resource_leases+holder_control_id` |
| 25 | `20260912151353_browser_collection_tasks` | `collection_runs+browser_task_id` |
| 26 | `20260912162852_browser_inbox_identity` | `check_inbound_message_scope` |
| 27 | `20260912164913_browser_inbox_polling` | `browser_inbox_monitors`、`browser_inbox_checkpoints` |
| 28 | `20260912172904_browser_message_transport` | `facebook_connections+transport`；重定义 `check_inbound_message_scope` |
| 29 | `20260913012544_real_browser_collection_permits` | `pilot_permits_access_path_check` 约束 |
| 30 | `20260913042407_real_browser_inbox_permits` | `pilot_permits_access_path_check` 约束（扩展） |
| 31 | `20260913052626_real_browser_message_permits` | `check_facebook_connection` |
| 32 | `20260913154300_browser_comment_outreach` | `acquisition_action_links+superseded_at` |
| 33 | `20260915022051_acquisition_source_continuation` | `acquisition_monitors` 派生到期索引 |

**更正一条外部说法**：`20260915022051_acquisition_source_continuation` 是**派生监控（derived monitor）谱系**迁移，**不是**"搜索分页"。搜索分页的断点存储是 `#10 20260911203355_g2_collection_checkpoints`。本更正经源码核实，非推测。

---

## 2. 迁移基础设施安全性 ✅ 健全

`scripts/migrate.ts` 全文 21 行，机制逐条核实：

| 机制 | 实现 | 评价 |
|---|---|---|
| 并发串行化 | `SELECT pg_advisory_xact_lock(73120421)` | ✅ 两个 migrate 同时跑会串行,不会交错 |
| 应用记录 | `kff.schema_migrations(version PK, sha256 NOT NULL, applied_at)` | ✅ |
| **篡改检测** | `if (previous.rowCount) { if (previous.rows[0].sha256 !== hash) throw new Error('Applied migration changed: ' + file); continue; }` | ✅ **已应用的迁移若内容被改动，直接抛错拒绝启动**——这是真实存在的完整性护栏 |
| 幂等 | `CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` | ✅ 重复 migrate 安全 |
| 换行归一化 | `digest(sql.replace(/\r\n/g, '\n'))` | ✅ CRLF/LF 不会造成假篡改告警（Windows 场景必要） |
| **原子性** | 整个循环包在**单个 `transaction()`** 内 | ✅ 全量成功或全量回滚,**不存在部分应用**状态 |

### 2.1 单事务应用是否合法 —— 已核实

"33 个迁移全在一个事务里跑"只有在**没有任何非事务型 DDL** 时才成立。实测：

| 检查 | 结果 |
|---|---|
| `CONCURRENTLY` 出现次数 | **0** |
| `ALTER TYPE ... ADD VALUE` 出现次数 | **0** |

→ **33 个迁移全部事务安全**，单事务应用成立。`ALTER TYPE` 与 `CREATE INDEX CONCURRENTLY` 都会破坏这个前提，将来若引入必须改造 migrate。

### 2.2 失败回滚

- 任一迁移抛错 → 整个事务 `ROLLBACK` → `schema_migrations` 也不留记录 → **数据库回到迁移前状态**，可安全重跑。
- ✅ 这是正确的失败语义，**未发现问题**。

### 2.3 已有库升级

- 迁移按文件名排序执行（`sort()`），文件名是零填充时间戳 → 字典序 = 时间序 ✅
- `schema_migrations` 逐条比对，已应用者跳过、仅新增者执行 ✅
- ⚠️ **未验证项**：`schema_migrations` 表中若记录了本地不存在的 version（例如来自另一分支的迁移），migrate **不会报错**——它只遍历磁盘文件。这属于"迁移分叉"风险，本轮**无证据表明发生过**，标记为潜在缺口而非缺陷。

### 2.4 migrate 的权限路径

`scripts/migrate.ts:7` 用的是**裸 `transaction()`**（不是 `scoped()`）→ 以 `DATABASE_URL` 用户身份运行，**不受 RLS 约束**。这对 DDL 是**必要且正确**的（否则无法建表）。

### 2.5 若将来要做动态验证（本轮未做）

必须满足：`KFF_TEST_DATABASE` 环境变量存在，且库名匹配 `/^kff_test_[a-f0-9]{20}$/`（`packages/database/src/runtime.ts` 强校验），再经 `scripts/migrate.ts` 应用。
**本轮未执行**，因此"重复 migrate 幂等""失败回滚""真实已有库升级"三项**都是静态推断，不是实测结果**——不得当作 PASS。

---

## 3. RLS 覆盖：88 / 91

**方法**：静态解析 33 个 SQL 文件，统计 `CREATE TABLE kff.*` 与 RLS 启用点（含 16 个迁移中的 `DO $$ ... FOREACH tab IN ARRAY ARRAY[...] ... ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY ... CREATE POLICY scoped_access ...` 循环）。

> ⚠️ **本审计方在此处曾产生过一次自我误报**：初版正则 `/FOREACH\s+tab\s+IN\s+ARRAY\s*\[/` 未匹配到真实写法 `FOREACH tab IN ARRAY ARRAY[...]`（双 `ARRAY` 关键字），一度得出"81 张表从未启用 RLS"的错误结论。经回读 `20260911164326_g1_execution_core.sql:118-147` 修正正则后重算，结论如下。**该误报从未写入任何交付物。**

| 指标 | 值 |
|---|---|
| 创建的 `kff.*` 表 | **91** |
| 启用了 `scoped_access` RLS 策略的表 | **88** |
| 未启用 RLS 的表 | **3** |

### 3.1 三张例外的逐张裁定

| 表 | 有 RLS？ | 有 `kff_app` 授权？ | 裁定 |
|---|---|---|---|
| `kff.local_users` | ❌ | **无任何授权**（`GRANT` 全文匹配：NONE） | ✅ **不应有 RLS**。它是**前作用域（pre-scope）身份表**——登录发生在任何 organization/brand 作用域存在**之前**。且未授权给 `kff_app`，`scoped()` 路径根本读不到它。 |
| `kff.sessions` | ❌ | **无任何授权** | ✅ 同上。`apps/web/lib/auth.ts` 经**裸 `query()`**（非 `scoped()`）访问，正是设计意图。 |
| `kff.adapter_artifacts` | ❌ | `GRANT SELECT ... TO kff_app` | ⚠️ **可接受但需记录**。它是**共享能力产物登记表**（按 `capability_id + adapter_version` 查，`packages/core/src/capabilities.ts:13`），本身不含 organization/brand 列，故无法加租户策略。跨租户可读的是**适配器摘要/版本元数据**，非客户数据。 |

**结论：RLS 例外项均有正当理由，未构成可报告缺陷。**

### 3.2 `FORCE ROW LEVEL SECURITY` 缺失 —— 经分析**不构成缺陷**

全文匹配 `FORCE ROW LEVEL SECURITY`：**0 处**。

乍看是缺口，但实测**不成立**，理由如下：
- 表的 owner 是迁移执行者（`DATABASE_URL` 用户）；`FORCE` 只影响 **owner 自己**绕过 RLS 的行为。
- 应用在 `scoped()` 路径中执行 `SET LOCAL ROLE kff_app`，**当前角色不再是 owner**，因此 RLS **照常生效**。
- `kff_app` 的创建语句含 **`NOBYPASSRLS`**，无法自行绕过。

→ 即：**owner 路径（迁移、worker 认领）不受 RLS 约束是设计选择，`scoped()` 路径受约束是事实。** 详见第 4 节。

---

## 4. 【核心机制】隔离的真实实现：双路径，而非"全库 RLS"

这是本轮对"RLS 保护了系统"这一笼统说法最重要的收窄。

`packages/database/src/index.ts` 只有 3 个数据访问出口：

```ts
// L11 —— 无角色切换，以 DATABASE_URL 用户身份执行 → RLS 不生效
export async function query<T>(sql, args=[]) { return (await getPool().query<T>(sql,args)).rows; }

// L12 —— 开事务，同样不切换角色 → RLS 不生效
export async function transaction<T>(fn) { ... client.query('BEGIN') ... }

// L18-24 —— 唯一切换角色的出口 → RLS 生效
export async function scoped<T>(scope: Scope, fn) {
  return transaction(async client => {
    await client.query("SELECT set_config('kff.organization_id',$1,true), set_config('kff.brand_id',$2,true), set_config('kff.user_id',$3,true)", [...]);
    await client.query('SET LOCAL ROLE kff_app');        // ← L21 隔离的唯一开关
    return fn(client);
  });
}
```

连接串（L8）的 `options` 仅为 `-c timezone=UTC`，**不含 role**。

### 4.1 实测三条路径的实际分布

| 路径 | 实测使用情况 | RLS |
|---|---|---|
| `scoped()` | **core 域层几乎全覆盖**：`service/templates/inbox/lead-reception/execution/environments/collections/contacts/controls/costs/imports/orders/payments/refunds/permits/schedules/target-snapshots/adjudication/reconciliation/acquisition/...` 实测 **190+ 个调用点** | ✅ 生效 |
| `transaction()` | **32 处**，集中在**必须跨租户的 worker 认领循环**：`claimCollection()` (`collections.ts:49`，`FOR UPDATE OF r SKIP LOCKED` 且**故意不带租户条件**)、`claimReception()` (`reception-worker.ts:23`)、`acquisition*.ts`、`execution.ts` 等 | ❌ 不生效 |
| `query()` | **14 处**，均为**作用域尚不存在**的前置解析：`execution.ts:22`（agent token → 身份）、`facebook-inbound.ts:157`（webhook 按 `page_id` → 连接）、`inbox.ts:53`（`channelScope`）、`payments.ts:15`、`payment-worker.ts:66/94`、`refund-worker.ts:16` | ❌ 不生效 |

**裁定：这是自洽的架构，不是缺陷。**
- Web/API 的**人驱动路径**经 `scoped()`，RLS 作为**纵深防御**叠加在显式 `WHERE organization_id=... AND brand_id=...` 之上。
- Worker 的**认领路径**必须在无租户上下文时扫描全局队列，**RLS 在那里反而会阻断正常工作**；认领后立即回到 `scoped()` 处理。
- 前置解析路径（token、page_id、channel_id）**在语义上先于作用域存在**，无法 scope。

### 4.2 由此产生的**真实残余风险**（记为 P2，非 P0）

RLS 是**部分**防线而非全局兜底：**任何误用 `query()`/`transaction()` 处理租户数据的代码，将完全失去 RLS 保护，只剩手写谓词。**
- 本轮**未发现**这样的误用：上表 32+14 个调用点逐一核对，全部属于"跨租户认领"或"前作用域解析"两类正当用途。
- 但这是一个**无自动检查**的边界：新增代码若用错出口，不会有任何测试或 lint 失败。**这正是需要补的测试**（见第 10 节）。

---

## 5. 授权模型 ✅ 最小权限，无越权授予

| 检查 | 结果 |
|---|---|
| `GRANT ALL` | **无** |
| `GRANT ... ON ALL TABLES` | **无** |
| `ALTER DEFAULT PRIVILEGES` | **无** |
| 角色属性 | `CREATE ROLE kff_app NOLOGIN NOSUPERUSER NOBYPASSRLS` ✅ |
| 角色挂载 | `GRANT kff_app TO CURRENT_USER` |
| 逐表授权 | 仅在 RLS DO 循环内 `GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app` |
| **写保护** | `REVOKE UPDATE ON kff.approval_decisions, kff.content_versions, kff.inbound_events, kff.audit_events FROM kff_app` |

**亮点**：对 `audit_events`、`approval_decisions`、`content_versions`、`inbound_events` 四张**审计/批准/原始证据表**回收 UPDATE —— 应用进程**无法事后篡改**自己写下的审计记录。这是本轮见到的**质量最高的一处安全设计**。

**未发现问题。**

---

## 6. 并发与不变式

### 6.1 行锁与跳过锁

| 原语 | 位置 | 用途 |
|---|---|---|
| `FOR UPDATE SKIP LOCKED` | `collections.ts:50`（`FOR UPDATE OF r SKIP LOCKED`）、`claimReception`（45s 租约）等 | 多 worker 并行认领不互相阻塞 |
| `FOR UPDATE` | `site_channels`（`inbox.ts:41,73`）、`refund_ledgers`（`refund-worker.ts:48`）、`actions` 等 | 状态机串行化 |
| `FOR SHARE` | `accounts`/`environments`（`collections.ts:28,40,53`） | 读期防止被并发改动 |
| `pg_advisory_xact_lock` | `collections.ts:25`（`collection/<brand_id>/<request_id>`）、`facebook-inbound.ts:63`（幂等键）、`migrate.ts:8` | 幂等串行化 |
| 迁移中的 `SKIP LOCKED` | **0 处**（正常：SKIP LOCKED 属于应用查询，不属于 DDL） | — |

### 6.2 【重要】数据库层不变式独立加固了 P1 缺陷

`20260911175746_g1_agent_slot_guard.sql` 全文仅 1 行：

```sql
CREATE UNIQUE INDEX agent_single_execution_slot ON kff.agent_commands(agent_id) WHERE state IN ('READY','CLAIMED');
```

**这是部分唯一索引：一个 agent 在 `READY`/`CLAIMED` 状态下最多只能有一条命令。**

它与本轮 P1 缺陷 `KFF-B00-002` 直接相关，且**方向一致**：
- 应用层阻断：`apps/agent/src/main.ts:82` `requireCondition(await flushJournal(), 'GUARDIAN_UNCONFIRMED', ...)`
- 数据库层阻断：即使应用层被绕过，插入第二条 `CLAIMED` 命令也会触发**唯一约束冲突**

**对修复方案的影响（重要）**：一条卡在 `CLAIMED` 的命令**同时占住应用层的 journal 门和数据库层的执行槽位**。因此任何修复**不能靠"再插一条补偿命令"**——必须先把卡住的命令**退出 `CLAIMED` 状态**，否则补偿插入会直接违反 `agent_single_execution_slot`。此约束已写入 `repair-plan.md` 的 B01 前置条件。

### 6.3 唯一约束与幂等键

- `UNIQUE` 出现 **106 处**（含复合唯一、部分唯一）。
- `idempotency_key` **4 处**；`request_id` 与 `request_hash` 成对出现在 `collection_queries` 等表，配合 `ON CONFLICT(brand_id,job_key) DO NOTHING` 与 `digest(payload)`。
- 入站事件幂等：`facebook-inbound.ts:63-69` 用 `pg_advisory_xact_lock` + `source_key/source_kind` 查旧记录 + `payload_hash` 比对，冲突时 `IDEMPOTENCY_CONFLICT` 409 并**整批回滚**（已由隔离库测试覆盖）。

---

## 7. IDOR / BOLA 专项

### 7.1 `channelScope` —— 从请求 id 推导租户，**经核查为正当设计**

`packages/core/src/inbox.ts:51-56`：

```ts
// Only this minimal lookup precedes RLS. Tenant and actor are derived by the server, never from request fields.
async function channelScope(channelId:string,actorId=randomUUID()) {
  const row=(await query<...>('SELECT organization_id,brand_id FROM kff.site_channels WHERE id=$1',[channelId]))[0];
  requireCondition(row,'NOT_FOUND','咨询入口不存在',404);
  return {...row,user_id:actorId,role:'operator' as const};
}
```

"由客户端提供的 id 推导出租户"是典型的 BOLA 形状，故**逐调用点核查**：

| 调用点 | 是否需要凭据 | 裁定 |
|---|---|---|
| `publicChatInfo` (L57) | 无 | ⚠️ 公开只读，仅返回 `name/state/is_synthetic/session_hours/...`，**不含客户数据**；`channelId` 是 UUID，不可枚举。可接受。 |
| `beginVisitorSession` (L70) | 无（创建会话） | ✅ 有每通道限流 `sessions_per_minute`，且需 `state==='ACTIVE'` |
| `endVisitorSession` (L91) | **需 64 位 hex token** | ✅ |
| `visitorSessionStatus` (L98) | token 无效则返回 `{active:false}` | ✅ |
| `receiveVisitorMessage` (L107) | **需 token**（`checkToken`） | ✅ |
| `inbox.ts:161` | 需 token | ✅ |

**裁定：无 BOLA。** 这是**公开访客通道**的固有语义——访客没有租户身份，通道 id + 会话 token **就是**授权凭据。租户由服务端从 `site_channels` 推导、**从不取自请求字段**，正是正确的做法。

### 7.2 其余 BOLA 检查面

| 检查面 | 结果 |
|---|---|
| 租户数据是否经 `scoped()` + 显式谓词双保险 | ✅ 人驱动路径全部如此 |
| 对象级 id 是否在**当前 scope 内**再校验 | ✅ 大量 `requireCondition(row,'NOT_FOUND',...,404)` 在 `scoped()` 事务**内部**执行（如 `target-snapshots.ts:75`、`site_channels` 等），跨租户 id 因 RLS 直接查不到 → 统一 404，不泄露存在性 |
| 是否用 403/404 泄露对象存在性 | ✅ 跨租户一律 404（RLS 过滤后为空），非 403 |
| 复合外键是否含租户列 | ✅ 如 `internalSelect`（`collections.ts:16`）JOIN 条件显式包含 `q.organization_id=r.organization_id AND q.brand_id=r.brand_id` |
| 写路径是否校验 `scope.role` | ✅ `requireWrite(scope)` / `requireAdmin(scope)` 分布在多数写函数（`acquisition.ts:128,141`、`payments.ts:82,93`、`refunds.ts:53,57`、`permits.ts:73`、`capabilities.ts:8` 等） |

**未发现 IDOR/BOLA 实例。**

---

## 8. 数据损坏与错误解除隔离

| 风险 | 核查结果 |
|---|---|
| 状态机是否有 DB 层护栏 | ✅ 触发器 `protect_action_transition`（#8）、`protect_order_snapshot`（#16）、`protect_referral`（#17 谱系） |
| 错误账号操作 | 见 `findings.json`：`facebook-browser-inbox.ts` 在**每行**校验发送者头像 `href==='/'+peer_id+'/'`，并在发送前重新完整校验线程——防线充分 |
| 重复外发 | ✅ `automatic_write_retry:false` + `beforeSubmit` 进程内仅一次（`guardian.ts:52` `submitted` 标志）+ 部分唯一索引 `agent_single_execution_slot` |
| 错误解除隔离 | 见 P1 `KFF-B00-002`：卡死时**是"过度隔离"而非"错误解除"**——系统倾向于**保持隔离**（`GUARDIAN_UNCONFIRMED`、`MESSAGE_IN_FLIGHT`、`quarantined`）。方向安全，代价是可用性。 |
| 幂等冲突 | ✅ `IDEMPOTENCY_CONFLICT` 409 + 整批回滚 |

---

## 9. 本节结论

| 项 | 结论 |
|---|---|
| 迁移数量 | 33，**全部枚举并逐条解析** ✅ |
| 迁移基础设施 | **健全**（advisory lock + sha256 篡改检测 + 单事务原子 + 幂等守卫） ✅ |
| 非事务型 DDL | 0 ✅（单事务应用合法） |
| RLS 覆盖 | 88/91，3 例外**均有正当理由** ✅ |
| `FORCE RLS` 缺失 | **经分析不构成缺陷**（`kff_app` 非 owner 且 `NOBYPASSRLS`） ✅ |
| 授权最小化 | 无 blanket grant，审计类表回收 UPDATE —— **本轮最佳设计** ✅ |
| IDOR/BOLA | **未发现实例**；`channelScope` 经逐点核查为正当设计 ✅ |
| 数据库层不变式 | `agent_single_execution_slot` **独立加固**了 P1 ✅ |
| **新缺陷** | **本区域未发现 P0/P1。** 仅 1 条 P2 残余风险（见 4.2：RLS 非全局兜底，缺自动检查） |

---

## 10. 需要补的测试（本轮未执行，列入 `repair-plan.md`）

| # | 测试 | 目的 | 前置 |
|---|---|---|---|
| M1 | **RLS 越权读取测试** | 以租户 A 的 scope 经 `scoped()` 读租户 B 的对象，断言**空结果**（而非报错）。这是唯一能证明 RLS 真正生效的测试 | 独立测试库 |
| M2 | **`kff_app` 能力测试** | 断言 `kff_app` 对 `audit_events` 等 4 表的 UPDATE **被拒绝** | 独立测试库 |
| M3 | **双路径守卫测试** | 静态或运行时断言：处理租户数据的函数**必须**经 `scoped()`。可做成 lint/单测 | 无需库 |
| M4 | **重复 migrate 幂等** | 连跑两次 `migrate()`，断言第二次全跳过且无错 | 独立测试库 |
| M5 | **migrate 失败回滚** | 注入一个含错误的迁移，断言 `schema_migrations` 无残留、库回到迁移前 | 独立测试库 |
| M6 | **迁移篡改检测** | 改动一个已应用迁移的字节，断言抛 `Applied migration changed` | 独立测试库 |
| M7 | **`agent_single_execution_slot`** | 断言同一 agent 第二条 `CLAIMED` 命令被唯一约束拒绝；并断言 B01 修复后卡死命令能退出 `CLAIMED` | 独立测试库 |
| M8 | **并发 cancel vs dispatch** | WhatsApp referral 投影的取消/派发竞争（外部审计标为 SAFE，但**无任何测试覆盖**） | 独立测试库 |

> 以上 8 项**全部未执行**。原因：均需数据库实例，而本轮**无法证明与用户日常环境隔离**（见 `baseline.md` 第 3.4 节）。**不得当作通过。**
