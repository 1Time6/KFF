# 主动获客与自动执行接入说明

入口 `/acquisition`，API 使用现有登录、组织/品牌隔离、角色和 Origin 校验。管理员管理来源与自动规则，运营人员处理线索及准备单次动作，查看者只读。所有写入携带 UUID `request_id`；相同请求重试返回原结果，不同内容重用同一 ID 返回冲突。

## 本地使用

1. `pnpm install --frozen-lockfile`，`pnpm dev`。保持 `KFF_ENABLE_LIVE=false`、`KFF_ENABLE_DISCOVERY=false`。
2. 登录后打开主动获客工作台，选择在线的本机 Agent，添加 Facebook 或 Instagram 本地验证账号。
3. 新建监控，选择该账号与本地合成来源，填写关键词、排除词、读取上限、间隔和用途依据。点击“扫描一次”；扫描记录展示读取/去重数量、状态和停止原因，线索展示原始内容及匹配依据。
4. 选择监控，配置最低评分、账号每日上限、延迟、话术和环境，启用自动规则，然后启动监控。或核对一条线索并准备一次动作。
5. 在动作列表和运行记录查看原始任务、提交回执及未知结果。合成发送实际请求本地 HTTP fixture，结果只能证明本地执行链。

监控间隔 5 分钟至 7 天，每次最多 1000 条/100 页，留存 1–30 天。工作台展示最近最多 100 个监控、200 条线索、100 条扫描和100条动作，页面筛选仅作用于当前加载线索。每次扫描对应原查询，可在查询与结果中查看和导出该批原始记录。评分是关键词/意向词规则排序，不是 AI 判断或购买概率。

暂停监控取消未完成扫描并使旧任务失效。重复扫描同一未变化评论保留已批准目标版本；正文、作者、来源、时间等字段发生变化使旧目标失效。同账号、平台、评论、动作类型最多建立一个原动作；未知提交不自动重发。作者退出状态跨监控保留，不因重采集恢复。每日准备上限和提交上限独立检查；同作者每日最多提交一次互动，日界线按数据库时区（本地默认 UTC）。规则失败原因显示在线索行，修改线索状态重新核对可触发准备重试；退出抑制仍优先。线索过期删除不删除原动作审计。

## 接入条件

| 来源/能力 | 必须准备 | 当前支持及限制 |
|---|---|---|
| Facebook 自有评论 | Meta App、已授权 Page、Page ID、服务端 Page Token、自有帖子 ID、核实过的 Graph 版本 | 读取和分页解析适配器已实现；需要实际验证评论字段、作者 ID、帖子所有权和读取权限。嵌套评论覆盖以接口实测为准 |
| Instagram 自有评论 | 专业账号、Instagram Login 对应 App/Token、IG User ID、媒体 ID、核实过的 Graph 版本 | 使用 `graph.instagram.com` 体系；Facebook Login 的 Page Token 不可混用。需验证 identity、owner、from、media 字段和评论/消息权限 |
| FB/IG 全域关键词、话题、主页、竞品评论 | 能提供这些数据的服务及使用权限、稳定 HTTPS endpoint、API key、覆盖/分页/配额/留存说明 | 实现规范化数据服务协议。不能把任意供应商 URL 直接填入就视为兼容；服务方或桥接适配器需转换为下述格式。采集结果仅为来源可见范围 |
| 评论触发私信/回复 | 上述自有评论身份、消息/评论操作权限、有效互动窗口、指定测试目标与话术、真实身份读取回执 | FB/IG 原生接口合同已实现，本轮没有真实回执。第三方或竞品采集结果不能直接生成原生私信动作 |
| Facebook Messenger 接待 | 公网 HTTPS Webhook、App Secret、Verify Token、Page Webhook 订阅、Page Token、消息权限、客户主动发起私信 | `/inbox` 提供“准备真实私信试验”，冻结当前会话/接收者/话术后等待任务许可；客户新消息、退出、接管和窗口到期都会重新检查 |
| WhatsApp 引流 | 实际销售号码、可核实话术、销售接手人员 | 发送链接和人工确认到达沿用现有接待流程；链接发出不等于 WhatsApp 到达或成交 |

不要在页面或数据库填写 Token 明文。账号仅登记 `FACEBOOK_...` / `INSTAGRAM_...` 凭据引用，对应值保存在运行环境。Web/Worker 读取采集凭据，执行 Agent 读取发送凭据。更换凭据应使用账号现有版本控制流程，重新核实身份，不直接覆盖已有任务的凭据身份。

Meta 权限名称、账号类型、审核要求与窗口须在接入时按实际 App 模式确认；不是拥有 Token 就已获得许可。官方参考：[Meta Facebook API](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)、[Meta Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)、[Meta Messenger Platform](https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api)。本轮只有 HTTP 合同测试，原生字段与真实授权仍须实测。

权限检查项：Facebook 的 `pages_read_engagement`、`pages_read_user_content`（用户评论）、`pages_manage_engagement`（公开回复）、`pages_messaging`（私信），Webhook 订阅还需核对 `pages_manage_metadata`。Instagram Login 核对 `instagram_business_basic`、`instagram_business_manage_comments`；持续消息接待另核对 `instagram_business_manage_messages`。具体所需组合、Standard/Advanced Access 与审核范围以实际 App 模式为准。Instagram 评论私信的请求示例可对照 [Meta 官方样例集合](https://github.com/fbsamples/messenger-platform-samples/blob/main/postman/instagram-platform-api.postman_collection.json)。

## 服务端配置

```text
KFF_ENABLE_DISCOVERY=false
KFF_DISCOVERY_PROVIDER_URL=https://your-service.example/kff/discovery
KFF_DISCOVERY_PROVIDER_KEY=<server secret>
FACEBOOK_<REFERENCE>=<Page token>
INSTAGRAM_<REFERENCE>=<Instagram Login token>
KFF_FACEBOOK_GRAPH_VERSION=<verified vNN.N>
KFF_ENABLE_LIVE=false
```

真实采集还需要在监控中填写 `graph_version`、`credential_ref`，与所选账号匹配。真实发送开关是独立的；启用采集不会启用发送。配置不足的扫描返回 `DISCOVERY_DISABLED`、`SOURCE_NOT_CONFIGURED` 或 `SOURCE_AUTH_REQUIRED` 等原因，不回退合成数据。

## 数据服务协议 v1

固定 HTTPS 地址，不带 query/hash；禁止重定向。KFF 发送 `POST`，`Authorization: Bearer <KEY>`，JSON 请求示例：

```json
{"protocol":"kff.discovery-provider.v1","platform":"facebook","strategy":"KEYWORD","keywords":["consultation"],"target":"","cursor":null,"limit":100,"fields":["message","author_id","created_time","reaction_count","comment_count"]}
```

服务需使用 cursor 分页，返回严格对象（不要返回未经转换的原供应商对象）：

```json
{"rows":[{"source_object_id":"123_456","source_url":"https://www.facebook.com/123/posts/456","fields":{"message":{"kind":"VALUE","value":"I need a consultation"},"author_id":{"kind":"VALUE","value":"789"},"created_time":{"kind":"VALUE","value":"2026-09-12T08:00:00.000Z"},"reaction_count":{"kind":"NOT_RETURNED"},"comment_count":{"kind":"NOT_RETURNED"}}}],"next_cursor":null}
```

字段须与请求一致，不可把缺失字段伪造为空值；其状态遵循 `packages/contracts/src/collection.ts`。每页至多100条、JSON至多1MiB、响应15秒内，cursor至多2048字符，末页用 `null`。source_object_id 稳定且同源唯一，source_url 属于声明平台；不得返回跳转链接或另一平台地址。429/401/403 保留为来源限额或授权失败，扫描保留已提交页。业务端不知道服务的全站总量，coverage 标记 `PROVIDER_RESULTS_ONLY`。

## API

### 线索评分与人工审核

关键词命中仍是规则评分，不代表购买概率。明确“购买我的/我们的课程”等自推命令，或“我们提供服务”同时含联系商家的语句，评分为0；原始观察和独立评估记录照常保留，不生成新客户候选。中文与英文的有限规则忽略成对引号中的宣传语，保留“我想购买你的课程，请问价格”等询问的原评分。它不覆盖所有广告、转载或复杂语境，仍需人工核对。

同一来源后续被筛除时更新当前评分与观察，已人工审核的线索保留原审核理由；原评估与审核审计不改写。12项隔离库测试验证推广观察不会生成线索或自动任务，正常询问生成一条幂等的合成任务。真实新观察的这次验收失败、0条入库，详见 [当前证据及限制](../evidence/promotion-screening.json)。

| 方法与路径（`/api/` 前缀） | 用途 |
|---|---|
| GET `acquisition` | 来源准备状态、监控、线索、扫描和动作 |
| POST `acquisition/fixtures` | 独立合成账号/环境，传 platform、agent_id |
| POST `acquisition/monitors` | 保存默认暂停的监控；结构见 monitorInput |
| POST `acquisition/monitors/:id/control` | START / PAUSE / SCAN，必须 expected_version 与 reason |
| POST `acquisition/leads/:id/control` | NEW / QUALIFIED / DISMISSED / OPTED_OUT，必须 expected_version 与 reason |
| POST `acquisition/outreach` | 冻结指定 lead_id、版本、环境、动作、话术、依据、延迟 |
| POST `acquisition/automation` | 保存指定监控版本的自动规则 |
| POST `conversations/:id/pilot-reply` | 准备真实 Messenger 试验；与普通回复相同输入，返回任务 ID |

精确输入由 `packages/contracts/src/acquisition.ts`、`lead.ts` 的严格 Zod 合同定义。真实动作返回 `AWAITING_PILOT_PERMIT`，不会创建执行作业；合成动作返回 run_id 并入队。

原生评论私信使用 `/{account-id}/messages`，正文为 `recipient.comment_id` 和 `message.text`，不会把评论作者 ID 当成 Messenger PSID。Instagram 使用 Meta 官方样例的 Instagram Login 主机；Facebook 使用 Page Send API 路径。两者的真实权限、评论字段和返回身份仍须实际账户验收，不以 HTTP mock 代替平台证明。

## 真实验收顺序

1. 完成来源授权、账号/凭据登记和环境绑定，配置明确 API 版本。
2. 运行当前合同测试和 `pnpm evidence:register`，在能力页登记本地证据。先创建并批准账号身份读取试验，核对回执的账号和凭据版本。
3. 指定测试账号创建真实评论/私信，确认入库身份、来源、时间、分页及去重；核对工作台内容。
4. 准备一条目标和话术固定的互动/私信，在任务中批准明确范围的试验许可、预算和停止规则，再启用对应真实执行环境。程序在提交前再次核对原评论归属、接收者、版本、窗口、退出及限额。
5. 对照平台消息与本地回执，测试超时、重复请求和停止，确认不会发错人或重复发送。真实回执只代表 API 接受，不代表已读。客户回复后才能进入后续接待窗口。
6. 对实际 WhatsApp 到达由销售核实记录。通过受控验证后再决定生产放行；本实现的获客规则仍逐条准备试验任务，未提供无限批量生产群发入口。
