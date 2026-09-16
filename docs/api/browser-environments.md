# 本地浏览器环境

当前目标及分阶段工作卡见 [本地矩阵执行](../tasks/local-matrix.md)。正式供应商为用户选择的 AdsPower；原生 Chromium 提供本机隔离和恢复基线。环境检查不授予 Facebook/Instagram 动作能力。Facebook 个人账号的检查会核实当前可见的操作身份，其他类型仍只检查浏览器配置。

## 本机设置

1. 启动 AdsPower，在 API 设置开启本地 API。KFF 默认连接 `http://127.0.0.1:50325`；不同端口通过 Agent 的 `KFF_ADSPOWER_ORIGIN` 设置。
2. 将 API Key 保存在本机 `.kff/adspower-api-key.txt`，只放 Key。也可使用 `KFF_ADSPOWER_API_KEY` 环境变量，环境变量优先。文件在每次环境操作启动前读取，不进入控制端命令、网页表格或诊断。`.kff` 不得提交。
3. 先在账号中心选择 Facebook 个人账号、Facebook 主页或 Instagram 专业账号；个人账号不填主页 API 凭据，再在 KFF `/environments` 创建绑定账号和 Agent 的环境，再保存 AdsPower Profile ID、登录账户 ID、实际操作身份、预期语言和时区。登录账户和操作身份可能不同，例如个人登录账户管理 Page。实际操作身份必须与 KFF 绑定账号 ID 一致。
4. 代理和底层指纹由 AdsPower 管理，KFF 不改写供应商文件，也不会替换供应商代理。已有外部窗口占用该 Profile 时拒绝接管。
5. “检查浏览器”通过 Agent 启动、连接、核对语言/时区并关闭。Facebook 个人账号显示“检查浏览器与身份”，还访问账号菜单中的 /me/ 入口，核对跳转后的个人主页数字 ID、编辑按钮、好友标签与名称；“打开登录窗口”在绑定电脑打开，窗口关闭或点击停止后回传关闭结果。命令最多保留 15 分钟。验证码、二次验证在本机处理。

原生环境目录由 Agent 生成，绑定记录和占用锁在 `.kff/browser-environments`，不使用日常浏览器的默认目录。原生代理只能使用 `KFF_BROWSER_PROXY_*` 引用，值为本机 JSON，例如 `{"server":"http://127.0.0.1:8080"}`。缺少引用、代理故障或配置无效时停止；不回退直连。

只读查询本机环境可运行 `node --import tsx scripts/adspower-inspect.ts`。可选参数是 API 的 `serial_number`（界面“编号”），不是可编辑的序号或名称。当前用户指定 **1876794**，对应名称 **sjpdl-SG**、API编号 **8**、Profile ID **`k1gvdtft`**，指定查询命令为 `node --import tsx scripts/adspower-inspect.ts 8`。当前选择及实机记录见 [Profile 证据](../evidence/adspower-selected-profile.json)。脚本只输出 ID、编号、名称和平台域名，不启动浏览器、不输出供应商返回的账号密码及代理凭据。KFF 执行始终使用 Profile ID。`PROVIDER_NETWORK_ERROR` 表示 AdsPower 返回服务端网络错误，不能据此声称环境不存在。

若界面可用但管理API持续返回网络错误，检查 AdsPower 是否继承了终端的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`。2026-09-12 实测正常退出空闲的 AdsPower 后，仅在其新进程中移除这些变量，管理API恢复并返回全部7个环境。`powershell -File scripts/start-adspower.ps1` 提供同样的启动方式，已有进程时不重启；不修改系统代理、全局环境变量或 Profile 代理。重启前保存并核对了管理程序配置副本。

停止响应可能早于实际关闭。驱动只对已核对的实例发送一次停止，随后以超过一秒的间隔查询；短暂限流不构成关闭证明。十秒观察期内仍未确认，或实例已变化，保留占用等待核验。该时间不包括单次HTTP请求自身的超时上限。

供应商通用“服务器/网络异常”并不一定是根因。2026-09-12 的195实机启动排查中，窗口进一步显示缺少 SunBrowser 150 内核；先按指定版本补齐依赖，禁止为了启动而随意改写环境版本、代理或指纹。优先使用 AdsPower 自身的下载机制。本次界面下载失败后，经用户授权，从官方版本接口取得对应安装包，校验官方MD5和可执行文件数字签名，再安装到原先不存在的150目录。此处保留195的历史故障记录；当前1876794已通过150内核启动、CDP连接及关闭验证，个人账号登录核验已接入当前 Agent 检查流程；最新实机结果见当前 Profile 证据，旧195的代理问题不再作为当前联调前置条件。

## 控制端接口

所有网页写操作需要当前品牌管理员、有效会话及匹配的 Origin。禁止在输入中添加脚本、Shell、文件路径、CDP 地址或凭据。

| 路径 | 内容 |
| --- | --- |
| GET `/api/browser-environments` | 环境配置与版本、Agent 在线情况、浏览器状态、最近控制命令 |
| POST `/api/environments/:id/configuration` | `expected_version` 和 `configuration`；保存后版本递增 |
| POST `/api/environments/:id/operations` | `CHECK` / `OPEN_LOGIN`、`expected_version`、UUID `request_id` |
| POST `/api/environments/:id/controls` | `STOP` / `DISABLE` / `ENABLE`、`expected_version` |

同一请求标识与相同内容返回原命令；同一个标识换操作被拒绝。运行或人工登录中禁止修改配置、禁用或重新占用。已配置浏览器的合成页面任务携带固定环境快照，经过现有 Task、审批、Worker、Agent 和 guardian 使用同一受管 Profile；原有 Graph API 通道继续保留。

## 资源和恢复

环境操作复用原 Agent 执行槽和账号/环境两把数据库资源锁。网页任务与环境操作互斥。新任务固定环境配置版本；旧版本在入队、分配及提交前被拒绝。

从 0.1.49 起，服务端在派发任务、Agent 领取任务、领取环境操作三个入口共同检查关闭状态。原任务即使已经 `DONE` 或 `EXPIRED`，只要 `quiesced_at` 为空，同一 Agent 的其他账号仍须等待；等待期间不会新增执行尝试。已下发但未领取的旧命令也受此限制。独立 Agent 的执行槽不受影响。

原关闭证明经 `recordQuiescence` 接收后，调度才可继续；账号或环境本身的隔离仍按原恢复流程处理。关闭证明不会把失败动作改成成功，也不会重发原动作。从未被 Agent 领取的取消命令使用控制端原有的未执行证明释放，不需要虚构浏览器关闭结果。

Agent 接单前保存命令日志；guardian 关闭浏览器后保存带 nonce 的关闭文件。断线只重传该结果，不重新执行已接收命令。心跳过期进入 `QUARANTINED`，保留数据库占用与本机文件锁。PID 消失或重新启动 Agent 不构成关闭证明。AdsPower 启动响应不明、控制连接变化或供应商未确认停止，均不能自动释放。

后台分别显示 Agent 在线、浏览器运行和环境检查时间。真实 Facebook 个人账号的 `CHECKED` 必须附带 `facebook-profile-dom-v1` 身份回执，包含当前数字 ID、名称、个人账号类型、来源网址和观察时间；结果必须匹配命令绑定且在浏览器关闭后提交。重新检查开始、检查失败、环境配置或启停版本变化均不会继续显示旧结果。打开登录窗口不代表已登录，身份核验不代表消息收发和采集能力已验收。

该模板只读取可见 DOM，不读取 Cookie、PIN、密码或页面隐藏状态。目前覆盖数字 ID 个人主页及中文/英文界面；找不到唯一自有身份、遇到登录验证或账号不符时返回阻止状态。核验的是会话已登录及当前操作身份，不宣称已辨认该会话背后的主登录账户或其管理的全部主页。

## 官方接口依据与未验收范围

AdsPower 使用官方 v1 [启动](https://localapi-doc-en.adspower.com/docs/FFMFMf)、[状态](https://localapi-doc-en.adspower.com/docs/YjFggL)、[停止](https://localapi-doc-en.adspower.com/docs/DXam94)接口，Bearer Key 用法见[官方代码示例](https://localapi-doc-en.adspower.com/docs/K4IsTq)。Playwright 连接方式参见 [CDP 与持久上下文](https://playwright.dev/docs/api/class-browsertype)。

AdsPower 服务响应成功、合同测试成功、受管 Chromium 实机测试成功，均不能替代正式 Profile 和 Facebook/Instagram 验收。真实网页采集模板、动作、浏览器 Inbox 入站同步和两账号销售闭环继续按工作卡推进。
