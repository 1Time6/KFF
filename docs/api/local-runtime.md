# 本机整套服务启停

当前工作目录已有数据库、登录配置及 Agent 配对时，可使用根目录的 `KFF-Start.cmd`、`KFF-Status.cmd`、`KFF-Stop.cmd`。启动会打开获客工作台；后台进程隐藏运行。也可以运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-runtime.ps1 -Action Start|Status|Stop`，每次选择一个 Action。

启动器使用经过构建检查的 Next 生产版本、原 Worker 和安装目录内经过校验的 Agent。它保留原数据库与 `.kff` 配对，不执行迁移或 seed。重复启动返回当前宿主，不增加第二个 Agent。读取、收件和发送开关来自 `.kff/local-runtime.json`；配置时默认关闭真实发送。已有明确授权的真实任务需要使用 `configure --live` 后启动；开关只允许原任务进入执行，账号资格、审批、联系依据、任务版本和单次发送许可仍逐项校验。完成限定测试后，停止并重新 configure（省略 `--live`）即可恢复只读运行。

更新前先正常停止。完成 `node scripts/run-check.mjs build`，生成并校验独立 Agent 安装包，然后使用 `node --import tsx scripts/local-runtime.ts configure --agent-release <安装目录绝对路径> --discovery --inbox` 保存配置。源码或已准备的生产构建不一致会拒绝启动。历史 Agent 安装目录保留，不能通过恢复旧数据库覆盖当前业务记录。

停止顺序是 Worker 完成本轮调度 → Agent 完成已领取任务及原回执确认 → 关闭 Web → 关闭本次宿主自己启动的数据库。已由外部进程启动的数据库保持运行。丢失回执确认时 Agent 保留原日志与关闭证明，停止会等待原确认；超时提示不强杀浏览器，也不重新发送任务。`.kff/local-runtime` 保存本次宿主及各组件日志；控制令牌仅用于本机命名管道，不放进网页。

Windows 上的数据库冷启动只使用已存在的 PostgreSQL 17 目录，并核对实际目录和端口。正式启动器不初始化数据库；初始化仍属于原 `scripts/database.ts` 入口。两条 Windows 路径现在都通过 `pg_ctl stop -m fast -w` 正常停库，替代依赖库原有的强制结束进程方式。停止前核对原 PID、启动时间、目录和端口，停止后确认 PID 文件消失及服务退出；实例变化或等待超时会保留状态供检查。PostgreSQL 的 fast 模式会回滚未完成事务并正常关闭，区别于 immediate 模式的直接中止，见[官方说明](https://www.postgresql.org/docs/17/app-pg-ctl.html)。

2026-09-13 已对原运行库完成冷启动 → 正常停止 → 第二次冷启动。停库后复制的18,191个文件共429,986,900字节，两种校验方式逐文件确认SHA-256一致；每次重启后92张表与原摘要相同，仅排除Agent心跳时间，四份原配置及176个Agent文件也不变。两项独立PostgreSQL进程测试覆盖未初始化目录拒绝、重复启动拒绝、未提交事务回滚、已提交记录保留，以及原初始化入口使用相同停库流程。此处没有执行整机重启或将备份恢复到运行库。

`RUNNING` 表示本次 Web 健康标识匹配，Worker 和 Agent 已通过本机 IPC 确认启动。实际平台可用性还需检查原任务回执。`DEGRADED` 表示组件退出，可使用 `KFF-Recover.cmd` 或 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-runtime.ps1 -Action Recover`。恢复再次校验当前构建、Agent 安装包及已通过的数据库检查，只替换进程句柄已确认退出的组件；存活但健康检查失败的进程保留，不能强清锁。正常组件和原配对、回执不变。

若停止正在等待原回执且 Web 已退出，恢复入口可先恢复 Web，让原确认继续完成。若宿主本身异常退出，Web 观察 IPC 断开后退出，Worker 完成本轮，Agent 按既有停止/guardian 关闭流程保留原日志；确认旧进程全部退出后使用启动入口。新宿主保留上一份状态文件，等待旧组件退出，不因为超时就强杀或占用旧 Profile。`STOP_BLOCKED` 或 `CONTROL_UNAVAILABLE` 应先查看具体错误；尚存活的宿主无法响应时不能直接再启一套。

2026-09-13 已验证 0.1.6 的本机启动、重复启动、正常停止及再次启动；Worker、Agent 返回 DRAINED 后退出 0，重启前后既有业务表与配对配置一致。重启后的 Agent 通过原环境命令核验 1876794 身份并取得匹配的本机/数据库关闭证明。隔离测试另验证回执确认丢失时等待原确认、无新增接单，以及实际 Worker 的 IPC 退出。

2026-09-13 追加实机故障验证：在原系统空闲时分别终止本次宿主拥有的 Web、Worker、Agent，恢复入口仅替换故障组件；再终止宿主，三个子进程全部退出后重新启动。六张既有业务表、原配对及 176 个 Agent 日志/关闭文件逐项不变。3 项隔离进程测试覆盖正常 drain、丢失回执确认后的父进程断开与原日志恢复、Worker IPC 退出。实机故障注入发生于空闲状态，不能扩称为真实消息发送中断验收。

本机独立安装目录已验证首次初始化、登录启动及 0.1.23 → 0.1.26 停机升级，当前 0.1.37 也已生成完整控制端包，见[完整控制端交付](controller-delivery.md)、[独立安装证据](../evidence/controller-delivery-20260914.json)和[当前交付包证据](../evidence/profile10-037-release-20260914.json)。这些结果不能替代另一台干净电脑、Windows 登录后自动启动、整机重启或断电恢复验收；当前没有配置开机自启。AdsPower 及其原有网络配置仍需处于可用状态。

## AdsPower 启动入口

如果已安装 AdsPower，可先双击根目录 `KFF-AdsPower-Start.cmd`，再启动 KFF。该入口只在管理程序未运行时启动；已有进程会被保留，不会强制重启或关闭 Profile。

本机曾出现 AdsPower 的旧网络库通过终端 `HTTPS_PROXY` 访问其控制服务器时返回 HTTP 400。此入口仅为新建的 AdsPower 进程追加 `NO_PROXY=api-global.adspower.net`；Windows 系统变量、各 Profile 保存的代理和 API Key 保持原值。输出保存到 `.kff/adspower-manager/`，防止终端退出后管道关闭造成 Electron `EPIPE`。启动进程不等于平台可用，须以原 Agent 的身份和业务读取结果为准。

若已运行的管理程序仍有该连接错误，请在全部 Profile 和 KFF 原任务关闭后正常退出 AdsPower，再使用这个入口。它不是开机自启，也不会替正在使用环境的操作者重启程序。回滚时可恢复 `.kff/changes/adspower-launcher-20260914/start-adspower.before.ps1`；不需要恢复数据库或改任何帐号代理。

证据见 [正常启停](../evidence/local-runtime.json)、[故障恢复](../evidence/local-runtime-recovery.json) 与 [数据库冷启动](../evidence/database-coldstart.json)。
