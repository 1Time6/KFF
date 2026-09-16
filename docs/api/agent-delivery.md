# Windows 本地 Agent 交付

`pnpm agent:package` 从当前已安装的锁定依赖生成 `dist/kff-agent-版本-win32-x64-摘要.zip`、SHA-256 文件和同名目录。包内带本机 Node、TSX、Playwright 库及执行源码；只适用于 Windows x64。构建命令拒绝覆盖同名版本。包内没有 `.kff`、配对令牌、数据库、浏览器登录数据或 AdsPower Key。

当前构建使用 Node 24.14.1，并保留对应的[官方许可](https://raw.githubusercontent.com/nodejs/node/v24.14.1/LICENSE)及依赖包许可。构建不下载程序依赖；更换 Node 版本时必须先加入该版本官方许可文件 `scripts/licenses/node-v版本.txt`。

0.1.3 保留已在 1876794 验证的个人身份检查、公开关键词搜索、指定帖子评论和 Messenger 来信读取，并加入单条人工回复模板。读取验收已有真实两条消息及重复读取去重证据；人工回复目前通过代码、隔离数据库和自有 DOM 验证，尚未取得真实发送回执。回复须关联当前来信的同意记录及单次许可，结果未知时不重发。程序包升级不会自动启用监控或发送。包内保留完整和压缩两种关闭证明的读取支持；完整控制端安装仍待交付。

这是独立 Agent 包，控制端 Web、Worker、数据库及 AdsPower 需要另行运行。校验文件用于检查传输和文件完整性，不代表发布者数字签名。应从可信发布渠道取得压缩包及摘要。

## 首次使用

1. 解压到程序目录，例如 `C:\KFF-Agent\releases\版本目录`。保留整个目录结构。
2. 创建独立数据目录，例如 `C:\KFF-Agent-Data\.kff`。从控制端下载的 Agent 配对文件保存为该目录内的 `agent-config.json`。配对信息只放在数据目录。
3. 在程序目录运行 `agent.cmd verify`，再运行 `agent.cmd start --data-root C:\KFF-Agent-Data`。窗口用于显示该 Agent 的运行状态；关闭前先在控制端停用新任务并等当前任务完成。
4. 使用本地 Chromium 环境时，首次运行 `agent.cmd install-browser` 下载匹配内核。使用 AdsPower 时运行已安装的 AdsPower，将其 Local API Key 保存到数据目录的 `.kff\adspower-api-key.txt`，通过控制端选择并绑定正确的 Profile。安装库不能代替平台登录或身份验证。

也可直接运行包内 `node.exe agent-launch.mjs start --data-root C:\KFF-Agent-Data`。多配对文件可用 `--config .kff\pairings\second.json`，路径相对于数据目录；同一 Agent 配对始终共用同一回执日志和进程锁，不能重复启动。

## 更新与恢复

停止分派新任务，等待当前命令回执和浏览器关闭证明，再关闭旧 Agent。解压新版本到另一个程序目录，执行校验，用**同一个绝对数据目录和同一个配对文件**启动新版本。不要复制程序覆盖正在运行的目录，也不要用旧备份覆盖数据。

程序启动沿用既有配对、`.kff\browser-environments`、Agent 日志及 guardian 关闭证明。遇到未收到确认的回执时，由原 Agent 恢复流程重试同一回执，不会为同一命令再次提交。程序包启动不会迁移或清空数据库。

如需回退程序，应先核对版本的 Agent/guardian 协议及日志兼容说明；日志恢复的验收范围必须对应具体旧、新压缩包及实际运行结果，不能从同版换目录推断跨版本兼容，也不能从某一版本对通过推断任意历史版本都可读取新日志。缺少关闭证明的环境继续保持隔离，不能通过删除日志、锁文件或浏览器目录强行恢复。

`data-root` 必须位于程序目录之外。程序启动会完整校验包内文件，随后使用指定配对；继承的开发环境 Token、控制端地址和配对文件覆盖项不会更换指定身份。AdsPower、真实平台账号、真实消息发送与 WhatsApp 接收仍需分别验收。
