# 原动作人工裁定

`POST /api/runs/{run_id}/adjudications`。品牌管理员权限，服务端确定组织与品牌，同源写入检查和严格 JSON 校验。只接受 `UNKNOWN_OUTCOME` 或 `NEEDS_HUMAN` 的当前动作。读取 `GET /api/runs/{run_id}` 可取得当前 `adjudication_version` 与按版本排列的裁定记录。

字段：`request_id`、`snapshot_hash`、`expected_version`、`expected_state`、`decision`、`evidence`、`reason`、`confirmation=I_REVIEWED_THIS_ORIGINAL_ACTION`。首次裁定版本为 0；成功后递增。同一请求重复返回原裁定事件，读取详情取得最新状态。

| decision | 要求和投影 |
| --- | --- |
| `INCONCLUSIVE` | 明确证据不足，不能声称已匹配最终结果；投影为 `NEEDS_HUMAN`，保持未决 |
| `CONFIRMED_SUCCESS` | 匹配的远端对象、实际账号、内容与原提交关联；写动作有持久提交意图；投影为 `VERIFIED_SUCCEEDED`，证据类型为人工复核 |
| `CONFIRMED_FAILURE` | 原提交的最终平台拒绝或取消，不能以未查到为依据；投影为 `VERIFIED_FAILED`，证据类型为人工复核 |

`evidence` 字段：

- `source`：`platform_ui`、`platform_support` 或 `owned_fixture`，后者只用于合成任务。
- `external_account_id`、`content_hash`：必须与原快照一致。
- `remote_id`：已核查对象；成功时必填，类型应符合当前主页动作。未决或最终拒绝没有对象时可以为空。
- `observed_at`：核查时间，应在动作创建之后，不超过允许的时钟偏差。
- `reference`：平台记录、书面结论或受控证据的出处，存储引用，不自动抓取任意 URL。
- `failure_basis`：仅失败时填写 `FINAL_PLATFORM_REJECTION` 或 `FINAL_PLATFORM_CANCELLATION`；其他结论为空。
- `matched_original_submission`：最终结论必须为真，证据不足必须为假。

最终裁定前要求全部旧命令终止且关闭确认齐全。状态和事件在同一事务提交；迟到的旧回执不会覆盖人工来源。`human_review` 不作为自动 Graph 身份核验或平台能力晋升证据。费用、隔离解除、未来新动作仍需各自门槛，裁定没有自动重试副作用。

错误包括 `VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`APPROVAL_STALE`、`ACCOUNT_MISMATCH`、`GUARDIAN_UNCONFIRMED`、`SUBMISSION_UNCERTAIN` 与 `FORBIDDEN_SCOPE`。非法字段、把未查到用作最终失败等输入返回 `INVALID_INPUT`。
