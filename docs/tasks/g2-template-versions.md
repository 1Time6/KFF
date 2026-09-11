# TASK-057 模板版本与弃用子范围

基线：`3c0f7a3`，128 项本地测试。首平台仍为 Facebook，真实测试后置。按照第 7.5 节和 UI-08，补齐当前四种主页动作的版本、允许集合、预演与弃用管理。

实现范围：固定代码支持的模板合同和确定步骤、不可变配置版本、任务中固定版本/摘要、允许或停用/弃用的版本集合、只检查输入与本地账号/环境条件的预演。预演不连接平台、不申请发布许可、不产生发送或发布；外部身份与权限显示尚未验证。新版本从现有固定动作派生，只能设置已支持的输入约束，不接收脚本、任意 URL 或自定义执行代码。

任务创建可以明确选择允许版本，默认选择当前允许的最新版本。修改模板创建新版本，不改旧任务摘要。停用/弃用阻止新执行及提交门槛，已进入提交阶段的结果继续核验。历史没有模板快照的任务不自动迁移为新模板，不能据此新发动作；原日志、对账和人工裁定关系保留。

验证：同一版本不可改、并发创建/策略幂等、已批准任务不漂移、预演无外部调用、当前输入限制在 Controller 与 Agent 同时检查、停用和提交竞争、弃用保留原对账。既有故障样本继续回归。任意流程编辑器、第二平台/新动作和真实模板版本试验不计本次完成。

交付代码：`packages/contracts/src/template.ts`、`packages/core/src/templates.ts`、`packages/adapters/src/templates.ts`、`apps/web/components/template-workbench.tsx`；接口说明见 `docs/api/templates.md`，决策见 ADR-012。

新增专项样本：13 项数据库集成、3 项合同和 1 项浏览器流程。完整回归的实际命令、退出码和总数由 `docs/evidence/g1-local-checkpoint.json` 登记。页面同时检查桌面与 390 像素视口，截图位于 `output/playwright/template-deprecated.png` 与 `output/playwright/template-mobile.png`。
