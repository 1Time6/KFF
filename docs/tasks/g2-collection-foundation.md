# TASK-047 / 049 / 050 采集公共合同与分页一致性

基线 `53bebda`，145 项本地测试。按用户“Facebook 优先、先写代码、真实测试后置”的指令，先实现采集公共合同、观察版本、身份去重和分页恢复。本子范围只连接本项目明确标识的合成主页数据源，不以它替代 TASK-048 的真实来源验收。

查询固定来源版本、账号与目标、允许字段、用途、数量/页数上限、显示时区和保留期。字段分别记录实际值（包括空字符串与零）、空值、未返回与隐藏。分页响应、观察记录、去重结果与下一游标在同一事务提交，租约 token 拒绝过期工作者回写，提交前进程失败从上一确认页恢复。

界面区分空结果、部分结果、失败、停止和来源已遍历；覆盖仅限此合成样本，未知总量不显示为零或全量覆盖。观察只表示来源数据，不创建客户、不判断联系资格、不生成发送授权。Excel/CSV、目标转任务、真实采集、新对象和客户主数据在后续对应范围实施。

要求验证：前导零和长 ID、同名不同对象、缺字段/隐藏/空值/真实零、跨页重复与新旧观察、并发提交、提交前后进程终止、过期租约、游标循环/过期、空页继续、数量/页数上限、来源错误和品牌隔离。

已实现 `packages/contracts/src/collection.ts`、`packages/core/src/collections.ts`、`packages/adapters/src/collection-fixture.ts`，新增 `collection_queries/runs/pages/objects/observations/results/events`。查询创建与队列状态同库原子保存，Worker 执行分页并定期清理到期观察。界面位于 `/collections`，同时提供查询配置、进度、结果与观察历史；完整 UI-04 导入导出/筛选/结果转任务仍未完成。

专项测试包含 4 项合同、19 项隔离数据库与 1 项浏览器流程；数据库测试实际终止分页提交前/后的进程，并验证保留期清理、跨查询关系与账号身份边界。完整回归数与退出码见 `docs/evidence/g1-local-checkpoint.json`。截图 `output/playwright/collection-observations.png`、`output/playwright/collection-mobile.png` 均为合成数据。
