# 浏览器消息与统一 Inbox

浏览器收件通过原 Worker → tasks/jobs → Agent → guardian → 页面回执事务，进入现有 `inbound_events`、`customers`、`customer_identities`、`contact_targets`、`conversations` 和 `messages`。`fixture-inbox-dom-v1` 读取本项目编写的本机合成 DOM；`facebook-inbox-dom-v1` 支持指定 AdsPower 个人账号的一个已接受加密会话，范围见 [真实会话收件](real-browser-inbox.md)。真实回复仍待实施及平台验收。没有新增客户库或独立执行队列。

历史入库层验证见 [入库层检查点](../evidence/browser-inbox-ingress.json)，收件任务链路见 [收件轮询检查点](../evidence/browser-inbox-polling.json)，当前浏览器回复和销售确认验证见 [回复检查点](../evidence/browser-message-runtime.json)。

`receiveBrowserInboxBatchInTransaction` 由验证过命令与租约的Agent回执事务调用，没有新增公开收件HTTP接口，也没有放开真实账号的合成注入。调用方必须先验证命令和资源租约；入库层再核对品牌、账号版本、环境配置版本、Agent、Profile、可见登录身份和操作身份。它可与原回执、检查点写入共同提交，任何一个事件冲突导致整批回滚。

`kff.browser-inbox-batch.v1` 每批最多50条可见消息，要求明确的消息标识、会话标识、对方标识、方向、文本及对应会话链接。没有完整日期时发送时间为 null，并要求保留平台原始时间标签；会话类型无法证明时为 UNVERIFIED，仅供查看和人工跟进。不能从显示名称、气泡次序、公开评论者标识或本机读取时间猜测缺失身份、消息ID和发送时间；不明确方向不能进入此合同。`VISIBLE_MESSAGES_ONLY` 表示本次可见范围，不能宣称完整历史。

浏览器会话使用 `facebook_browser_messenger` 标识空间，官方接口沿用 `facebook_messenger`。即使数字完全相同也不会自动合并为同一客户，浏览器会话标识不能当作PSID。浏览器事件键包含账号、会话、消息ID，原文/对方/发送时间变化触发冲突；重复观察和显示名称变化不重复建档。环境和观察时间作为来源证据保存，重复读取不会覆盖第一次证据。同一会话的对方标识变化被拒绝。

客户来信进入原Inbox并可查看、维护客户和跟进。原生人工回复记录为 `EXTERNAL_OUTBOUND`，重复回复不增加消息；与本系统发送回执的匹配必须同时对应渠道、账号、收件人、原动作正文和远端消息标识。明确退出继续复用原退出处理，即时更新客户和联系目标，后续来信不自动撤销退出。

浏览器收件不生成官方接口联系窗口。未配置浏览器接待的账号继续只收件；本机合成账号显式配置下述浏览器渠道后，新来信可建立仅供本地验证的服务依据并进入原自动接待队列。真实模板每轮核对绑定个人账号身份及逐条消息发送者；时间为空或类型为 UNVERIFIED 的真实来信不产生自动接待依据。读取到消息本身不授予真实发送能力。

迁移只扩展原表来源/渠道约束、收件索引和消息归属触发器，沿用原品牌RLS。触发器使用调用者权限及固定空`search_path`，未新增对公开角色的授权。实现参考[Supabase RLS文档](https://supabase.com/docs/guides/database/postgres/row-level-security)。


## 收件监控接口与检查点

- `GET /api/browser-inbox`：当前品牌的监控和最近100个分页检查点。
- `POST /api/browser-inbox/monitors`：管理员保存监控，包含 `request_id`、`environment_id`、`expected_version`（新建为0）、`interval_seconds`（10–3600）、`page_size`（1–50）、`raw_retention_hours`（1–24）。同账号只保留一个监控。native 合成 Facebook 环境使用合成模板；AdsPower 个人账号须另外固定 `target={thread_id,peer_id,display_name}`，并使用独立真实只读模板。
- `POST /api/browser-inbox/monitors/:id/control`：管理员提交 `request_id`、`expected_version`、`action=SCAN|START|PAUSE`。SCAN 在暂停状态完成一轮；START 按间隔持续检查；PAUSE 阻止后续读取并使当前回执失效。修改绑定前必须暂停、等待当前命令结束且关闭证明被确认。

接口只创建受管收件任务，不能提交任意浏览器消息。快照固定账号/环境版本、可见身份、监控版本、单调页令牌、周期ID、游标及期限。每页使用原Agent资源槽、账号和环境租约；回执的原页摘要与任务对应。消息、原回执及分页检查点在同一事务提交，重复消息不重复入库，任何消息身份冲突整页回滚。原始消息页不保存到检查点表，检查点仅含摘要、游标与计数。

一轮只覆盖模板明确提供的可见消息，每轮最多尝试20页；游标循环或达到边界时停止并提示原因，不宣称完整历史。读取失败保留原游标并暂停，由管理员检查后决定继续或重新配置。周期结束后从首页重读并按消息ID去重，以捕获新来信和人工回复。当前合成游标为 offset，真实平台模板必须提供可验证的分页行为，不能直接复用合成游标当作平台分页证据。

监控直到命令结束且 guardian 关闭证明确认后才清除当前任务。未知执行或失联仍遵循原环境隔离，停止监控不会解除隔离。过期页面在 Agent 本机清理，控制端离线不延长期限；入库与关闭确认后立即压缩原文回执，保留原关闭证明摘要。兼容旧日记格式，内部 `collection_expires_at` / `collection_redaction` 字段也用于收件页。此期限不等于统一Inbox业务消息、浏览器缓存或备份的保留期。

新增两张品牌隔离表 `browser_inbox_monitors` / `browser_inbox_checkpoints`；均启用RLS，检查点对应用角色只授予读取与插入。迁移通过CLI生成，再由原项目迁移器在备份后应用。

## 浏览器回复与销售移交

`POST /api/facebook/connections` 在原接待配置中新增 `transport=API|BROWSER`，默认 API。工作台“Facebook 账号与接待 → 回复渠道”可选择“本地浏览器验证”；当前仅支持已配置 native 浏览器的合成 Facebook 账号。更改渠道递增原配置版本，旧回复在入队、分配及发送前失效。渠道身份保持独立，API 客户的消息不会借用浏览器会话发送，反之亦然。

新浏览器来信在选定 BROWSER 后，使用 `kff.browser-fixture.service-window.v1` 建立本地合成服务依据，不证明真实平台发送资格。暂停接待继续收件；明确退出不会被后续来信解除。原来的 AI 规则、人工接管、限额、停止版本、会话版本、服务窗口和 WhatsApp 目的地检查均继续生效。

`kff.fixture.messenger.reply.browser` 使用固定模板 `fixed-browser-message-v1`，通过同一 Worker、Agent 和 guardian 打开绑定环境。任务固定会话标识、对方标识、触发来信和最后看到的消息标识。发送前核对可见登录与操作身份、会话、对方、唯一来信及最后一条消息；出现尚未收取的新消息时停止旧回复。原提交意图落库并由本机 guardian 确认后，页面只允许一次匹配正文和目标的提交；回执必须含新消息ID、账号、会话、对方和正文摘要。

发送成功后由原 `projectMessageOutcome` 写入 Inbox。未知结果继续占用和隔离，不能创建下一次发送。`reconcileSynthetic` 只读取原动作的本地记录，必须同时匹配账号、会话、对方和正文；人工裁定也要求会话及对方证据。核实结果与解除隔离分别进行，解除仍需要原 guardian 关闭证明。后续收件读到自己的发送回声不会重复生成一条原生人工回复。

原 Inbox 的人工回复、自动接待和 WhatsApp 邀请共用此执行器。邀请在取得发送回执前为 QUEUED，核实发送后为 REFERRED；销售核实客户联系后另行登记 CONFIRMED / HANDOFF_COMPLETE。合成销售确认仅用于验证状态转换，不是 WhatsApp 实际到达或真实销售接手的证据。

本机测试服务4311保存单一 `fixture-browser-messages.json` 事件文件，写入完成后才返回消息，重启后保留。`POST /browser-inbox/events` 创建本项目的合成客户来信，随后仍需通过可见页面收件任务入库；`POST /browser-message-send` 是合成页面自己的发送入口，重复动作或会话变化会拒绝；`GET /browser-message-receipts?action_id=...` 用于只读核验原提交。这些是本机测试服务入口，不是 KFF 接收真实平台消息的接口。
