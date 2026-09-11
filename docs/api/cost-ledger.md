# 单槽费用接口

范围：TASK-061 当前基础；全部接口使用当前登录用户的服务端组织、品牌和角色。写接口沿用同源检查、JSON 大小限制及严格字段校验。金额为非负整数字符串，最多 15 位，避免浮点舍入。

| 接口 | 权限与行为 |
| --- | --- |
| `GET /api/costs` | 当前品牌成员读取分币种的全部余额、最近 200 条动作费用及最近 200 条费用事件 |
| `POST /api/cost-budgets` | 管理员登记或修改币种预算，`request_id` 去重，`expected_version` 并发控制；首次版本为 0 |
| `POST /api/costs/{action_id}/reconciliation` | 管理员记录待核账、结算、零费用释放或差异调整；动作和事件必须属于当前品牌 |

预算字段：`request_id`、`expected_version`、`currency`、`minor_unit_exponent`、`precision_source`、`limit_minor`、`reason`。精度 0–6，已有币种的精度不可改。预算不能调低到已有预占与确认费用之下。

核账字段：`request_id`、`expected_version`、`decision`、`actual_cost_minor`、`evidence_ref`、`note`、`confirmation=I_RECONCILED_THIS_COST`。

| decision | 实际金额 | 效果 |
| --- | --- | --- |
| `PENDING` | 必须为 `null` | 保持完整预占和未知费用 |
| `SETTLE` | 已核查的总额字符串 | 用确认费用替代预占 |
| `RELEASE` | 必须为 `"0"` | 有零费用依据时释放预占 |
| `ADJUST` | 更正后的总额字符串 | 仅对已经结算或释放的费用作差异调整 |

后三种要求动作不在途，且全部旧命令均有关闭记录。请求成功并不表示实际支付或执行成功。后续调整不会被旧请求重放覆盖；旧请求返回其原事件结果，应通过读取接口取得当前记录。

可能拒绝：`BUDGET_UNCONFIGURED`、`BUDGET_EXCEEDED`、`BUDGET_BELOW_COMMITMENTS`、`CURRENCY_PRECISION_CONFLICT`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`COST_ACTION_IN_FLIGHT`、`GUARDIAN_UNCONFIRMED`、`INVALID_COST_TRANSITION`、`COST_ALREADY_FINAL`。核心函数复用预占时重新检查预算，已经核账的动作不能重新预占或自动重试。

台账与试验计数分开：释放费用不会减少 `pilot_permits.reserved_actions` 或试验最大费用的累计预占。当前真实账单、自动费用回调、批次/多品牌公平调度另行实施。旧试验预占的迁移逻辑将实际费用保留为空并登记待核账；旧数据实样升级尚未纳入当前通过范围。
