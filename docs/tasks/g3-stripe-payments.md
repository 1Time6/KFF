# TASK-094：第一阶段 Stripe 支付代码

基线提交 `918fb0a`，用户选择 Stripe 后依据 ADR-018、规划 7.7、TASK-094、ACC-27 实施。范围包括独立商户的单次托管 Checkout、原始回调签名与持久事件、服务器付款核验及运营页面，不改变 KFF 独立主数据决定。

新增第 16 个迁移 `20260912012250_g3_stripe_payments.sql`，已应用本机开发库及隔离测试库。连接固定组织、品牌、商户和 TEST/LIVE，数据库只保存凭据引用；私密配置另行绑定相同范围。支付请求固定订单快照、金额币种、提供方参数与幂等键，未知结果禁止另建或取消。原始回调经签名、模式、版本检查后，与共用入站记录同事务保存再确认。Worker 查询原 Session / PaymentIntent 核实后，同事务保存不可变凭据、订单付款状态、事件完成和审计。

正常 Worker 排除合成连接；测试驱动不能从浏览器启用。组织/品牌停止和连接暂停约束新的创建，已经提交的付款继续只读核对。测试凭据只产生 `VERIFIED_TEST_PAID`；客户和订单页面明确区分测试与真实付款。公共返回页不信任 URL 参数，也不显示客户或订单资料。

## 实际执行的本地检查

2026-09-12，全部 9 类检查通过，代码/配置在检查期间未变化；每类检查的来源清单为 166 个文件。共 **279 项测试**，没有失败、跳过或浏览器不稳定重试。当前检查点源码摘要为 `1296fe3e2a97959673d7998fb3768795b19ce5d0223e6d55514c2f89e28d8ce5`。检查运行器排除 Next.js 自动生成的 `next-env.d.ts`；最终源码摘要包含重启开发服务后生成的本机类型引用。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `node scripts/run-check.mjs typecheck` | 退出码 0 |
| 代码规则 | `node scripts/run-check.mjs lint` | 退出码 0 |
| 单元 | `node scripts/run-check.mjs unit` | 25 项通过 |
| 输入/提供方合同 | `node scripts/run-check.mjs contracts` | 38 项通过 |
| 隔离数据库集成 | `node scripts/run-check.mjs integration` | 182 项通过 |
| 执行器合成页面 | `node scripts/run-check.mjs fixtures` | 15 项通过 |
| 工作台浏览器 | `node scripts/run-check.mjs web` | 19 项通过 |
| 生产构建 | `node scripts/run-check.mjs build` | 退出码 0 |
| 独立端口生产冒烟 | `node scripts/run-check.mjs production` | 退出码 0 |

其中 Stripe 新增 4 项合同、16 项数据库集成及 1 项工作台流程。真实安装的 Stripe SDK 在本地 HTTP 服务验证请求路径、API 版本、整数金额、商品、元数据和相同幂等键；不访问 Stripe 网络。数据库测试包含创建响应丢失、并发重复事件和同支付对象、延迟付款及乱序失败、伪造/过期/未来签名、错误商户/模式/对象/金额/币种、数据库提交失败、查询故障、租约过期、暂停恢复、取消限制和 23 小时后未知请求禁止重做。

生产构建在端口 3001 完成运营鉴权、固定订单、支付队列、原始 HTTP 签名回调、重复收件、服务器对象核验和测试收入隔离。浏览器验证实际订单付款入口、刷新、取消隐藏、客户付款统计、匿名返回页及手机宽度；已查看 `output/playwright/stripe-test-payment.png`、`output/playwright/stripe-payment-mobile.png`。

过程中修正了组织只读表的提交锁权限关系：在切换到租户应用角色之前，仅锁定已知组织与品牌的停止状态，继续保持应用角色没有组织 UPDATE 权限。另修正创建后查询失败不能证明创建失败的边界，并验证保留原请求后可由原回调恢复核实，不能开放第二笔付款。没有修改已应用迁移。

正式记录见 `docs/evidence/g1-local-checkpoint.json` 和任务账本；私密过程回执、日志与隔离失败诊断库留在本机 `.kff`。历史 Facebook 合同证据已按当前代码刷新，真实 Facebook 测试仍按用户决定后置。

## 待用户配置与未验收范围

实际 Stripe 测试商户、API 密钥和 Webhook 签名密钥尚未配置；未进行真实 Stripe 网络调用、真实收银台测试、外部 Webhook 投递、密钥轮换或公网部署。下一步需要用户确认测试商户，按 `docs/api/stripe-payments.md` 与 `config/stripe-secrets.example.json` 在本机私密位置配置。密钥不进入聊天、代码或证据。

本次只标记 TASK-094 的本地代码范围 `DONE_SCOPED`。退款、交付、人工回复/接管、其他媒体/AI、设备、持续运行及完整项目仍未完成；不计 E2-MIN、G3 或完整交付。用户要求完整规划完成后才关机，当前不满足，没有执行或安排关机。

回滚先停止新的支付创建并保留在途查询能力；保留已应用迁移、订单快照、原支付请求和核验证据。结构修正用新迁移，不删除未知付款，不回退已核实状态。
