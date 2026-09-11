# 结果筛选与精确目标快照

对应 TASK-053 与 TASK-052 的筛选子范围。沿用当前品牌的查询、对象身份及不可变观察；当前来源为合成页与人工导入。只形成任务准备输入及固定导出范围，`execution_authorized=false`。

| 接口 | 作用 |
| --- | --- |
| `GET /api/collections/:id?after=0&limit=25&filter=<URL 编码 JSON>` | 服务端过滤全部有效结果，返回 `filtered_count`、`page_after`、`page_hash` 与当前页。 |
| `POST /api/target-previews` | 固定所选对象和观察版本，返回 15 分钟内有效的预览；不晚于源数据到期。 |
| `POST /api/target-snapshots` | 明确确认纳入/排除数量及摘要后，保存不可变快照。 |
| `GET /api/collections/:id/target-snapshots` | 最近 100 个快照的状态、数量及摘要。 |
| `GET /api/target-snapshots/:id` | 固定对象、来源、观察版本、字段、用途及排除原因；到期正文隐藏。 |
| `POST /api/target-snapshots/:id/revoke` | 按版本及原因撤销，阻止后续使用；不能恢复。 |
| `POST /api/collections/:id/exports` | 可传 `target_snapshot_id` 导出原固定范围与观察，不能同时传 `result_ids`。 |

`filter` 为严格对象，条件同时满足：`id_prefix` 文本前缀、`message_contains` 不区分大小写的文字包含、`author_id` 字符串完全相等、`min_reactions` 非负整数或空、`field_states` 按已请求字段选择 `VALUE/NULL/NOT_RETURNED/HIDDEN`。缺失计数不满足“至少 0”；真实零满足。查询最多 1000 个有效对象，分页使用本站稳定序号，不使用来源游标。

预览输入为 `request_id`、`query_id`、`mode`、`filter`、`after`、`page_size`、`fields`、`purpose`，另按选择模式提供：

- `CURRENT_PAGE`：必须传所见结果页的 `page_hash`，固定 `after/page_size/filter` 对应的对象与观察。
- `MANUAL`：必须传唯一 `result_ids` 和一一对应的 `{result_id, observation_id}`，可跨页选择；对象不属于当前筛选、到期或观察已变化则拒绝，要求重新核对。
- `ALL_FILTERED`：在服务端使用本次筛选匹配的全部已保存有效结果；不以当前页代表全筛选。之后的新观察和新对象不能改变已生成预览。

保存输入为新的 `request_id`、`preview_id`、`preview_hash`、`title`、`confirmed_included_count` 和 `confirmed_excluded_count`。校验预览摘要与准确数量，保留来源摘要、来源计数、对象字符串 ID、观察 ID/版本、证据摘要、用途及到期时间。一个预览只保存一个快照；相同请求复用，异体冲突。导出直接使用冻结字段和观察，新增数据不会替换旧版本。

撤销输入为 `request_id`、`expected_version`、`reason`（5–300 字符）。导出持有快照共享锁，撤销与在途读取协调，撤销之后的新导出拒绝。到期立即隐藏定义；Worker 每分钟分别清理至多 100 个到期预览和快照正文，审计保留摘要及范围，不保留被清理正文。下载副本与备份生命周期仍由后续任务验收。

用途未获来源允许、字段未获来源允许时，预览明确排除并不复制正文。当前营销/客服选择还会标注缺少具体动作及联系资格验证，不能因有对象 ID 而执行联系。具体渠道资格和批次任务联调属于 TASK-060/068；快照保存不是这些动作的执行批准。

错误包括 `SELECTION_VIEW_CHANGED`、`PREVIEW_MISMATCH`、`INVALID_CONFIRMATION`、`IDEMPOTENCY_CONFLICT`、`TARGET_SNAPSHOT_REVOKED`、`RETENTION_EXPIRED`。品牌越权与未知 ID 按既有接口拒绝；查看者可读和导出，但不能预览、保存或撤销。
