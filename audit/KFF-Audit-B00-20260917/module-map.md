# module-map.md — 模块地图

审计对象 SHA：`752042bc466b10b07cad455757a41bb10bbaf39f`
方法：源码静态阅读 + 实测统计。**本轮未构建、未运行服务。**

---

## 1. 仓库结构（实测文件数）

| 位置 | `.ts`/`.tsx` 文件数 | 角色 |
|---|---|---|
| `packages/core/src` | **47** | 领域层：全部业务规则、状态机、权限判定、事务 |
| `apps/web/components` | 44 | React 19 界面 |
| `packages/adapters/src` | **34** | DOM/DOM 解析、AdsPower 驱动、Apify、fixture |
| `packages/contracts/src` | 20 | zod schema 与类型（跨端唯一契约来源） |
| `apps/agent/src` | **11** | 本机执行端（Guardian + 子进程 + journal） |
| `apps/web/lib` | 4 | `auth.ts` / `api-errors.ts` / `login-throttle.ts` / `visitor-auth.ts` |
| `apps/web/app` | 3 | 单一 catch-all API + 两个页面段 |
| `packages/database/src` | 2 | **`index.ts` 的三个数据出口（隔离机制核心）** |
| `apps/worker/src` | 1 | 后台轮询总入口 |

**测试文件合计 117 个**：`tests/unit` 10、`tests/contracts` **43**、`tests/integration` **38**、`tests/browser/fixtures` 10、`tests/browser/web` 16。

---

## 2. 分层与信任边界

```
浏览器 ──HTTP──► apps/web (Next.js 16.3.4)
                    │  ① apps/web/app/api/[[...path]]/route.ts  ← 唯一 HTTP 入口(306 行)
                    │  ② requestScope()  从 kff.memberships 推导 org/brand/role
                    │  ③ scoped(scope, …)  SET LOCAL ROLE kff_app ← RLS 生效点
                    ▼
              packages/core (领域层, 47 文件)
                    │  全部租户写读都在 scoped() 内 + 显式 WHERE
                    ▼
              packages/database ──► Postgres(kff schema, 91 表, RLS 88)

Worker ──► apps/worker/src/main.ts ──► 9 个轮询循环（跨租户认领用裸 transaction()）
Agent  ──► apps/agent ──► HTTP 回传 core；浏览器只由 Guardian 子进程驱动
```

### 2.1 三个信任边界（本轮实测确认）

| 边界 | 机制 | 位置 |
|---|---|---|
| **HTTP → 应用** | `authenticate()` → `requestScope()`：`role`/`organization_id`/`brand_id` **全部来自 `kff.memberships` 表，从不取自请求体**；`x-kff-brand` 仅作选择器且必须命中成员行 | `auth.ts:28-33` |
| **应用 → 数据库** | `scoped()` 的 `SET LOCAL ROLE kff_app`（`NOBYPASSRLS`） | `database/src/index.ts:21` |
| **应用 → 浏览器** | Guardian 父子进程 IPC + `before-submit` 握手；子进程 `ready`→父 `start`→子 `context-opened`→父授权 `submit-granted` | `agent/src/guardian.ts` / `guardian-child.ts` |

---

## 3. 优先业务链的模块归属

| 链节 | 实现位置 | 状态 |
|---|---|---|
| ① Facebook 来源发现 | `core/acquisition.ts`, `acquisition-provider.ts`, `adapters/facebook-search.ts`, `ads/*` | ⚠️ **仍需人工选定来源**（见 `feature-matrix.md`） |
| ② 帖子/评论采集 | `core/collections.ts`, `browser-collections.ts`, `adapters/collection-*`, 迁移 #10 | IMPLEMENTED + TESTED_ISOLATED_DB |
| ③ 候选筛选 | `core/collection-filter.ts`, `acquisition.ts`(evaluations) | IMPLEMENTED |
| ④ Lead | `core/lead-management.ts`, `acquisition*.ts` | IMPLEMENTED |
| ⑤ 受控互动任务 | `core/service.ts`, `execution.ts`, `permits.ts`, `costs.ts`, `schedules.ts` | IMPLEMENTED |
| ⑥ Inbox 收件 | `core/inbox.ts`, `facebook-inbound.ts`, `browser-inbox.ts`, `adapters/facebook-browser-inbox.ts` | IMPLEMENTED + **REAL_EVIDENCE(真实目录解析)** |
| ⑦ AI 接待 / 人工接管 | `core/lead-reception.ts`, `reception-worker.ts`, `reception-queue.ts`, `reception-drafts.ts` | ⚠️ 见 `findings.json`（退订规则缺陷） |
| ⑧ WhatsApp 移交 | `core/lead-reception.ts`(referrals), `whatsapp_destinations/referrals` | 投影 SAFE，**并发无测试** |
| ⑨ 客户记录与结果追踪 | `core/contacts.ts`, `customers/*`, `costs.ts` | IMPLEMENTED |

---

## 4. 逐模块清单

### 4.1 `apps/web`

| 文件 | 职责 | 审计要点 |
|---|---|---|
| `app/api/[[...path]]/route.ts` (306 行) | **唯一 API 入口**。三段式：`chat/*`（公开访客，token 授权）→ `agent/*`（执行端，token 授权）→ 其余（**一律先 `requestScope()`**） | ✅ 无绕过路径：任何非 chat/agent 的路径都经过 `requestScope`，不存在"忘了加鉴权"的分支 |
| `lib/auth.ts` (74 行) | `authenticate` / `requestScope` / `login` / `logout` | ✅ 会话 token 以 `digest(token)` 存储（库泄露不可直接复用）；`HttpOnly; SameSite=Strict`；12h；校验 `revoked_at` 与 `NOT u.disabled`；所有写操作 `checkOrigin`；本地登录额外 `localOnly`（host 必须回环） |
| `lib/login-throttle.ts` (94 行) | 登录限流 | ✅ 质量高：**先占位后校验**（在途请求也计数）、窗口内**重读桶**而非复用旧副本、容量上限 + FIFO 淘汰。自述修复了旧版"并发失败被记成 1 次"的缺陷，且有 `tests/unit/login-throttle.test.ts` + `login-throttle-login.test.ts` 覆盖 |
| `lib/visitor-auth.ts` (12 行) | 访客 cookie | — |
| `lib/api-errors.ts` (67 行) | 错误 → HTTP 映射 | ✅ 与 `tests/contracts/api-errors.test.ts` 对应 |

> **P3 观察**：`login-throttle` 是**进程内**限流（`const failures = new LoginThrottle()`）。多进程/多实例部署时每个实例各限各的。文件头部已**明确自述**这一取舍（"deliberately not a distributed limiter"），且 KFF 当前是单实例本机应用 → 记为**已知取舍，非缺陷**。

### 4.2 `packages/core` — 47 个领域模块（按 RLS 出口分类）

| 类别 | 模块 | RLS |
|---|---|---|
| **人驱动（`scoped()`）** | `service`, `templates`, `inbox`, `contacts`, `lead-management`, `lead-reception`, `reception-worker`(部分), `reception-drafts`, `environments`, `collections`(写), `controls`, `costs`, `imports`, `orders`, `payments`, `refunds`, `permits`, `schedules`, `target-snapshots`, `adjudication`, `reconciliation`, `refund-reconciliation`, `capabilities`, `provider-verification`, `collection-export`, `facebook-inbound`(读) | ✅ 生效 |
| **Worker 认领（裸 `transaction()`，跨租户）** | `collections.claimCollection`, `reception-worker.claimReception`, `reception-queue`, `acquisition*`, `execution`(认领/过期), `payment-worker`, `refund-worker`(部分) | ❌ 不生效（**设计如此**） |
| **前作用域解析（裸 `query()`）** | `execution.ts:22`(agent token)、`facebook-inbound.ts:157`(webhook page_id)、`inbox.ts:53`(`channelScope`)、`payments.ts:15` | ❌ 不生效（**设计如此**） |

**关键文件**

| 文件 | 职责 | 审计要点 |
|---|---|---|
| `execution.ts` | 命令认领、`beginSubmission`、`acceptReport`、adjudication、过期回收 | `messageSubmissionGate` 在派发与提交两处各跑一次 |
| `lead-reception.ts` | 接待 → 回复任务 → WhatsApp 移交 | 见 P1 退订缺陷 |
| `facebook-inbound.ts` | 入站事件幂等入库、ECHO 归属匹配 | `pg_advisory_xact_lock` + `payload_hash` 冲突整批回滚 |
| `inbox.ts` | 站点通道 / 访客会话（**公开路径**） | `channelScope` 逐点核查=正当设计 |
| `service.ts` | `audit` / `requireWrite` / `requireAdmin` | 权限判定的唯一来源 |

### 4.3 `packages/adapters` — 34 文件

| 组 | 文件 | 真实度 |
|---|---|---|
| Facebook Inbox 读 | `facebook-browser-inbox.ts`, `facebook-inbox-directory-dom.ts`, `facebook-inbox-dom.ts` | **1 次真实目录解析证据** |
| Facebook 发消息 | `facebook-browser-message.ts`, `facebook-message-result-dom.ts` | **1 次真实自动验证发送**（`remote_id` 已记录） |
| 身份核验 | `facebook-browser-identity.ts`, `browser-profile.ts`(AdsPower) | 真实证据：`actual_account_id` 已核 |
| 采集 | `collection-fixture.ts`, `discovery.ts`, `facebook-search.ts` | fixture 为主 |
| 其他 | Apify、templates | — |

### 4.4 `apps/agent` — 11 文件（**本轮缺陷重心**）

| 文件 | 职责 | 状态 |
|---|---|---|
| `main.ts` (115 行) | 轮询循环、`process.lock`、执行控制 | ⚠️ **L73 在 try/finally 之外** → 拒绝时跳过 flush |
| `guardian.ts` (80 行) | 父进程：spawn 子进程、`before-submit` 握手、**终止证据** | ⚠️ **L59 `error` 分支绕过全部终止证据逻辑**（P1） |
| `guardian-child.ts` | 子进程：驱动浏览器、执行 capability | ✅ |
| `action-journal.ts` (71 行) | journal 可达性门与 `flushActionJournal` | ✅ L42 无 closure 即 false（正确） |
| `guardian-protocol.ts` (91 行) | closure 读写与压缩 | ⚠️ `closureProof` 无条件改写协议；`compactClosure` 硬编码 `context_closed:true`（P2） |
| `environment-child.ts` | 环境操作子进程（含 locale 校验） | ✅ |

### 4.5 `apps/worker`

`main.ts` 单文件，串起 9 个轮询循环（采集、接待、支付、退款、对账、采集续跑等）。**跨租户认领，故用裸 `transaction()`。**

---

## 5. 模块间调用铁律（实测）

1. **`apps/*` 不直接写 SQL**（唯一例外：`apps/web/lib/auth.ts` 的 3 处前作用域查询）。实测 `grep "from '@kff/database'" apps/` 仅命中 2 个文件：`auth.ts`(query) 与 `worker/main.ts`(closePool)。
2. **租户数据必须先有 `Scope`**，`Scope` 只能来自 `requestScope()`（HTTP）或 worker 认领记录。
3. **HTTP 入口无第二条**：没有散落的 route handler，不存在漏鉴权的路由。
4. **所有跨端类型来自 `packages/contracts`**，容器/迁移无重复定义。

---

## 6. 模块风险热力

| 模块 | 风险 | 依据 |
|---|---|---|
| `apps/agent/guardian.ts` | 🔴 **高** | P1：`error` 分支绕过终止证据 → 永久阻塞（已复现） |
| `core/lead-reception.ts` 退订规则 | 🔴 **高** | P1：规则函数判定缺陷（已复现 9/40 不符） |
| `agent/guardian-protocol.ts` | 🟠 中 | P2：压缩抹掉 startup-failed 区别 |
| `adapters/facebook-*-dom.ts` | 🟠 中 | 结构性选择器；**失败方向是 fail-closed**（拒不猜），不会误发 |
| `core/payments.ts` | 🟡 低 | 冻结模块，`LIVE_DISABLED` 默认关，但 worker 会自动发起 Stripe 调用（人工闸在入队时刻） |
| `packages/database/src/index.ts` | 🟡 低 | 三出口边界无自动检查（见 `migration-audit.md` 4.2） |
