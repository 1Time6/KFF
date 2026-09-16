# KFF「界面能选、服务端必拒」审计清单

审计日期：2026-09-16
分支 / 提交：`codex/facebook-foundation` @ `2da983e`（工作区含大量未提交改动）
回退点记录：`.kff/checks/audit-checkpoint-20260916-162510.txt`

## 审计方式（可复查）

4 个并行审计员按域通读源码，把每个 `<select>` / 表单控件的选项来源
与它提交到的 POST 路由、以及服务端对应的 `requireCondition` / zod 约束逐条对照。
本人对**关键发现用真实 API 与数据库独立复现**，未只依赖阅读。

覆盖范围：`apps/web/components/*.tsx`（25 个组件、78 个 select）、
`packages/core/src/*.ts`、`packages/contracts/src/*.ts`、
`apps/web/app/api/[[...path]]/route.ts`。

## 结论摘要

| 项目 | 数量 |
| --- | --- |
| 发现总数 | 64 |
| 本轮修复 | 8 |
| 记录待修 | 56 |
| 经复核判定「不是问题」 | 约 70 项（各报告 CHECKED 段） |

判定为"不是问题"的例子（避免误报）：
- 获客页 Agent 下拉不含已撤销 Agent（接口只返回 `{id,name}`，无 status 字段）；
- `operating_identity_id` 校验不可能被触发（配置时已强制相等）；
- 出站暂停、退款、裁定、导入导出等大批字段边界与契约一致。

---

## 一、本轮已修复（8 项，均通过 typecheck）

### 1. 「创建独立环境」的执行 Agent 下拉列出已撤销 Agent 【Critical】
- 位置：`apps/web/components/workbench.tsx`（创建环境弹窗）、`packages/core/src/service.ts:63`
- 现症：界面渲染全部 45 个 Agent，服务端只接受 `status<>'REVOKED'` → **38 个选项必然 403**
- 已改：下拉过滤 `status !== 'REVOKED'`，标注非在线状态，全不可用时给出提示
- 复现证据：`scripts/diagnose-create-environment.mjs`（在线 Agent → 201；已撤销 Agent → 403）

### 2. 环境创建报错文案张冠李戴 【High】
- 位置：`packages/core/src/service.ts:64`
- 现症：账号不存在 / Agent 已撤销两种完全不同的原因，统一报「账号或 Agent 不在当前品牌内」
- 已改：拆成「所选账号不存在或不属于当前品牌」与「所选 Agent 已撤销或不属于当前品牌，请改选可用 Agent」

### 3. 任务创建表单初始化与选项过滤条件不一致 【Critical】
- 位置：`apps/web/components/workbench.tsx`（自动选中逻辑 vs 下拉渲染）
- 现症：自动选中找 `.publish.` 能力，而选项过滤只排除 `.discovery.`/`.inbox.` → 打开弹窗时「执行动作」停在空值且该选项 `disabled`，看起来"没得选"
- 已改：抽出唯一的 `taskCapabilities()`，两处共用

### 4. 「执行动作」列出 7 个本弹窗永远提交不了的能力 【Critical】
- 位置：`apps/web/components/workbench.tsx`
- 现症：`facebook.comment.reply.browser`、`facebook.messenger.reply.browser`、`*.messenger.reply.api`、`*.social.reply.api` 等需要来源/会话快照，而本弹窗不收集这些上下文 → 每次提交 409 `TEMPLATE_INPUT_INVALID`
- 已改：改为白名单（`facebook.page.read.api`、`facebook.page.publish.api`、`instagram.account.read.api`、两个 fixture 页能力），从根上杜绝"选得到但提交不了"

### 5. 真实浏览器只读任务的试验许可永远无法保存 【Critical】
- 位置：`apps/web/components/pilot-permit-form.tsx` vs `packages/core/src/permits.ts`
- 现症：服务端对收件/采集只读任务要求 `expected_evidence` 为 `inbox_page` / `collection_page`，界面只会算出 `page_identity` → **每次 400「预期证据与动作不匹配」**
- 已改：逐字镜像服务端优先级（inbox → collection → message/outreach → publish → page）
- 影响：这条正好挡住"真实账号 → 环境核验 → 只读试验"这条主路径

### 6. 采集结果导出对每一类主动采集查询都 100% 失败 【Critical】
- 位置：`apps/web/components/collection-export.tsx` vs `packages/core/src/collection-export.ts:18`
- 现症：服务端对 `SOCIAL_DISCOVERY` 的允许导出清单是空数组，界面却按 `OWNED_FIXTURE` 处理并勾选字段 → 每次 403 `EXPORT_FIELD_FORBIDDEN`
- 已改：导出允许清单算法抽成共享函数 `exportableFields()` 并原样镜像服务端；无允许字段时不再渲染表单，改为说明原因

### 7. 获客「准备一次动作」表单对必被拒绝的线索仍然渲染 【High】
- 位置：`apps/web/components/acquisition-workbench.tsx` vs `packages/core/src/acquisition.ts:172-173`
- 现症：界面条件是 `provider!=='LOCAL_BROWSER'`，服务端要求"评论区策略 且（浏览器评论模板 或 LOCAL_FIXTURE/META_API）" → DATA_PROVIDER 线索每次 409
- 已改：镜像服务端判定 `canPrepareOutreach`；不满足时改为显示原因说明

### 8. 「为此监控配置自动执行」对调度器永不选中的监控仍可保存 【High】
- 位置：同文件 vs `packages/core/src/acquisition.ts:245`
- 现症：调度器只处理 `strategy='COMMENTS'` 且 provider ∈ {LOCAL_FIXTURE, META_API}，界面只判断 provider → 保存成功但自动执行永不触发（成功提示是假的）
- 已改：镜像调度器判定 `canAutomate`，不满足时说明原因

### 附：修复过程中我自己引入并已修正的缺陷
- 曾把获客页 Agent 下拉改成读 `a.status`，但该接口只返回 `{id,name}` → typecheck 捕获，已回退；
- 曾加 `readinessOf(capability)` 查 `data.eligibility`，而该映射键是**任务 ID**不是能力 ID → 永远为空，已改为按 `evidence_state` 判断；
- 一次空行编辑意外把两行合并，已修回。

---

## 二、记录待修（按优先级，未在本轮改动）

### Critical
1. **导出按钮（固定快照）** — `collection-targets.tsx` 复用同一处错误的允许清单逻辑，同样需要改用 `exportableFields()`。
2. **「绑定账号」可选 `platform='site'` 账号** — `workbench.tsx` 创建环境弹窗无平台过滤；建出来的环境做「检查浏览器」时抛英文 zod 400 `Invalid option: expected one of "facebook"|"instagram"|"kff"`（`packages/core/src/environments.ts:70`）。建议界面过滤 + 服务端 `createEnvironment` 同时加守卫。
3. **新建账号停在 `DRAFT` 状态无处激活** — `service.ts:52` 不写 `state`，数据库默认 `DRAFT`；全库唯一的 `DRAFT→ACTIVE` 写入在 `execution.ts:203`（真实非写动作成功后）。而模板预演要求 `state==='ACTIVE'`、联系资格要求 `ACTIVE`、执行在领取时才以 `AUTH_EXPIRED` 拒绝。**真实新账号会卡住**，建议补显式激活路径，并把 `account.state` 纳入入队资格判定。

### High
4. **环境操作未考虑 Agent 状态** — `environment-workbench.tsx` 未使用已返回的 `agent_status`，对已撤销/排空 Agent 的环境仍提供「检查浏览器」「打开登录窗口」，服务端 409 `AGENT_UNAVAILABLE`；且**没有任何改绑 Agent 的入口**，环境会被永久卡死。
5. **Facebook 接待配置：所选环境驱动不匹配** — `facebook-setup.tsx` 的 BROWSER 选项基于"账号下某个环境是 native"，服务端校验的是**所选**环境 → 混合驱动时必 409，且报错文案说成"需要 AdsPower 个人账号"（对合成账号是错的）。
6. **Facebook 接待配置：环境下拉可为空** — 与已修的 3 号同类的死胡同表单（账号无环境时零选项、保存按钮仍可用）。
7. **登记联系目标对 site / Instagram 账号必 403** — `contact-permissions.tsx:38` 仅按 `is_synthetic` 推导 channel，忽略 `platform`；site 账号永远发 `facebook_messenger`。
8. **「准备来源核对」对空正文评论仍可用** — 服务端要求 `body.trim()` 非空与父级 URL 可解析（`provider-verification.ts:18,25`），界面不检查，报错还让你去做已经做过的事。

### Medium
9. 计划 `RESUME` 在 `pause_reason` 存在时必 409（暂停原因与恢复被拒原因是同一个条件）。
10. 订单/计划预览 15 分钟过期后确认按钮仍可用（客户端无计时）。
11. 费用核对下拉列出在途动作（服务端要求非在途且执行上下文已关闭）。
12. 费用决策下拉在服务端状态变化后可能提交已不在选项里的值。
13. 收件箱「恢复自动接待」在账号级自动接待关闭时仍可设置 → 界面显示自动接待，队列永不派发。
14. LIVE Stripe 连接在 `KFF_ENABLE_LIVE` 未开启时仍出现在收款下拉里。
15. 导入字段映射允许多种必 400 的组合（状态列未配数据列、重复列）。
16. 必填 checkbox 组可全部取消 → 返回英文 zod `Too small: expected array to have >=1 items`。
17. 批量未翻译 zod 文案（`Invalid UUID`、`Too big…`）直达中文界面（`route.ts:291` 只取 `issues[0].message`，不含字段路径）。
18. 能力列表把非合成能力一律标成「Graph API」，包含真实浏览器能力（应为「真实浏览器」）。
19. 模板「允许此版本」未使用已展示的 `can_enable` 守卫。
20. 账号下拉混排 85 个合成测试账号且无标注，选择会静默切换执行模式（TEST_ONLY ↔ CONTROLLED_PILOT）。

### Low
21. 模板步骤表缺 `read_page` → 只读模板显示空白步骤。
22. 模板副标题把一切非 publish 能力标成「身份读取」，包括回复类。
23. 「登记联系目标」恢复联系需要另一个不相关勾选项同时成立。
24. 收件箱合成/真实会话在列表中无标注。
25. 采集「用途」选项可排除全部对象并保存空快照。
26. 周计划不选星期必 400。
27. 订单会话 ID 为自由文本但必须是 UUID。
28. 同一商品可选两行（服务端禁止）。
29. 裁定「新回复完整链接」必须与服务端拼接结果逐字节相同。
30. 唯一约束冲突统一报「记录已存在，请刷新后查看」，不说是 SKU 重复。

---

## 三、生效与交付（已完成）

### 3.1 生效步骤（已执行）

改的是源码，运行时加载的是生产构建，因此按顺序执行了：

1. `node scripts/run-check.mjs build` → exit 0，覆盖 372 个源文件，无漂移
2. `node --import tsx scripts/local-runtime.ts configure --agent-release <当前 Agent 目录> --discovery --inbox`
   → 新构建指纹 `XHTYbVtJ1sn9-4UOY3gaR`，`live_sending_enabled: false`
3. 停止 → 启动运行时 → 四组件 RUNNING（database CONNECTED / web / worker / agent）

**实证修复已生效**：重建前后调用同一诊断脚本，错误文案由
「账号或 Agent 不在当前品牌内」变为
「所选 Agent 已撤销或不属于当前品牌，请改选可用 Agent」。

### 3.2 过程中遇到的两个真实问题（如实记录）

1. **启动器在代理变量大小写重复时无法启动**：本会话环境同时存在 `NO_PROXY`/`no_proxy`、
   `HTTPS_PROXY`/`https_proxy`，PowerShell 5.1 的 `Start-Process` 参数字典大小写不敏感，
   抛 `Item has already been added`。属于环境问题，解法是在启动前清除小写重复项。
2. **首次启动因数据库恢复超时被判 START_FAILED，且宿主保留运行**：
   此前一次启动被外部超时中断，导致数据库非正常关闭；重启触发自动恢复，
   前 70 秒用于 fsync，超过启动器确认期限 → `START_FAILED`。
   此时启动器按设计拒绝重复启动（`state.json` 残留该状态），
   正确处置是向保留的宿主发送其自身的 `stop`（`local-runtime.ts:170` 在失败时设 `started=true`，
   宿主会继续接受控制），等其干净退出、状态变为 `STOPPED` 后再启动。
   **数据库未受损**：日志末尾为 `database system is ready to accept connections`，
   恢复后账号 88 / 环境 55 / Agent 45 与重启前一致。

### 3.3 交付产物（已更新）

| 产物 | 值 |
| --- | --- |
| 控制端包 | `kff-controller-0.1.53-win32-x64-e3d87581551d.zip` |
| SHA-256 | `7ad2436a82785c8f79d2972f03ad947128084aa17e1f67cbee11e6b81ff05949` |
| 文件数 / 大小 | 24,115 个文件，253,383,435 字节 |
| 校验 | 实际哈希与随包 `.sha256`、PDF 教程、说明文本四处一致 |
| 交付目录 | `C:\Users\17731\Desktop\KFF-交付-0.1.53`（包 + sha256 + PDF 教程 + 说明文本） |

该包已包含本轮全部 8 项修复；上一版 `2c82a35912bf` 不含这些修复。

## 四、质量验证结论

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过（改动前后各一次） |
| ESLint（5 个改动文件） | 通过 |
| 单元 + 合同测试 | **234 项全部通过**（36 个文件） |
| 生产构建 | 通过（372 个源文件覆盖） |
| 运行时启动 | 四组件 RUNNING |
| API 实证 | 新错误文案生效 |
| 数据完整性 | 账号 88 / 环境 55 / Agent 45，与重启前一致；诊断行 0 残留 |

## 四、审计产物（可复查）

| 脚本 | 用途 |
| --- | --- |
| `scripts/diagnose-create-environment.mjs` | 复现环境创建的 403，并在结束后清理自己创建的诊断行 |
| `scripts/inspect-brand-binding.mjs` | 账号/Agent/环境的品牌归属（结论：0 个孤儿） |
| `scripts/inspect-template-coverage.mjs` | 能力与模板覆盖（发现任务表单只能建 5 类能力） |
| `scripts/verify-acquisition-audit.mjs` | 核实获客审计前提（credential_ref 全为 NULL 等） |
| `scripts/probe-frozen-endpoints.mjs` | 空载荷探测接口是否被策略封死（结论：订单/产品可用） |
| `scripts/verify-no-junk.mjs` | 确认审计未留下垃圾数据（账号仍 88、环境 55） |
| `scripts/extract-selects.mjs` | 提取全部下拉框的选项来源与过滤情况 |
