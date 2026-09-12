# KFF Facebook → WhatsApp 引流进度

更新：2026-09-12。依据本轮目标文件和当前工作树；起始分支 `codex/facebook-foundation`，工作树干净。旧汇报只作索引，不作为完成证据。

## 当前业务范围与完成口径

第一阶段只做 Facebook 互动/私信 → 客户与收件 → 意图识别与基础接待 → 人工接管 → WhatsApp 引流与结果记录。交易、报价、付款、交付由现有销售团队在 WhatsApp 完成。现有商品、订单、支付、退款代码冻结保留，不作为此闭环的前置条件。

`COMPLETE` 只表示所述本地范围具有代码、迁移、API、操作入口、正常与异常链、权限隔离、测试和运行证据。`PARTIAL` 为已有基础但缺完整链；`MISSING` 为无实现；`TEST_ONLY` 为仅合成能力；`BLOCKED_REAL_PLATFORM` 为真实账号/权限/凭据和平台联调待验。真实 Facebook 不得因为合同测试通过而晋升。引流成功表示指定 WhatsApp 邀请消息已确认提交，实际加好友/成交需人工独立确认，不据链接推断。

## 本轮重新审计（基线）

本表为实施前基线，最终状态请看文末“当前 40 项结论”。

完整检查入口：`packages/contracts/src`、`packages/core/src`、`packages/adapters/src`、全部 Migration、Web API/组件、Worker/Agent/guardian、测试和运行脚本。下表状态描述 Facebook 引流链，不把已有站内功能当作 Facebook 已完成。

| # | 模块 / 目标 | 基线状态 | 现有代码位置 | 缺口 / 下一步 | 本轮测试 / 真实平台 |
|---|---|---|---|---|---|
|1|Facebook 接入|BLOCKED_REAL_PLATFORM|adapters/facebook.ts; service.ts|只有 Page 读/发帖；补验签、私信与互动事件合同|现有合同；真实待验|
|2|Facebook 多账号|PARTIAL|service.ts; accounts/environments|核对消息/引流整链账号绑定|基础隔离通过；真实待验|
|3|Facebook 客户采集|MISSING|inbox.ts; collections.ts|连接事件到现有 Customer/Identity|未覆盖 FB；真实待验|
|4|Facebook 私信采集|MISSING|adapters/facebook.ts|Webhook → Event → Message|缺测试；真实待验|
|5|评论互动潜客|TEST_ONLY|collections.ts; collection-fixture.ts|评论事件落客户和来源，未知身份不伪造|合成分页通过；真实待验|
|6|客户去重|PARTIAL|inbox.ts; customer_identities|沿用账号+渠道+远端身份去重到 FB|站内并发通过|
|7|来源归因|MISSING|inbox.ts|当前统一 UNKNOWN；保存 Page/来源/首末互动|缺测试|
|8|客户档案|PARTIAL|inbox.ts; customer-workbench.tsx|加入引流生命周期、归因与处理人|站内档案通过|
|9|客户标签|MISSING|customers|结构化标签与权限入口|缺测试|
|10|客户意向等级|MISSING|customers|意图/等级/判断依据|缺测试|
|11|统一收件箱|PARTIAL|inbox.ts; inbox-workbench.tsx|目前只显示站内入站消息|站内集成通过|
|12|AI 意图识别|MISSING|无|可替换模型合同、失败转人工|缺测试|
|13|AI 自动回复|MISSING|无|受约束决策 → 现有执行核心|缺测试|
|14|自动接待流程|MISSING|无|回复/追问/引流/接管/停止|缺测试|
|15|人工接管|MISSING|inbox-workbench.tsx|原子接管与人工发送|缺测试|
|16|AI/人工切换|MISSING|conversations|处理模式和单调版本，旧任务失效|缺测试|
|17|WhatsApp 引流|MISSING|无|默认/账号目的地，消息级证据|缺测试|
|18|WhatsApp 引流状态|MISSING|customers|记录邀请与人工确认结果|缺测试|
|19|引流话术管理|MISSING|templates.ts 为执行模板|扩展业务话术配置，冻结发送快照|缺测试|
|20|自动化规则|PARTIAL|schedules.ts|日历准备未接入接待决策|计划测试通过|
|21|Agent 执行|PARTIAL|apps/agent; execution.ts|扩展消息 Adapter，复用 guardian|执行集成通过；真机待验|
|22|多 Agent 管理|PARTIAL|controls.ts; executor-controls.tsx|整链多 Agent 与中断复验|已有配对/单槽/停止测试|
|23|账号 Agent 绑定|PARTIAL|environments; service.ts|接待规则绑定同账号环境|基础复合外键；待整链测试|
|24|任务队列|PARTIAL|jobs; execution.ts|沿用队列承载接待准备与发送|原子投递/进程中断通过|
|25|重试机制|PARTIAL|execution.ts; reconciliation.ts|接待有限重试；发送未知不得盲重发|现有未知隔离通过|
|26|幂等|PARTIAL|inbound_events; tasks|增加 FB Event/Message/Referral 键|既有入站/入队测试通过|
|27|防重复发送|PARTIAL|execution.ts; guardian|会话版本与发送冲突门槛|现有单动作门槛通过|
|28|失败恢复|PARTIAL|execution.ts; reconciliation.ts|接待重试与原消息核验回写业务结果|既有失联/恢复测试通过|
|29|暂停恢复|PARTIAL|controls.ts|接待/引流配置停用和旧任务|既有开关测试通过|
|30|风控限制|PARTIAL|contacts.ts; permits.ts|收件限额、服务窗口、回复限额和冷却|依据/许可测试通过|
|31|账号级停止|PARTIAL|controls.ts; execution.ts|补接待全链最终门槛|基础停止测试通过|
|32|Agent 级停止|PARTIAL|controls.ts; execution.ts|补消息 Agent 场景|排空/撤销测试通过|
|33|组织级停止|PARTIAL|controls.ts; execution.ts|补接待全链最终门槛|组织角色/停止测试通过|
|34|引流统计|MISSING|无|客户、消息、接待、有效咨询、引流漏斗|缺测试|
|35|账号统计|MISSING|无|聚合保留 account_id|缺测试|
|36|来源统计|MISSING|无|聚合首次来源与引流来源|缺测试|
|37|AI 回复效果|MISSING|无|按决策/回复/后续咨询分别统计|缺测试|
|38|引流转化率|MISSING|无|已引流有效客户/有效咨询客户，空分母空值|缺测试|
|39|操作日志|PARTIAL|audit_events; customer_events|接待/引流操作日志入口|现有审计写入通过|
|40|审计日志|PARTIAL|service.ts; RLS|补新模块不可变记录和隔离测试|既有权限/记录测试通过|

## 优先级与分批验收

1. P0-A：Facebook 规范化事件、验签、账号接待配置、客户去重/归因、统一消息模型。迁移原因：现有 `messages` 只允许 INBOUND，`conversations.channel_id` 必须为站内入口，无法容纳 Facebook 或人工发信；扩展原表而非复制 CRM。
2. P0-B：会话控制权、人工发送、WhatsApp 目的地/证据，使用现有 Task/Action/Job/Agent/Lease/guardian。人工接管单调增加版本；提交门槛复查旧版本和已在途动作。
3. P0-C：受约束 AI 意图与接待任务、失败恢复、重复防护、暂停和账号隔离。模型不可直接执行工具或写数据库。
4. P1：标签/等级/跟进、账号/品牌话术、统计漏斗与日志，并做真实浏览器整链与故障回归。
5. P2：高级报表/批量/体验后置；支付/订单/交付冻结。

## 运行证据

- 本轮基线重新执行 `node --import tsx scripts/integration.ts`：14 文件、205 项集成测试通过；使用新建随机隔离 PostgreSQL 数据库，成功后清理。开发服务 `/api/health` 返回 200。
- 原 17 个迁移已逐个在新库应用；旧 308 项汇报未用于推定当前主链完成。
- 上述为实现前基线；后续各批与最终结论记录在下方，始终保留真实平台阻塞标记。

### P0-A 第一批实现与复验

新增 `facebook-events.ts`、`facebook-inbound.ts`、`contracts/lead.ts` 及第 18 个迁移。扩展原 Customer/Identity/Conversation/Message/Event，增加 Page 绑定、首次来源、首末互动时间、事件种类和处理模式。Webhook 先对原始字节验签，再按服务端唯一 Page 绑定解析品牌；合成注入只能访问本品牌合成账号。评论和互动单独保存，身份缺失不伪造，评论不自动获得 Messenger 发信依据。Facebook 原生人工回声和附件转人工。

验证：5 项事件合同测试通过；11 项新 Facebook 入站 + 17 项原站内收件集成测试通过（28/28），包括真进程在事务前/后被终止、12 路并发去重、跨账号/品牌、非法角色、乱序、空与部分事件、配置版本与窗口。新迁移已在隔离数据库和本地开发库应用。真实 Facebook 仍 `BLOCKED_REAL_PLATFORM`。

当前变化：模块 3/4/7 由 MISSING 进入 PARTIAL，5 由 TEST_ONLY 进入 PARTIAL；2/6/8/11 已有新的整链数据证据。浏览器全流程、自动化和出站尚在后续批次，暂不标 COMPLETE。

### P0-B 发送、接管与引流基础

第 19 个迁移扩展原任务/消息，增加 WhatsApp 目的地与引流记录，并为原组织/品牌/账号/Agent 停止控制增加单调 epoch。`lead-reception.ts` 使用原 `enqueueTaskInTransaction`、dispatch、submission gate、Agent/guardian、报告和核验机制。确认回执后才原子写出站消息及引流结果；原生发送 API 的确认不等于客户已读或已添加 WhatsApp。账号覆盖暂停时不自动使用默认号码。

新增 19 项接待集成测试全部通过，包含实际本地 HTTP 发送、并发人工回复、已领取 AI 任务接管、已提交在途保护、四级暂停恢复旧任务、双 Worker/Agent、错误收件人回执、WhatsApp 冷却与配置变更、未知结果核验、实际调用进程在提交前后终止。另回归 52 项执行/模板/入站集成和 73 项合同/单元测试通过；类型检查通过。

模块 15/16/17/18/19 从 MISSING 进入 PARTIAL，出站、人工接管与消息级引流证据在集成环境串通。AI 自动接待、UI 全链与统计尚待下一批；不提前标记 COMPLETE。第 19 个迁移已在开发库应用。

### P0-C 自动接待与 P1 运营入口

新增受约束的模型合同、明确标注的本地规则预演、可配置的 OpenAI 兼容模型接口。模型只输出意图与建议，不能选择账号、客户、号码或直接执行动作。已有 `jobs` 增加 RECEPTION 类型，具备持久租约与 fencing token；控制权、最新消息、配置版本、停止 epoch 变化时丢弃旧判断。准备失败最多三次后转人工，发送未知保留原动作核验。明确退出在收件事务内生效，不等待模型。第 20/21 个迁移扩展原队列、保护来源与控制版本、核验准备任务范围并增加索引，均已在开发库应用。

16 项自动接待集成、6 项客户/统计/限额集成、模型及 Messenger 合同已通过。完整集成回归曾达到 18 文件 257 项全部通过（之后增加的收件退出与浏览器修复仍要以最终复验为准）。自动接待租约超时、真实 Worker 进程提交前后死亡、重复竞争、模型缺配置、连续超时、跨账号历史/号码和四级停止均有证据。

前端已接入 Facebook 配置、本地模拟、接待规则、品牌默认/账号专用 WhatsApp、人工接管与回复、结果核验入口、客户标签与意向、人工销售确认、按日期/账号/来源的统计和日志。浏览器已经完成自动邀请发送及客户状态持久化；首轮发现统计页选择器和 Agent 测试清理路由错误，正在修正并复验，尚未把整批标为完成。

### 当前 40 项结论

以下 `COMPLETE` 限定为第一阶段的**本地可运行范围**，含异常、权限和真实本地进程验证；不表示整个原始规划或任何真实平台验收完成。Facebook 传输来源仍按 `TEST_ONLY` 保守记录，真实连接统一 `BLOCKED_REAL_PLATFORM`。远端模型合同和安全控制已实现，真实模型质量未验。

| # | 模块 | 当前状态 | 实现及证据位置 | 尚未覆盖 |
|---|---|---|---|---|
|1|Facebook 接入|BLOCKED_REAL_PLATFORM|`facebook-events.ts`、`facebook-inbound.ts`；验签和 Page 路由合同|真实 App/Page 权限、订阅、平台回调联调与放行|
|2|多账号|COMPLETE|`facebook_connections`、账号/环境复合外键；入站/接待/双 Agent 集成|真实多账号联调|
|3|Facebook 客户采集|TEST_ONLY|原 Customer/Identity 建档；入站崩溃/并发测试，浏览器建档|真实来源验收|
|4|Facebook 私信采集|TEST_ONLY|验签规范化 → 原 Event/Message；去重、乱序、部分事件测试|真实订阅与数据覆盖|
|5|评论、互动来源|TEST_ONLY|feed comment/reaction 规范化，来源与潜客保存；独立身份|真实 feed 事件与完整性；不做未知身份推断|
|6|客户去重|COMPLETE|账号+渠道+remote_id；并发锁和唯一约束|跨渠道身份合并不凭姓名推断|
|7|来源归因|COMPLETE|首次观察来源、Page、source/ref/ad、首末互动；UI 与按来源统计|平台缺字段保留未知|
|8|客户档案|COMPLETE|`inbox.ts`、`customer-workbench.tsx`；来源/身份/会话/负责人/跟进|非核心 CRM 扩展后置|
|9|客户标签|COMPLETE|`lead-management.ts`、`lead-customer.tsx`；去重、版本、审计、刷新测试|高级标签自动化后置|
|10|意向等级|COMPLETE|意图等级/理由/有效咨询，人工修订使旧判断失效|真实模型识别质量另验|
|11|统一收件箱|COMPLETE|原收件箱扩展 Facebook 入站/自动/人工/原生回声；UI 和手机验证|站内入口仍只收件，未扩展站内出站|
|12|AI 意图识别|TEST_ONLY|本地规则及 OpenAI 兼容结构化模型；无凭据/超时/无效输出测试|真实模型配置、语言和质量验收|
|13|自动回复执行|COMPLETE|受约束建议 → 原 Task/Action/Agent → 确认消息；HTTP 和浏览器|真实模型/Meta 组合验收|
|14|接待流程|COMPLETE|问候、追问、有效咨询、引流、人工、停止；`reception-worker.ts`|更复杂规则后置|
|15|人工接管|COMPLETE|原子接管+回复；已领取旧 AI 失效，提交后在途保护|不能撤回已经授予提交的远端动作|
|16|AI/人工切换|COMPLETE|AI/HUMAN/PAUSED + control_version；最新消息/配置/停止 fencing|已回答消息不会凭切换重发|
|17|WhatsApp 引流|COMPLETE|品牌默认/账号专用目的地，冻结号码与话术，Agent 消息证据|无 WhatsApp API；真实添加独立人工确认|
|18|引流状态|COMPLETE|QUEUED/UNKNOWN/FAILED/CANCELED/REFERRED/CONFIRMED/DECLINED；Lead 全生命周期|不推断已读、好友或成交|
|19|话术管理|COMPLETE|账号接待话术、品牌/账号引流话术，版本与快照|高级编辑、批量模板后置|
|20|自动化规则|COMPLETE|关键词、轮次、置信度、上限、间隔、成功后停止；规则 UI|高级运营自动化 P2|
|21|Agent 执行|COMPLETE|既有 guardian/日志/单槽与 Messenger Adapter，实际本地 HTTP|真实平台受能力/许可约束|
|22|多 Agent|COMPLETE|按 Agent ID 独立日志/锁，原配对/停止 UI；真实第二进程发送|远程设备部署不在本轮|
|23|账号 Agent 绑定|COMPLETE|Connection 必须关联本账号环境；命令按指定 Agent 领取|真实设备验收后置|
|24|任务队列|COMPLETE|原 jobs 承载 EXECUTION/RECEPTION，租约与 token；进程死亡测试|未引入第二套队列|
|25|重试|COMPLETE|准备失败三次转人工、显式恢复，速率等待不计模型失败|未知发送不自动重试|
|26|幂等|COMPLETE|事件/身份/准备键/任务请求/结果唯一；提交前后实际进程终止|同一事件不同内容拒绝覆盖|
|27|防重复发送|COMPLETE|会话版本、原动作、提交门槛、资源租约；丢响应浏览器重试只发一次|平台不支持幂等时用未知隔离，不能保证网络撤回|
|28|失败恢复|COMPLETE|准备租约接手，原提交核验/人工裁定回写 Message/Referral|最终裁定需要原 guardian 关闭证明|
|29|暂停恢复|COMPLETE|接待/目的地/会话及原全局开关；停止 epoch 不复活旧动作|恢复只为当前未回答消息新建准备|
|30|限制与风控|COMPLETE|验签、字节/事件/账号限额、服务窗口、单客户/每日/间隔/冷却、退订即时生效|真实平台政策与权限仍需联调|
|31|账号停止|COMPLETE|原账号开关 + epoch，派发与最终提交复查|在途只核验|
|32|Agent 停止|COMPLETE|排空/撤销/隔离，单槽，消息绑定与暂停恢复回归|在途只核验|
|33|组织停止|COMPLETE|组织角色、品牌/组织 gate + epoch，准备和执行均检查|跨设备真实部署后置|
|34|引流统计|COMPLETE|新客户、私信、回复、人工接管、有效/高意向、邀请/实际联系|不混入站内或支付收入|
|35|账号统计|COMPLETE|账号维度和账号筛选；SQL 与浏览器验证|高级报表 P2|
|36|来源统计|COMPLETE|首次来源维度、此次引流来源、UTC 日期，未知保留|不补造广告或来源 ID|
|37|回复效果观察|COMPLETE|自动/人工确认回复、客户、有效咨询、后续来信、模型建议和话术结果|相关观察不宣称因果或成交|
|38|引流转化率|COMPLETE|本期有效新客中已有确认邀请的人数去重/有效新客；空分母 null|当前人工标记变化有审计，不做历史快照报表|
|39|操作日志|COMPLETE|收件、判断、接管、配置、客户更新、邀请/人工结果；日志 UI|展示最近 200 条，导出增强 P2|
|40|审计日志|COMPLETE|原不可变 audit/customer events、RLS、角色、复合范围约束；新流程测试|生产留存/外部归档另验|

### 最终验收记录

最终检查于 2026-09-12 12:49–12:54（Asia/Shanghai）完成。采用 `scripts/run-check.mjs`，九类检查均退出 0，绑定同一批 214 个源码/配置文件，检查期间与验收落盘时均无源码漂移。带命令、时间、源码哈希、数据库迁移和运行状态的结果已写入 [验收记录](evidence/lead-generation-checkpoint.json)。

| 检查 | 结果 |
|---|---|
| TypeScript / ESLint | 通过 |
| 单元 / 合同 | 26 / 70 项通过 |
| 集成 | 18 文件、262 项通过；新建隔离 PostgreSQL 数据库应用全部 21 个迁移 |
| 执行器浏览器 / 工作台浏览器 | 15 / 23 项通过，零失败、跳过或不稳定重试 |
| Next.js 生产构建 / 生产 API 冒烟 | 通过；生产入口验证入站去重、实际本地 Agent 邀请、准确号码和范围内统计 |
| 原规划完整性 / Git 差异检查 | 通过；原 134 项任务、72 项验收记录保持原范围 |

总计 **396 项测试全部通过**。验收运行快照：开发健康接口正常，主 Agent 在线；155 个作业全部 DONE，动作均已终态，无遗留待发送、执行中或 UNKNOWN。历史失败场景的 BLOCKED/CANCELED 动作保留作为证据。21 个开发库迁移与源码哈希一致；新增功能截图保留，回归产生的旧截图已恢复。

已取得的浏览器证据：`output/playwright/facebook-whatsapp-conversation.png`、`facebook-reception-mobile.png`、`facebook-lead-analytics.png`。覆盖真实本地 Web → 数据库 → Worker → Agent → 本地 HTTP → 消息/邀请投影，并包含第二个实际 Agent 进程、响应丢失后按原请求重试、刷新持久化和手机布局。模拟客户、号码与邀请均为本地测试数据，无真实 Meta、WhatsApp 或远端模型调用。

末轮复查另补两项恢复边界：原生人工回复保留在后续模型上下文，已回答的旧消息不因恢复自动模式再发；补准备扫描在 LIMIT 之前排除已有相同快照的作业，旧积压不会饿死暂停期间收到的新会话。均有独立集成复现并通过。

P0/P1 的本地实施已形成闭环；P2 和外部平台验收保持上述明确范围。旧订单/支付/退款源码冻结，原 134 项任务规划与历史证据没有被改写成全部完成。
