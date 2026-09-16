# DeepSeek 接入状态

**2026/9/15 00:34:32 最新：** 用户确认正确 WhatsApp +8618730936793 收到 C，新更正邀请已通过原接口登记 CONFIRMED/v3，客户为 HANDOFF_COMPLETE。用户另确认两条链接由其发送，iPhone 的 Messenger 能通过号码链接及短链接进入目标聊天，Facebook App 内只能打开 WhatsApp；后者尚未解决，不与实收混为一谈。0.1.46 已安装；原自动聊天目录扫描成功找到 C 并入库两条新链接，旧消息保持不变，0 发送。连续来信共用头像的解析已修正，10 号读取范围为最近 1 个已接受会话、最多 25 条消息，PAUSED/v21。总目标仍未完成。


**2026/9/15 00:12:00 最新：** C 新评论采集、去重、10 号公开回复、C 私信入库、真实 DeepSeek 草稿及审核后回复均已有原流程证据。用户更正 WhatsApp 为 **+86 18730936793（+8618730936793）**；已向同一 C 会话实际发送 1 条“号码更正”邀请并核对回执。此前 083 号码邀请保留为历史且已关联更正，不得将其确认成正确号码实收。当前发送关闭、20 个监控暂停、0 开放命令；0.1.45 已安装，10 号 Inbox 已恢复原最近已接受会话范围并保持暂停。等待正确号码实际收到 KFF-0914-C 的用户确认，完整目标仍未完成。

真实 C 草稿 job：4afdaaba-f1d3-4354-a274-4effa0f7cf16；实际 AI 回复任务：9331c163-fe44-4d0e-8a9c-ebfc377a0a5e。自动回复关闭。以下为早期接入证据，旧号码和仅验证草稿的描述按历史时间理解。


**2026/9/14 21:38:04 交付完成：** 0.1.40 已安装运行，真实 DeepSeek V4.1 Flash（API 名 deepseek-flash）咨询流程草稿调用通过；原 Worker 对已收到的测试确认消息生成了 HANDOFF 人工处理建议，job d894c108-24af-45c8-983d-44ef69f5173e，单次尝试 DONE/DRAFT_READY。这个结果验证后台模型调用，不能当成新客户回复或已发送消息。179 项契约、类型、lint、构建通过，Agent 和完整控制端包均校验完成；额外扫描确认两个包不含 DeepSeek 密钥。当前健康正常、18 监控暂停、0 开放命令、发送关闭。WhatsApp +8618730836793 已配置但实收未验收；新的 C 公开评论待用户完成，整条目标仍未完成。证据：docs/evidence/deepseek-release-040-20260914.json。

**2026/9/14 21:30:31 更新：** 用户改选 DeepSeek V4.1 Flash，官方 API 模型名 deepseek-flash。本机现有密钥已通过官方模型列表检查，并完成一次真实咨询流程草稿调用（HTTP 200，751 tokens）；这是对受控 B 来信的模型回放，没有 Facebook 发送。配置已保存至本机 .kff/reception-ai.env，0.1.40 已安装运行，正常启动和原 Inbox 草稿队列已通过验证。WhatsApp +8618730836793 保持已确认配置，实收未验收。

- 使用已有 DEEPSEEK_API_KEY 验证，没有把密钥写入聊天或证据。
- 本机持久配置文件：.kff/reception-ai.env，包含 KFF_RECEPTION_AI_URL、KFF_RECEPTION_AI_MODEL、KFF_RECEPTION_AI_KEY。标准本地启动入口读取该文件，只向控制端和 Worker 提供模型配置；Agent 环境白名单不包含模型凭据。不要复制此文件进交付包。
- DeepSeek 使用 JSON Object 输出；应用继续检查必填字段、退出联系、人工接管和回复限制。为简短接待关闭思考模式，输出上限 1024 tokens；调用超时仍为 20 秒。
- 一次真实回复正确介绍了英文书面八字咨询，并询问客户的问题和背景；没有编造价格、付款条件或提供旧号码。

[真实模型证据](docs/evidence/deepseek-provider-040-20260914.json) · [官方模型名称](https://deepseek.com/news/deepseek-v4-1-flash/) · [官方 JSON 格式](https://api-docs.deepseek.com/guides/json_mode/)。
