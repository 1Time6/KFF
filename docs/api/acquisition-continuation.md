# 搜索 / 主页自动接续评论采集

0.1.48 新增。复用原 `acquisition_monitors → collection_queries → Task/Action → Agent → observations → leads`，不建立第二套执行队列。

## 操作入口

在获客工作台的新建监控中，选择 Facebook 个人账号、本地浏览器，以及“关键词搜索”或“主页”。填写关键词、发布时间范围和来源使用依据，勾选“自动接续评论采集”。

默认每轮新增 1 个、累计最多 5 个来源，有效 24 小时。保存后监控保持暂停。启动父监控后，Worker 从同版本的成功读取记录中自动选源；子监控沿用账号、环境、关键词、排除词、频率和读取数量上限。界面默认只读一页可见评论，不声称全量或按最新排序。

派生来源必须是匹配关键词、时间可判定在范围内的规范公开帖子 / Reel；链接与来源 ID 一致，有原分页成功动作回执。失败、取消、过期、人工排除和未知日期不会派生。来源没有作者 ID 可以作为公开帖子采集来源；其评论成为 lead 后仍需分别核对作者。

来源按父监控和规范链接去重，保存父版本、查询、原观察 ID、链接和有效期。到期或暂停后保留记录，不因重扫自动恢复。累计数量包含已过期来源；达到上限后，先审核现有结果，再决定是否创建新父监控。子监控不能递归扩展来源，也不继承自动发送规则。

父监控暂停时取消其未完成采集并暂停子监控。重新启动父监控不会恢复旧版本子监控。原浏览器任务的派发、心跳和回执接收继续检查父状态及来源有效期；已停止页面的晚到结果不能入库。已提交的公开回复保留原动作核验流程，不重发。

## 接口

原 `POST /api/acquisition/monitors` 可增加可选字段：

```json
{
  "comment_continuation": {
    "allowed_source_types": ["POST", "REEL"],
    "max_sources_per_scan": 1,
    "max_sources_total": 5,
    "source_lifetime_hours": 24,
    "comment_order": "VISIBLE_WINDOW"
  }
}
```

每轮 1–5，总量 1–50，有效期 1–168 小时。只支持带 `max_age_days` 的真实 Facebook 搜索和主页模板。配置本身不授予发送资格。

## 自然线索核对

工作台展示缺少作者 ID、原评论链接冲突、观察过期、时间待核对、作者退出和未审核等原因。满足检查只表示可准备公开回复草稿；仍使用原目标版本、人工审核和具体许可。不能按姓名补 ID，也不能把公开作者当作 Messenger 收件人。

规则对已取得的“查8字 / 查８字”同义表达进行归一化匹配，原文不改；新增明确服务推广邀请识别。新观察使用新规则，历史评估和人工判断保留。

## 有限窗口报告

`scripts/matrix-window-report.ts` 从原数据库只读导出指定时间和账号的扫描、任务/动作（包含无命令的派发前失败）、命令、身份、排队/执行时间、关闭审计、收件周期、重复和跳过项。报告不连接 Facebook，不启动监控，不发送。

计划 JSON：

```json
{
  "from": "2026-09-15T03:00:00.000Z",
  "to": "2026-09-15T04:00:00.000Z",
  "synthetic": false,
  "targets": [{
    "account_id": "填写实际账号 UUID",
    "environment_id": "填写该账号环境 UUID",
    "minimum_public_scans": 2,
    "minimum_inbox_cycles": 2
  }]
}
```

```powershell
node --import tsx scripts/matrix-window-report.ts --plan .kff/my-window.json --output .kff/my-window-report.json
```

时间是明确 UTC，最多 24 小时；输出必须是新文件。`INCOMPLETE` 表示证据缺失或失败；`RECORDS_MATCH_COUNTS` 仅说明已有记录满足次数检查。持续调度、窗口独占、实际 Guardian 文件和真实容量仍需逐项核对，不能用该结果宣布全部验收。线索条数不等于独立人数；报告不把 C 的 WhatsApp 实收关联给自然线索。
