# Facebook 接待与 WhatsApp 引流

## 本地操作

运行 `pnpm dev` 后打开 `http://127.0.0.1:3000/inbox`，登录信息在本机 `.kff/本地登录.txt`。

1. 展开“Facebook 账号与接待”，添加本地合成 Page，绑定本机 Agent，保存接待配置。需要自动接待时启用“自动接待新私信”。真实账号沿用账号中心登记和环境绑定流程。
2. 在“意图识别与自动接待规则”选择本地规则预演，配置问候、追问、关键词、引流轮次、置信度和次数/间隔。客户主动要求 WhatsApp 时可直接邀请；投诉、人工请求、附件和不确定建议转人工。
3. 展开“WhatsApp 号码与引流话术”，配置本品牌默认或账号专用目的地，号码为带国家区号的纯数字。话术保留 `{whatsapp_url}`；可选 `{whatsapp_number}`。账号专用配置优先，专用号码暂停时不会回退品牌默认。
4. 用“本地模拟客户互动”提交私信、评论或原生人工回声。评论/互动保存潜客，不授予 Messenger 发信资格。进入会话可见完整消息、自动判断与发送进度，只有确认回执才显示为已发送。
5. 使用“切换接待方式”接管、暂停或恢复；人工回复提交时原子接管。旧 AI 快照失效。在途/未知消息先在“查看执行与核验”核验原提交；合成未知消息可直接“核验原提交”。原执行关闭后才可解除隔离或最终人工裁定。
6. 邀请确认发送后，在“记录 WhatsApp 客户结果”记录销售核实结果和依据。客户实际联系不是从链接或发送回执推断。客户档案可维护标签、意向、负责人、跟进阶段和备注。
7. 在 `http://127.0.0.1:3000/lead-analytics` 按日期、账号和真实/合成范围查看统计、首次来源、自动/人工回复观察、版本化话术与日志。统计使用 UTC。

## 接口与权限

所有业务接口均要求登录和品牌范围，POST 校验同源；viewer 只读，operator 可接待/维护客户，admin 可配置连接、规则、号码和 Agent。请求体为严格 JSON，主体有字节上限。

| 接口 | 行为 |
|---|---|
| GET/POST `/api/facebook/webhook` | GET 验证 challenge；POST 验证原始字节 HMAC，再按唯一真实 Page 绑定解析范围 |
| GET `/api/facebook` | 当前品牌连接及真实平台状态 |
| POST `/api/facebook/connections` | 版本化接待配置；绑定必须为同账号/品牌环境 |
| POST `/api/facebook/reception-policy` | 配置模型方式、规则和业务话术 |
| POST `/api/facebook/fixtures` | 管理员创建本地合成账号与环境 |
| POST `/api/facebook/fixtures/:account/events` | 本品牌合成注入，真实账号拒绝 |
| GET/POST `/api/whatsapp` | 读取/配置本品牌或单账号目的地及话术 |
| GET `/api/conversations/:id/reception` | 有效目的地、准备作业、发送进度和引流记录 |
| POST `/api/conversations/:id/controls` | HUMAN/AI/PAUSED，需当前 control_version、request_id、原因 |
| POST `/api/conversations/:id/replies` | 原子人工接管并走原 Task/Action/Agent；固定消息或目的地话术 |
| POST `/api/conversations/:id/retry-reception` | 对最新未回答私信显式重新准备，拒绝未知/未关闭旧执行 |
| POST `/api/whatsapp-referrals/:id/result` | 已确认发送后人工登记 CONFIRMED/DECLINED 和依据 |
| POST `/api/customers/:id/lead` | 版本化阶段、标签、意向、有效咨询标记和依据 |
| GET `/api/lead-analytics` | from/to 日期、可选 account_id、synthetic=true/false；最多 366 天 |
| GET `/api/lead-audit` | 品牌内最近 200 条安全字段日志，可用 before 时间继续读取 |

更新保留 `request_id` 与原内容重试；不同内容不能使用同一键。会话消息依据、动作回执、引流目的地快照和审计不覆盖历史。原有客户跟进、运行核验、裁定与暂停接口继续使用。

## 接待、重试与停止

RECEPTION 作业在收件事务内入队，后台扫描补准备恢复后的未回答会话；租约 45 秒，每次接手增加 token。模型网络请求最多 20 秒，输出最多 64 KiB，只接受完整结构化决策，拒绝工具请求/拒绝结果/部分输出。三次准备失败后转人工；限额或在途等待不计模型失败次数。

AI 模式：REPLY、ASK_QUESTION、REFER_WHATSAPP、HANDOFF、STOP。模型不能指定号码、账号或收件人，普通模型回复包含链接/电话号码/付款信息时转人工。WhatsApp 邀请由保存的模板生成。每次提交重新检查最新入站序号、处理版本、连接/目的地版本、组织/品牌/账号/Agent 停止 epoch、联系窗口和冷却；账号每日回复上限计已授予提交意图的动作，按 UTC 重置。

发送未知可能已经成功；不盲目重发。合成环境可以查询原 HTTP 记录，真实环境保留人工核验与 guardian 关闭证明。人工确认成功也记录收件人。原生人工回声接管；匹配本系统原动作的回声只存事件证据，不复制消息或抢走 AI 控制权。进程在事务提交前退出回滚，提交后按原请求重放；Agent 日志和关闭证明用于恢复原动作。

Webhook 每批最多 200 个事件、512 KiB，默认每账号每分钟最多 1000 个新事件（`KFF_FACEBOOK_EVENTS_PER_MINUTE` 可配置 1–10000）。已保存事件重试不重复扣限额；达到速率限制返回 429，平台重试后从未确认部分继续。缺身份/空内容/不支持事件返回忽略计数，来源字段缺失保留空值。明确退出即时停止；重新来信或修改阶段不会自动撤销退出资格。

## 模型和真实平台配置边界

`LOCAL_RULES` 无外部凭据，属于本地规则预演。`OPENAI_COMPATIBLE` 由服务端配置 `KFF_RECEPTION_AI_URL`、`KFF_RECEPTION_AI_KEY`、`KFF_RECEPTION_AI_MODEL`，接口需支持 Chat Completions 的严格 JSON Schema 输出；系统不会自动选择或调用付费模型。凭据仅放在运行环境，不通过业务页面保存或返回。仅发送当前会话最近 12 条相关文本和批准业务介绍，不发送其他账号历史、号码配置或数据库凭据。未配置/接口错误有明确作业错误和转人工路径，绝不悄悄回退并伪装成模型成功。

真实 Facebook 需 `KFF_FACEBOOK_APP_SECRET`、`KFF_FACEBOOK_VERIFY_TOKEN`、明确 Graph 版本、Page Token 引用及相应平台权限。Send API 合同已实现 Page 身份检查和指定 PSID 的一次性 RESPONSE 提交；本轮未进行任何真实 Meta 调用、App Review、窗口/事件订阅实测或生产放行。真实能力仍禁用，且需要原能力证据/许可体系的后续受控验证，不是填入 Token 就可启用生产。

参考：[Meta Messenger 官方 API 集合](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)、[Meta 示例](https://github.com/fbsamples/messenger-platform-samples)、[OpenAI Chat 接口](https://developers.openai.com/api/reference/resources/chat)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。模型真实质量、客户已读、实际添加、成交效果均未由本地合成结果证明。

## 多 Agent

环境中心沿用原配对配置下载。额外本地进程指定自己的配置文件：

```powershell
$env:KFF_AGENT_CONFIG_FILE = '.kff/pairings/second-agent.json'
pnpm agent
```

每个额外 Agent 的日志、进程锁、guardian 证明和浏览器数据位于 `.kff/agent-instances/<agent_id>`。同一 Agent 的配置副本仍映射到同一锁；默认 Agent 保留原 `.kff/agent` 恢复路径。额外配置不继承默认 `KFF_AGENT_TOKEN`。数据库、controller token 不传给 guardian。Windows 真实双进程绑定执行已纳入浏览器测试。

## 统计口径

新客户按 KFF 建档时间计数，归因为首次观察来源；最近互动时间单独保留。转化分母为本期新建且当前标为有效咨询的客户，分子为其中在本期获得已确认邀请的客户，同一客户只计一次，零分母返回 null。发送消息、邀请次数、人工确认客户结果另计；排队、失败和未知不计成功。

自动/人工效果展示已确认回复、接待客户、当前有效咨询与回复后继续来信；话术统计保留目的地版本、执行方式和本次消息来源。这些是相关观察，不宣称因果或成交。真实与合成数据始终分开，operator 手工修改有效咨询标记会影响当前统计并留下审计。
