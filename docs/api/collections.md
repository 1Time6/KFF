# 采集公共合同与本地来源

对应 TASK-047、TASK-049、TASK-050 以及 TASK-052 的查询/结果详情子范围。当前实际运行来源为 `kff.fixture.page.posts`，版本 `fixture-page-posts-v1`，来源类型 `OWNED_FIXTURE`。样本由本仓库编写，包含 5 次观察、4 个不同对象、跨页重复、长 ID、前导零和缺失字段；不是 Facebook 抓取数据。

| 接口 | 作用 |
| --- | --- |
| `GET /api/collections` | 当前品牌最近 100 个查询及实际进度。 |
| `POST /api/collections` | 同事务创建不可变查询快照与持久运行记录，立即返回 `id`、`run_id`、`status_url`，状态码 202。 |
| `GET /api/collections/:id?after=0&limit=25` | 返回查询、运行、结果和已确认分页。`after` 是本站结果序号，非来源游标；`limit` 为 1–100。 |
| `GET /api/collections/:id/results/:resultId` | 当前查询中该对象最近 100 个观察版本；不混入其他查询或账号的观察。 |
| `POST /api/collections/:id/stop-requests` | 停止后续采集、递增 fencing token，已保存结果保留。 |
| `POST /api/collections/:id/resume` | 管理/操作人员显式恢复连接失败的查询，从原确认游标继续。 |

创建输入：`request_id`、`title`、`source_key`、`account_id`、单一 `targets`、`fields`、`purpose`、`mode`、`incremental_rule`、`max_records`、`max_pages`、`page_size`、`display_timezone`、`retention_days`、`scenario`。当前 `mode=TEST_ONLY`、`purpose=software_verification`、`incremental_rule=append_observations`；真实账号、其他来源和用途拒绝。来源执行只接受与查询相同的合成账号和目标。

字段允许集合为 `message`、`author_id`、`reaction_count`、`comment_count`、`created_time`。重复字段拒绝，未请求字段不入库。每个请求字段必须有明确状态：

- `VALUE`：实际值；字符串 `""` 与数值 `0` 均为明确值，不当作未知。
- `NULL`：来源明确返回空值。
- `NOT_RETURNED`：来源没有返回此字段。
- `HIDDEN`：合成来源明确声明字段隐藏；不能从普通缺失猜测为隐藏。

远端标识保持字符串，计数只接受安全范围内的非负整数。来源页必须匹配查询、账号、版本、当前游标与请求上限；链接限定本地合成来源。响应有大小限制，禁止重定向。来源字段和正文不作为操作指令使用。

重复 `request_id` 同体返回原查询，异体冲突。停止/恢复输入为 `request_id`、`expected_version`、`reason`，角色及同源检查与其他业务接口一致。游标循环、游标失效、输入或来源变化不能恢复旧游标；需要重新核对后创建新查询。来源连接失败允许显式恢复，已确认页不重做。

`returned_count` 统计已确认观察条数，`unique_count` 统计当前查询中不同对象，不能解释为客户人数。未知 `reported_total` 保持 `null`。`COMPLETED` 只表示此样本当前返回路径结束；数量/页数上限、游标异常和后续页失败为 `PARTIAL`。首个分页失败为 `FAILED`，不能显示为正常空结果。`CANCELED` 保留已有结果。

来源响应、观察版本、去重结果、分页证据和下一游标在同一数据库事务提交。30 秒领取租约使用递增 token；失去租约的旧执行者不能提交结果或失败状态。同一页同证据重放去重，不同证据冲突。结果分页按持久序号读取。较早观察保留历史，但不覆盖较晚观察的查询展示。

查询固定 1–30 天保留期。到期后接口立即隐藏观察内容，Worker 每分钟分批清理最多 1000 条到期观察及其结果关系，保留不含正文的查询/计数/分页摘要与清理审计。备份副本的到期和恢复流程属于后续完整运维验收。人工导入及导出已按 [独立文件合同](import-export.md) 接入；结果筛选与固定范围见 [精确目标快照](target-snapshots.md)。无真实平台采集、线索生成或联系授权。
