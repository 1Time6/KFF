# 模板版本接口

对应 TASK-057、规划第 7.5 节和 UI-08。当前仅覆盖本地合成主页与 Facebook 主页的身份读取、文本发布四种固定动作。Facebook 仍为候选实现，本地合同和模板允许状态均不构成真实平台通过。

所有接口使用现有登录会话、服务端组织/品牌作用域及 RLS。写接口要求同源请求；版本和策略仅管理员可改，预演允许操作员执行，查看允许只读角色。版本定义不可修改或删除，修改约束须派生新版本。

| 接口 | 请求与结果 |
| --- | --- |
| `GET /api/templates` | 返回当前品牌最近 200 个版本与最近 200 次预演。版本包含固定执行步骤、输入限制、摘要、允许状态和策略版本。 |
| `POST /api/templates` | `request_id`、`based_on_version_id`、`name`、`version_label`、`max_body_length`、`reason`。创建新编号的 `DRAFT` 版本。 |
| `POST /api/templates/:id/previews` | `request_id`、`account_id`、`environment_id`、`capability_id`、`body`。保存输入/关联检查；仅保存输入摘要。 |
| `POST /api/templates/:id/policy` | `request_id`、`expected_policy_version`、`action`、`reason`。`action` 为 `ALLOW`、`DISABLE` 或 `DEPRECATE`。 |

`request_id` 为 UUID。同键同体复用既有记录，不重复创建或覆盖后续策略；同键异体返回 `IDEMPOTENCY_CONFLICT`。策略版本过期返回 `VERSION_CONFLICT`。

预演不会创建任务、租约、命令、审批或试验许可，也不发外部请求。`can_enable` 仅表示输入与本地账号/动作/环境关联满足；账号当前状态和执行端在线情况单独列出。平台实际身份与执行授权固定为 `NOT_CHECKED`，结果明确包含 `external_calls: 0` 和 `execution_authorized: false`。允许派生版本须已有同版本、同摘要且 `can_enable=true` 的预演；实际执行仍复查全部门槛。

任务创建可提供 `template_version_id`，未提供则选择当前允许的最高版本号。任务保存完整模板定义、版本号与摘要；重复创建请求复用原任务，不随默认版本变化。审核绑定整个任务快照，Controller 和 Agent 均校验固定输入与摘要。界面中明确选择的版本若失效，须重新选择，不自动替换为另一个版本。

入队、派发与写动作的最终提交门槛复查模板允许状态。停用或弃用与最终提交使用同一版本行的互斥/共享锁协调，提交已获得许可时继续处理原结果；停用先完成时拒绝提交。`DEPRECATED` 不能重新允许。已有提交的回执、只读对账与人工裁定不要求恢复模板，不新增尝试。

历史无模板快照的任务可以读取，不能作为新任务执行；不会补写新的模板到历史快照。当前固定引擎拒绝任意脚本、URL、额外步骤和自动写入重试。通用 RPA 编辑器、第二平台及真实模板小流量验证在后续任务验收。
