# 联系依据接口

全部端点沿用登录会话、服务端组织/品牌上下文、同源写入和 RLS。管理员登记/撤销依据，操作员也可登记目标和退出，只读角色不能修改。接口不会调用外部消息平台。

| 方法与路径 | 内容 |
| --- | --- |
| GET `/api/contacts` | 最近 200 条目标及 200 条依据，品牌内可见；不是全量导出 |
| POST `/api/contacts` | `account_id`、`channel`、字符串 `remote_id`；同账号/渠道/标识去重 |
| POST `/api/contacts/permissions` | `target_id`、UUID `request_id`、`resume_opt_out`、`policy`；同请求同体复用 |
| POST `/api/contacts/eligibility` | `target_id`、`permission_id`、`purpose`；返回原因及不可变选择字段 |
| POST `/api/contacts/{id}/exit` | UUID `request_id`、`expected_version`、`reason`；旧选择随版本失效 |
| POST `/api/contacts/permissions/{id}/revoke` | `reason`；撤销单条依据，不删除历史 |

`policy` 的类型见 `packages/contracts/src/contact.ts`。时间均为带时区的 ISO 时间。来源为主动咨询或明确同意，分别保存出处、发生时间、用途确认状态、规则版本、说明和有效期。窗口有明确终点、不要求窗口（必须有真实规则依据）和未知三种状态；主动咨询仅用于明确窗口内客户服务。没有固定 24 小时假设。

`basis_eligible=true` 只表示此时的依据记录满足，`execution_authorized` 固定为 false。后续具体消息动作将 `selection` 放入批准快照，并在共同提交事务中调用 `assertContactBasisAtSubmission`；该事务还须核对对应平台能力、账号版本、组织停止锁、批准、预算、会话控制权和资源租约。不能由调用者跳过共同内核直接执行发送。

当前工作台入口为账号页“管理联系依据”。只展示最近记录，历史和批量采集扩展另行验收。所有本地检查仅使用合成身份。
