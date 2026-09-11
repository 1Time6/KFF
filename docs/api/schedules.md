# 计划规则与持久时点准备

对应 TASK-059、UI-10，复用品牌作用域和 Worker。当前只保存日历和准备记录，`execution_authorized=false`。没有因此创建任务、自动批准、占款或调用平台。逐目标任务绑定、预算、在途控制及实际定时执行仍由 TASK-060 和共同执行门槛接入。

| 接口 | 作用 |
| --- | --- |
| `POST /api/schedule-previews` | 保存规则与 UTC 日历，按可选模拟时间展示错过策略。 |
| `GET /api/schedules` | 当前品牌最近 100 个计划、规则版本、状态、时区及下一规则时点。 |
| `POST /api/schedules` | 按预览摘要保存初始暂停计划。 |
| `GET /api/schedules/:id` | 计划、不可变规则版本、最近 1000 个处理时点及所有版本汇总数量。 |
| `POST /api/schedules/:id/versions` | 暂停后，按新预览和状态版本调整规则。 |
| `POST /api/schedules/:id/controls` | 按状态版本暂停、恢复或终止未来准备。 |

预览输入为 `request_id`、`rule`、可选 `evaluate_at`（明确 UTC）。未指定模拟时间时采用数据库时钟。模拟结果不写成真实准备记录。预览 15 分钟有效，保存时核对 `preview_id`、`preview_hash`，客户端不能上传伪造的日历。

`rule` 全部字段明确保存：

| 字段 | 范围与含义 |
| --- | --- |
| `timezone` | 有效 IANA 名称，如 `Asia/Shanghai`、`America/New_York`、`UTC`；不接受裸数字偏移。 |
| `kind` | `ONCE`、`DAILY`、`WEEKLY`。 |
| `start_date/end_date/time` | ISO 当地日期和 `HH:mm`；2000–2099 年，包含首尾且最多 366 天；一次规则起止同日。 |
| `weekdays` | 每周规则必须填写唯一 ISO 星期 1–7；其他规则为空。 |
| `repeated_time` | `EARLIER/LATER/BOTH/SKIP`，重复时刻保留所选实际 UTC 点；两次分别记录。 |
| `missing_time` | `SKIP/SHIFT_FORWARD`；后移按实际变化量处理，可能为半小时或整日，不固定一小时。 |
| `missed_policy` | `SKIP/DEFER_LATEST/CATCH_UP`。延后仅选择最近一次，其余明确跳过；补准备从较早时点开始。 |
| `catch_up_limit` | 1–10；一次恢复处理全部到期积压，仅保留上限内时点，超限不会在下一轮补满。 |
| `spacing_seconds` | 60–86400；最早可用时间不得挤在同一瞬间，并考虑此前已保留的间隔。 |
| `late_tolerance_seconds` | 0–3600；容限内视为正常延迟，真实零有效。 |
| `maximum_lateness_seconds` | 60–604800，且不小于正常容限；超过最迟准备时间则跳过，排定间隔也不能越过期限。 |

保存输入为 `request_id`、`preview_id`、`preview_hash`、`title`。调整版本另带 `expected_version`、`reason`。控制输入为 `request_id`、`expected_version`、`action=PAUSE/RESUME/STOP`、`reason`。理由 5–300 字符。查看者只读；同键同内容复用，异体冲突。

暂停不丢游标，不删除已处理时点。恢复使用原策略处理错过的尚未处理时点。新版本需先暂停，取消旧版本尚未绑定任务的准备记录，保留旧 UTC 日历和处理证据，新版本仍为暂停。终止不可恢复，取消待建任务记录并阻止后续准备；当前没有平台在途动作。

Worker 以数据库行锁领取一个到期计划，完整到期集合的准备/跳过记录和游标在同一事务提交。`version_id + slot_index/slot_key` 唯一；提交前进程终止全部回滚，提交后终止重启不再生成同一时点。状态 `READY_FOR_TASK` 只表示时间规则满足，不能当作任务审核或执行授权。`SKIPPED` 和 `CANCELED` 单列；`COMPLETED` 表示有限日历已经处理完毕，不表示任务成功。

日历保存当地时间、实际偏移、UTC 点、缺失/重复原因、规则摘要及 ICU/IANA 数据版本。运行环境时区数据改变时暂停准备，要求新预览与版本；不静默重解释旧日历。当前边界不覆盖任意 cron、无限期或按秒重复规则，也不替代完整调度与真实验收。
