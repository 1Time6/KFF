# Apify 第一阶段接入

核对日期：2026-09-12。账号已通过 Google 注册，用户名 `tropical_fishfly`；KFF 已成功调用 `/v2/users/me` 核对账号。账号与采集器元数据的实际证据见 [apify-connection.json](../evidence/apify-connection.json)。

## 已接好和待验收的范围

- 本机凭据保存于 `.kff/apify-connection.json`，该目录被 Git 忽略；凭据未写入本文、前端响应或验证证据。
- KFF 支持读取指定的、已成功结束的 Facebook / Instagram 评论采集运行：在工作台选择“Apify / 其他数据服务”、评论区策略，来源标识填写 `apify-run:<17位运行ID>`。
- KFF 核对 Apify 运行的所属账号、采集器和状态，读取 INPUT 和 Dataset，转换评论 ID、正文、作者 ID、时间和计数，复用分页检查点、去重、关键词评分与线索池。
- 来源数据缺少数值作者 ID 时标记为未返回；用户名和 `pfbid` 不会冒充 Messenger 收件人 ID。Apify 线索仍不能直接生成自有评论私信任务。
- 这条读取路径不会启动新的 Actor；对同一个 Run ID 重复扫描只会重新读取其结果。自动启动新抓取、主页到评论的多阶段调度、竞品关键词找帖尚未完成运行验收。
- 当前没有启动真实采集，没有真实评论入池；第一批帖子／主页／竞品目标仍待指定。$5 试用额度是注册后控制台显示的额度，不是已批准的持续运行预算。

## 第一阶段选用的 Actor

以下 5 个 Actor 均已通过真实 Apify API 核对名称、ID 和公开状态；这只证明接口存在，不代表已验证采集覆盖率。

| 用途 | Actor | 使用边界 |
|---|---|---|
| Facebook 评论 | [apify/facebook-comments-scraper](https://apify.com/apify/facebook-comments-scraper) | 输入公开帖子 URL；KFF 已实现结果读取 |
| Instagram 评论 | [apify/instagram-comment-scraper](https://apify.com/apify/instagram-comment-scraper) | 输入公开帖子或 Reel URL；KFF 已实现结果读取 |
| Facebook 主页帖子 | [apify/facebook-posts-scraper](https://apify.com/apify/facebook-posts-scraper) | 先发现帖子，再交给评论 Actor；暂未自动串联 |
| Instagram 话题帖子 | [apify/instagram-hashtag-scraper](https://apify.com/apify/instagram-hashtag-scraper) | 发现话题中的帖子／Reel；暂未自动串联 |
| Facebook 关键词找帖候选 | [scraper_one/facebook-posts-search](https://apify.com/scraper_one/facebook-posts-search) | 社区维护，须用实际关键词小样本验证后再接入 |

Apify 官方的 `apify/facebook-search-scraper` 主要返回主页／个人资料，不能将其结果宣称为全域帖子或评论搜索结果。[官方说明](https://apify.com/apify/facebook-search-scraper)

## 原生 API

固定来源：`https://api.apify.com`。Token 仅放在 `Authorization: Bearer <token>` 请求头中。[认证文档](https://docs.apify.com/integrations/api)

| 步骤 | 方法与路径 |
|---|---|
| 验证账号 | `GET /v2/users/me` |
| 查看采集器 | `GET /v2/actors/apify~facebook-comments-scraper` |
| 启动 Facebook 评论采集 | `POST /v2/actors/apify~facebook-comments-scraper/runs` |
| 启动 Instagram 评论采集 | `POST /v2/actors/apify~instagram-comment-scraper/runs` |
| 查看运行 | `GET /v2/actor-runs/{runId}` |
| 读取来源输入 | `GET /v2/key-value-stores/{defaultKeyValueStoreId}/records/INPUT` |
| 分页取回结果 | `GET /v2/datasets/{defaultDatasetId}/items?format=json&clean=false&offset=0&limit=20` |

真实运行开始前固定单次结果数量、超时和费用上限。Apify 的启动端点支持 `maxTotalChargeUsd` 和 `timeout`；不能把客户端 HTTP 超时视为远端运行已取消。[运行端点](https://docs.apify.com/api/v2/actors-runs-post)

Facebook 输入示意（`TARGET_PUBLIC_POST_URL` 必须替换为选定公开帖子）：

```json
{"startUrls":[{"url":"TARGET_PUBLIC_POST_URL"}],"resultsLimit":20,"includeNestedComments":false,"viewOption":"RECENT_ACTIVITY"}
```

Instagram 输入示意：

```json
{"directUrls":["TARGET_PUBLIC_POST_OR_REEL_URL"],"resultsLimit":20,"includeNestedComments":false}
```

输入依据：[Facebook](https://apify.com/apify/facebook-comments-scraper/input-schema)、[Instagram](https://apify.com/apify/instagram-comment-scraper/input-schema)。关闭嵌套回复可避免额外回复记录带来的数量和费用变化；以运行前控制台报价为准。

## 配置与验收

本机首次连接：`node --import tsx scripts/apify-connect.ts <指定邮箱>`。该命令提供临时本机表单，验证身份后仅创建新的私有凭据文件，不覆盖已有配置。

生产环境使用 `APIFY_API_TOKEN` 和 `APIFY_USER_ID`；本地开发才读取 `.kff` 文件。开启真实数据读取需要 `KFF_ENABLE_DISCOVERY=true`。当前本机仍保持原采集／发送开关关闭。

Apify 采集不需要 Meta Token，但 KFF 中仍需选定归属品牌的真实平台账号作为线索管理范围。原生 Meta 评论收发继续独立要求账号凭据与权限。

第一轮验收顺序：选定目标和小额上限 → Apify 启动一次 → 核对成功运行和 Dataset → KFF 新建评论监控并扫描一次 → 核对原始评论、字段缺失、去重和线索评分。真实私信与 WhatsApp 到达须另行验收。

## 首次采集前的代码验证

26 项单元测试、92 项接口合同测试和 9 项隔离数据库获客测试通过。新增数据库用例证明：Apify 结果可进入关键词线索池，不需要 Meta Token，不改变平台账号的身份验证状态，也不授予私信资格。真实 API 只验证了账号与 5 个 Actor 元数据，不能将这些本地用例称为真实评论验收。

## 2026-09-12 首批真实关键词采集

用户指定“八字测算”后，真实运行已完成：搜索 Run `xSq8Gaz0XgBBAyNGd` 返回 22 条独立帖子；评论 Run `ZxnnQh3oOIpUQWpov` 从选定的两条公开 Reel 返回 24 条独立评论，按提供方 profileId 去重为 19 个公开资料标识。评论日期为 2026-07-24 至 2026-08-26，属于历史公开样本。21 条为 PM，另外是想了解、预约和询问地址；这些都面向原商家，不能计为 KFF 已获客。

两次运行报告费用合计 $0.14905；设置的单次费用上限分别为 $0.15 和 $0.30，超时均为 240 秒。搜索请求 20 条而提供方实际返回 22 条，数量参数不是严格结果截断。CSV 中保留实际返回数量。

KFF 原生 Apify 读取适配器已通过真实 API 读取和规范化这 24 条评论。所有评论都未返回适配器可接受的数字作者 ID，保持 `NOT_RETURNED`，未将不透明标识当作 Messenger 收件人。当前本地只有合成平台账号，未创建虚构真实账号，未写入数据库线索池、未发送消息。还需真实账号归属或独立外部数据源范围，才能完成工作台入库；现有逐字关键词评分也需要明确区分原帖主题与评论咨询词。

非敏感验收记录：`docs/evidence/apify-bazi-sample.json`。原始结果与 CSV 保存在已忽略的 `.kff/apify-runs`、`.kff/acquisition/bazi-search-20260912`，不提交公开昵称和评论数据到代码仓库。

执行工具：`scripts/apify-run.ts search|comments|status|results <唯一标签> [输入JSON路径]`。启动前写入独占回执，网络不确定时不能重试 POST，先核对原运行。`scripts/apify-export.ts <搜索标签> <评论标签>` 用真实读取适配器核对结果后导出带来源链接的 CSV，需本进程配置 `KFF_AUTH_MODE=local`、`KFF_ENABLE_DISCOVERY=true`；不更改开发服务全局开关。

## 后续完成：真实数据入库与工作台

上节的“尚未写入数据库”是采集时点记录，现已补齐独立外部数据归属。数据库使用项目现有的本机 PostgreSQL，目录 `.kff/postgres`，无新增云资源。新增迁移 `20260912121030_acquisition_external_sources.sql`：

- `acquisition_sources`：品牌与已核实的 Apify 账号绑定；不存 Token。
- `acquisition_imports`：保存真实 Run、Actor、Dataset、数量、内容摘要和运行费用。相同数据源的相同 Run 只入库一次。
- `acquisition_prospects`：公开帖子和评论，保留原文、链接、公开昵称、时间、主题依据和人工筛选状态。按数据源、平台、内容类型、远端 ID 去重；旧 Run 不覆盖更新的内容；重复采集不清除退出或排除状态。

上述表按组织和品牌启用 RLS。来源导入只允许管理员，筛选允许操作员，浏览者不能写。私人资料只取已公开的必要字段，默认保存 14 天（可选 1–30 天），到期立即从工作台隐藏并由 Worker 清理。原有自有账号的 collection / acquisition 执行链保留；外部资料没有发送账号，不进入自动回复队列。

工作台顶部“真实外部数据与线索”支持连接、导入、关键词搜索、帖子/评论分类、人工筛选和批次追溯。接口：

| 接口 | 用途 |
|---|---|
| `POST /api/acquisition/sources/apify` | 实时验证已配置的 Apify 账号，登记到当前品牌 |
| `POST /api/acquisition/imports/apify` | 参数 `source_id`、`run_id`、`kind`、`retention_days`、`request_id`；只读取已成功结果，单批最多 1000 条 |
| `POST /api/acquisition/prospects/:id/control` | 参数 `expected_version`、`state`、`reason`、`request_id`，更新人工筛选 |
| `GET /api/acquisition` | `external` 返回来源、批次、最近最多 500 条记录和全量未过期统计 |

`kind` 支持 `FACEBOOK_POSTS`（指定关键词 Actor）、`FACEBOOK_COMMENTS`、`INSTAGRAM_COMMENTS`（官方评论 Actor）。先导入帖子再导入评论，才可用原帖文字核对“八字测算”主题；评论中的 PM 不需要重复写出该关键词，也不会被评为已获客。缺少原帖时保留评论，评分为 0，等待筛选。

已完成真实 API → PostgreSQL → 工作台验收，入库为 22 条帖子、24 条评论、19 个提供方资料标识，人工资格确认 0。重复导入评论 Run 复用原批次。运行费用仍为原两次抓取合计约 $0.14905；本轮未启动新的抓取。验收记录 [apify-database-acceptance.json](../evidence/apify-database-acceptance.json)。

迁移前已停库备份 `.kff/backups/before-external-sources-20260912-2019/postgres`，7822 个文件逐一 SHA-256 核对一致。回滚应先停止服务并备份当前库；恢复前备份会丢失本轮新增数据，不应在后续产生新业务数据后直接覆盖。默认优先修复迁移，不自动恢复旧快照。
