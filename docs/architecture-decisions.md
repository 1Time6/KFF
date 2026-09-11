# KFF 实施决定

## ADR-001：按用户新指令先实现，Facebook 首发

2026-09-12 用户明确指定 Facebook，并要求先编写再考虑真实测试。此前 discovery.md 中的暂停记录保留为历史；附件缺失、测试账号和设备条件不再阻止可独立完成的工程实现。真实能力、平台许可和完整签收仍需单独证据。

首切片采用第 8、22、28 节的 TypeScript / Next.js / Postgres / 独立 Worker / 本地 Agent。先实现自有主页读取与文本发布的接口合同，以及本项目合成页面上的浏览器闭环。个人账号、小组、评论、消息、其他平台和设备不继承主页能力。

## ADR-002：真实 Postgres 与原子投递

本机无可调用 Docker。开发使用项目目录内的 embedded-postgres（原生 PostgreSQL），保持生产 Postgres SQL、事务和锁语义。开发数据库绑定 127.0.0.1，随机凭据仅存 .kff。生产通过 DATABASE_URL 接现有 Postgres/Supabase，不自动新建云资源。

任务、不可变批准摘要、动作和持久作业在同一事务写入，以同库原子入队消除跨系统双写。Worker 使用 FOR UPDATE SKIP LOCKED 领取，资源租约带递增 fencing token。提交后失联保留未知结果及资源隔离，不盲目重发。

## ADR-003：身份和主数据

当前 KFF 没有可复用应用代码；先建立本仓库最小实体和合同，其他项目主数据连接保留适配边界，未声明其他项目不存在。开发提供仅限回环地址的本地账号；生产身份通过 Supabase 验证。业务对象具有组织/品牌复合外键、服务端权限检查及 RLS。

## ADR-004：能力证据与实现模式

本地合成浏览器与 Facebook Graph API 分别登记。真实执行默认禁用；启用仍需对应账号、目标、模板版本、许可窗口和次数。真实测试推迟不等于真实验收通过。Meta 文档本轮网页工具返回 429，后续核对官方其他入口；不得因此猜测当前账号资格。

资料：主规划第 8、9、22、27、29 节；[Next.js 安装](https://nextjs.org/docs/app/getting-started/installation)、[embedded-postgres](https://github.com/leinelissen/embedded-postgres)。原生 Windows 依赖实际固定为 PostgreSQL 17.7，未采用没有可下载 Windows 二进制的 18.4 包。

## ADR-005：Facebook 合同依据与限制

Meta 文档站多次返回 429，实际读取的官方备用来源为 Meta 的 [Postman Facebook 集合](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)、[Node Business SDK Page 源码](https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/objects/page.js) 和 [Post 源码](https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/objects/post.js)。集合使用 Page Access Token 表示主页，并有 `/me/video_reels` 示例；SDK 定义 `/feed` 以及 `id`、`from`、`message`、`permalink_url`、`is_published` 字段。

据这些合同和 Graph 节点别名规则，实现候选主页身份预检 `/me?fields=id,name`，核对令牌实际身份后才允许进入文本发布入口。`POST /{page-id}/feed` 只调用一次，随后按返回对象 ID 回读作者、正文摘要及已发布标志。合同测试使用虚构版本 v99.0 和注入的响应，不联网；正式版本必须配置并在真实只读试验中核验。官方集合的历史样例不作为当前权限、应用审核、地区、账号条件或新媒体规格的承诺。

## ADR-006：许可、版本和恢复

本地合同报告记录被检查源码的摘要。能力页只能登记与当前源码匹配的报告，不能由前端直接改为真实通过。已审核任务固化实现摘要；服务端和 Agent 均校验，源码改变后旧真实许可不可复用。

首次许可绑定单条任务、账号、主页、动作、内容、版本、时间窗口、一次提交和明确费用上限。只读试验在领取前预占，写入在持久提交意图事务中预占；未知或失败停止该许可，次数不自动返还。预占不是实际费用或收入，当前尚无真实成本结算证据。

未知结果只允许核验既有提交。合成页按稳定 action_id 回读；未找到或多条结果保留未知。结果核实后仍需 Agent 证明旧上下文关闭才解除隔离。当前真实 Facebook 未知结果的操作入口、人工裁定、远程配对和生产晋升仍待补齐。

## ADR-007：测试与构建隔离

集成测试新建随机、独立数据库；浏览器执行器测试使用专用 profile；工作台测试在开发库留下明确标注的合成任务。浏览器测试要求已有开发服务，避免在服务重载瞬间启动重复 Worker/Agent。开发缓存为 `.next`，生产构建为 `.next-production`，不共享输出目录。部署跟踪排除运行时路径；生产包未包含 `.kff` 配置、数据库或日志。
