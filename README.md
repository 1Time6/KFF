# KFF 运营工作台

依据《项目规划.md》v2.1 实施。当前代码在建设 G1 的本地执行闭环与 Facebook 主页接口合同；完整项目尚未交付，真实 Facebook 和设备验收尚未进行。

## 本机运行

需要 Node.js 22 或更新版本、pnpm 11。当前验证环境为 Windows、Node.js 24.14.0、原生 PostgreSQL 17.7。

```powershell
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

访问 http://127.0.0.1:3000 。随机开发账号保存在 `.kff/本地登录.txt`。开发启动器初始化项目专用数据库、迁移、合成账号及环境，并启动 Web、Worker、Agent 和本地验证页。数据库和本地文件跨重启保留。前台运行时按 Ctrl+C 停止本次启动的服务。

`.kff` 包含本机私有配置、数据库、浏览器独立目录和执行日志，不得提交或共享。Agent 使用单独的配对文件，只从已审核的凭据引用读取平台令牌，不接收数据库凭据。环境页可登记 Agent、下载一次配对配置并排空或撤销；远程宿主实际联调和系统级身份隔离仍待实施。

## 日常操作

1. 登录，在任务工作台创建本地验证任务。
2. 核对账号、动作、内容版本并审核，再点执行。
3. 在运行记录查看实际结果。出现未知结果时，使用“核验原提交”；核实原动作且执行器确认旧上下文关闭后，才允许解除环境隔离。
4. 诊断默认不包含正文、Cookie、截图或 Trace。管理员下载时由服务端检查内容并登记审计。
5. 组织、品牌和账号停止开关会拒绝后续提交；已进入提交的动作继续核验并显示在途数量。Agent 排空保留配对，撤销后的令牌不能恢复。
6. 账号页“管理联系依据”可登记目标、来源、用途和显式窗口，记录退出或撤销依据。退出后旧依据失效，恢复需要退出之后的新明确同意。当前入口不发送消息；具体渠道动作仍待接入。
7. 能力与验证页可按币种登记预算、精度和依据，查看动作预占与待核账项。动作结束并确认执行上下文关闭后，管理员可按实际账单结算、确认零费用释放，或登记差异调整；调整填写更正后的总额。未知费用继续占用预算，试验次数不因费用释放而退回。

Facebook 账号可先登记 Page ID 和凭据引用。合同测试通过后运行 `node scripts/run-check.mjs contracts`、`pnpm evidence:register`，再在能力页登记当前实现的本地合同证据。先登记试验币种预算，再为明确账号和动作创建、审核任务，在任务详情填写一次试验许可；费用未知时不能用零代替。写入许可还要求同一凭据版本已有真实只读成功证据。

真实执行默认禁用；不得以本地测试结果宣称真实平台可用。Graph API 版本和主页令牌均需显式配置，真实只读、发布许可及生产放行分别核验。目前不配置真实账号也可继续开发和运行合成测试。

## 检查命令

```powershell
pnpm verify:planning
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contracts
pnpm test:integration
pnpm test:fixtures
pnpm test:ui
pnpm build
```

先在另一个终端保持 `pnpm dev` 运行，再运行集成和浏览器测试。集成测试在本地 PostgreSQL 创建独立的随机测试数据库，成功后删除该测试库，失败时保留供诊断；不会清空开发库。浏览器测试只操作本项目合成页面，在开发库留下可检查的合成任务。它们不会调用 Facebook。

终端进程回执异常时，可使用 `node scripts/run-check.mjs <typecheck|lint|unit|contracts|integration|fixtures|web|build>`。真实进程退出码、时间及日志保存在 `.kff/checks`。

生产构建放在 `apps/web/.next-production`，与开发缓存分开。`pnpm start` 启动生产 Web；生产数据库、身份服务、独立 Worker/Agent 和部署验收均需按规划配置，目前未部署。

## 实施记录

- `docs/discovery.md`：初始只读盘点和资料缺口，历史暂停已由后续用户指令调整。
- `docs/architecture-decisions.md`：架构、接口来源和当前选择。
- `docs/tasks/ledger.json`：全部 134 项任务，保留未完成和待真实验收的范围。
- `docs/evidence`：实际检查摘要及适用范围。没有证据的关口不计通过。

关机条件仍是原规划全部约定内容完成、验证并保存；局部实现或本地测试通过不满足此条件。
