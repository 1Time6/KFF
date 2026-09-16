# KFF → DeepSeek 开发交接（0.1.51 → 0.1.52 → 0.1.53）

更新时间：2026-09-16 中午（DeepSeek 接手后第二轮推进：用户补充指令 → 局部异常隔离与只读读取路径 → 本地回归全通过；真实窗口待用户授权）。用户因 Codex 额度耗尽要求交接给 DeepSeek 继续工作。**完整目标尚未完成，不要从头重建。**

> **先读第 3 节。** 当前拟验收版本 **0.1.53**（0.1.52 只作历史记录，不再用于验收）。Inbox 输入框超时的真实原因已查清；0.1.52 的 4 处判断和 1 处记录问题已在 0.1.53 修正；按用户 2026-09-16 补充指令，0.1.53 又补上"局部异常隔离 + 身份/运行安全异常停止"的只读读取路径，并把跳过、失败、成功分别计数（见 3.3.1）。R06 仍未通过：**新窗口已备好但未获授权**，现在只等用户确认是否执行，不再需要用户在实现方式之间做选择。

## 1. 给 DeepSeek 的第一条指令

请在 `C:\Users\17731\Desktop\KFF` 继续现有项目。先读本文件，再读 `KFF-完整目标与未完成功能交接-20260915.md` 和 `KFF-剩余开发进度-20260915.md`。以最新证据覆盖旧文档中的当前状态，保留历史结果。沿原 Web / Worker / Agent / Guardian 和原数据库推进剩余功能；不要新增另一套执行队列，不要重做已有真实验收，不要把局部成功说成完整客户转化。

用户需要 Facebook 公开内容发现 → 评论线索 → 人工审核/合规公开回复 → 客户主动进入 Messenger → DeepSeek 辅助接待 → WhatsApp 销售接手。首期不扩展支付、订单、退款、其他平台。对用户沟通用中文、短句，说清实际可用程度。

## 2. 收尾状态与必须保留的边界

- 当前版本 **0.1.53**，本机工作台 `http://127.0.0.1:3000`。
- 0.1.53 恢复运行时间：北京时间 2026-09-16 09:00。运行 ID `65c1d34d-ad49-498d-b553-ce9d8ef3f834`，Web / Worker / Agent 均 RUNNING，数据库 CONNECTED（`database_owned=true`，数据目录仍是原 `.kff/postgres`）。继续工作前重新查询，不能凭旧 PID 杀进程。
- 0.1.53 恢复后核验：**38 个监控全部 PAUSED、未关闭命令 0、未关闭环境命令 0、Inbox 待处理 0、发送 0**；8/10 环境 IDLE、9 号 `outbound_paused=true` + 环境 DISABLED；真实发送关闭、自动接待关闭。源码与已安装 Agent 的 Facebook 适配器摘要一致。
- **数据基线说明（不要误判为丢数据）**：`messages` 140、`whatsapp_referrals` 16、`customers` 98、`accounts` 88 与 0.1.50/0.1.51 基线**逐行摘要完全一致**；`acquisition_leads` 53→57、`acquisition_scans` 77→80、`acquisition_evaluations` 163→168 是 0.1.51 只读窗口自身产生的 4 条来源候选、3 次扫描、5 条规则评分。0.1.51 发布说明里的 53/77/163 是窗口开始前的快照，属于历史记录。
- 版本迭代历史：0.1.51 → **0.1.52**（第一版输入框修复）→ **0.1.53 第一轮**（用户复核后收紧：内层规则统一、裸前缀/他人姓名拒绝、零输入框保留观测、未接受与缺失分开、授权时间记录更正）→ **0.1.53 第二轮**（2026-09-16 用户补充指令：局部异常隔离、只读读取路径、成功/跳过/失败/覆盖率分别计数）。0.1.52 的完整包仍在 `dist/`，但**不要再用它做窗口**，统一用 0.1.53。0.1.53 的 Agent 包在本轮源码变动后重新生成（release id 变化），版本号仍是 0.1.53。
- 数据库托管说明：0.1.52 恢复时原外部数据库进程已不在运行，运行器按原逻辑用 `startExistingDatabase` 启动了**同一个已存在集群**（只 start，不 initdb、不 seed），因此 `database_owned=true`。含义是：**正常 `Stop` 会连带把数据库一起干净关闭**，下次 `Start` 自动再启动它；数据不会丢失。**不得把它当临时测试数据库删除或停止。**
- 启动方式说明（**已修复，2026-09 批次 B23**）：此前 `local-runtime.ps1 -Action Start` 会失败，原因是两处，且都已在正式入口修好，不再需要 `.kff` 私有绕行：
  1. **`Start-Process` 大小写重复键**：Windows 下 `Start-Process` 用不区分大小写的字典构建子进程环境，环境里同时存在 `NO_PROXY` 与 `no_proxy` 时报 `Item has already been added. Key in dictionary: 'NO_PROXY' Key being added: 'no_proxy'`，宿主根本没启动。现改为调用**已跟踪**的 `scripts/relaunch-local-runtime.mjs`（Node `spawn` + `detached` + 日志重定向），Node 交给子进程的环境块已去重，干净机器与含重复变量的机器都能启动；`local-runtime.ps1` 继续负责状态轮询、拒绝重复启动与日志目录归属。
  2. **文件编码**：该脚本是 UTF-8 且**没有 BOM**，Windows PowerShell 5.1 会把这类文件按 ANSI 解码，中文串被破坏后**直接语法报错**，`Start`/`Status` 全部不可用。现已为该文件加入 UTF-8 BOM（`scripts/start-adspower.ps1` 本来就是 BOM，`scripts/inspect-adspower-process.ps1` 无中文故不受影响）。
  本轮实测：加 BOM 前该文件在本机 5.1 下有 5 个解析错误、加 BOM 后为 0；`-Action Status` 正常输出运行状态；`-Action Start` 在已运行时回报"已在运行，沿用当前进程"，web/worker/agent/database 的 PID 与监听端口数均未增加。
- 原 `NO_PROXY` 绕行入口 `.kff/relaunch-local-runtime.ts` 属被忽略的本机私有目录，仅供参考；正式交付路径以 `scripts/relaunch-local-runtime.mjs` 为准。
- 真实发送关闭，自动接待关闭，9 号继续停用。程序保留运行以便用户查看数据，没有关机、重启电脑或重新初始化数据库。
- 原数据库端口 **55432**，数据目录 `.kff/postgres`（PostgreSQL 17，**仍是原库，没有重新初始化、没有清空**）。注意：0.1.52 恢复时原外部数据库进程已不在运行，运行器按原逻辑用 `startExistingDatabase` 启动了**同一个已存在集群**（只 start，不 initdb、不 seed），因此现在 `database_owned=true`、状态里 `database.pid=2000`、`postmaster.pid` 的启动时间与本机恢复时间一致（08:09:39）。含义是：**正常 `Stop` 会连带把数据库一起干净关闭**，下次 `Start` 会自动再启动它；数据不会因此丢失。若要像原来那样让数据库独立常驻，需另行在外部启动同一数据目录，不要让两处同时启动同一集群。**不得把它当临时测试数据库删除或停止。**
- `.kff` 包含私有数据库、凭据、配对、日志与浏览器数据。只在本机按需读取，不复制到聊天、不上传、不提交仓库。不要输出密码、Key、Cookie 或配置全文。
- 工作树有大量已存在的修改和未跟踪文件；先 `git status --short`，保留所有其他工作。禁止 `git reset --hard`、`git clean`、盲目 `git add -A`。
- 当前用户只是安排明天另一台电脑测试；没有授权重启本机，也没有要求定时提醒。

### 账号映射

| 账号 | AdsPower Profile | Facebook 身份 | KFF account_id | environment_id |
| --- | --- | --- | --- | --- |
| 8 | k1gvdtft | XiangHuan Master / 61589894042400 | 51bb1a34-7436-4fed-8efd-72a05f58607c | 8a712567-b324-41f6-b3dd-693aaf431042 |
| 10 | k1gx1n1s | 白青天 / 61594402378582 | 20fdc8c6-edc3-4ec9-b6eb-53b79a4a09d6 | b9e37c03-6c8c-4f18-bab6-078f27de08fd |
| 9，停用 | k1gw2kh9 | 郑成功 / 61594334430750 | 71895ed1-9cb8-490b-817b-dc1f82da1785 | bd009fb1-2f65-448e-8536-440225d913d9 |

Agent ID：`66666666-6666-4666-8666-666666666666`。9 号 account.state 可能仍是 ACTIVE，但 outbound_paused=true、环境 DISABLED；不能据此启用它。8 号里存在与该身份的历史会话，不等于需要打开 9 号环境。不得借用其他账号代理替换故障线路。

## 3. Inbox 输入框超时：原因已查清，修复经用户复核后收紧（0.1.52 → 0.1.53）

### 3.1 真实原因（已用实机只读诊断证实）

北京时间 23:43–23:45，取得用户授权的有边界只读诊断（仅 8 号、原失败会话 + 2 个对比会话、最多 5 分钟）。结果：

- 原失败会话 `2079341482680484` 的标题身份**正常**：6 秒内出现唯一数字主页链接 `/61594334430750/`（peer_id `61594334430750`），页面上有 1 个 `main`、1 个消息 Log。
- **该会话观察不到输入框**：30 次采样（约 16.6 秒）内 composer 候选数始终为 0，`visible_inputs` 与 `all_inputs` 都是空数组。**准确表述是"本次观察没有出现输入框"**；这**不能**证明"会话未接受"，也不能排除平台其他原因（请求类会话、被限制、渲染差异等）。
- 两个对比会话（`2234491403949554`、`27724009533944398`）的输入框在 **约 60–70 毫秒** 内就出现：`div[role=textbox][contenteditable=true]`，aria-label 为 `发消息给<对方姓名>`，可见、未被遮挡。
- 结论：`facebook-inbox-directory-composer` 阶段的 TIMEOUT 是**把"没有输入框"误报成"等待超时"**。旧代码只用精确 aria-label 定位并 `waitFor` 15 秒，等不到就抛 `TimeoutError`，被上层归类成 `THREAD_WINDOW_UNAVAILABLE`，掩盖了真实观测。
- 身份关口仍然成立：标题已核验，但 9 号保持停用，**没有启用 9 号、没有借用其他账号、没有发送、没有读取消息正文**。诊断结束时有受管关闭证明：8 号 Inactive、owner lock 已释放、发送 0。

证据（私有、保留原文，不复制到仓库以外）：

- `.kff/inbox-composer-diagnostic-051-r2.json`（含真实 aria-label 原文）
- `.kff/inbox-composer-diagnostic-051-r2-plan.json`、`.kff/diagnose-inbox-composer-051-r2.ts`
- 本地模拟页面探针（0.1.53 起 16 项全过，未触真实平台）：`.kff/probe-composer-surface-051.js`、`.kff/run-composer-probe-051.ts`
- 第一次尝试因脚本自身查询错列（`e.platform`）在预检阶段停止、**没有打开浏览器**，错误记录在 `.kff/inbox-composer-diagnostic-051.json`

**授权时间记录已更正**：两份计划的 `prepared_at/approved_at` 原来是我照旧模板手填的，与文件创建时间不符（r2 写成 15:46:00Z，实际执行 15:43:22 就开始了）。已按实测文件创建时间更正，并在两个计划文件里留了 `time_record_correction` 说明真实时序：用户在会话中先授权 → 15:35:43 首个计划 → 15:43:08 首次尝试在自身预检失败（未开浏览器）→ 15:43:19 修正版计划 → 15:43:22 执行。**任何平台动作都发生在授权之后**，但原记录的写法是错的。

**记录纪律（保留原错误，不补造时间）**：错误的 `prepared_at/approved_at` 原值保留在文件里，与修正说明并存，不改写成"看起来对"的时间。文件创建时间只能作为辅助时序证据，**不能单独代替用户授权时间**；能对应到原始授权消息的就关联该证据，无法核实的精确时间明确标注"未核实"。新的 0.1.53 窗口计划 `.kff/matrix-window-053-plan.json` 因此预先留空 `approved_at` 与 `user_reply`，等用户真的确认后才由确认动作写入。

### 3.2 0.1.52 第一版修复（已被 0.1.53 取代）

- 新增 `inspectFacebookInboxComposerDom` 按语义识别输入框；`resolveThreadComposer` 有界轮询，失败带事实观测。
- **用户复核发现 4 处判断问题 + 1 处记录问题，全部成立**：
  1. 外层接受语义标签，内层读取仍要求 aria-label 严格等于「发消息给＋姓名」，外层放行的标签会被内层拒绝。
  2. 只检查前缀，裸 `发消息给`／`Message`、甚至他人姓名也能通过外层。
  3. 零输入框时返回 `surface=null`，最需要留证的"没有输入框"反而没有观测。
  4. 把"没发现输入框"统一标成 `THREAD_NOT_ACCEPTED`，超出证据。
  5. 授权时间记录不自洽（见 3.1 末尾）。

### 3.3 0.1.53 收紧后的规则（当前版本）

- **内层与外层同一条规则**：`readFacebookInboxThread` 也用 `inspectFacebookInboxComposerDom`，不再有精确标签的第二道门。
- **标签分级**：`EXACT_NAME`（等于已核实姓名）优先；`NAMED_PREFIX`（`发消息给<某人>`）**只在目录仍是占位名"Facebook 用户"时**才可用，此后仍逐条核对来信头像；`BARE_PREFIX`（裸前缀）、`OTHER`（搜索框等）、占位名本身、操作账号自身身份一律不通过。目录已显示真实姓名时，标签必须精确匹配，否则拒绝。
- **零输入框保留观测**：返回 `absent=true`、`candidate_count=0`、`label_kind=ABSENT`，不再是 `null`。
- **原因分级，不再混淆**：`THREAD_COMPOSER_ABSENT`（观察不到输入框）／`THREAD_COMPOSER_UNVERIFIED`（有输入框但标签不可用）／`THREAD_NOT_ACCEPTED`（仅限确有页面证据）／`THREAD_IDENTITY_UNVERIFIED`。契约新增 `browserInboxComposerSurface`（含 `ABSENT/EXACT_NAME/NAMED_PREFIX/BARE_PREFIX/OTHER`）与上述 code。**0.1.53 第二轮又拆出 `THREAD_INPUT_UNUSABLE`／`THREAD_INPUT_FOREIGN`，见 3.3.1。**
- **失败也保留观测**：整个任务失败关闭时，`discovery` 会挂在抛出的错误上，逐会话观测不会丢失。
- 本地验证：**192 项契约、24 项 Inbox 目录浏览器回归、19 项 Inbox 集成、16 项本地序列化探针**、typecheck、lint、生产 build 全部通过，无失败无跳过；无新增迁移。
- 证据 `docs/evidence/inbox-composer-fix-053-20260915.json`（取代 052 证据）；浏览器报告 `.kff/inbox-composer-053-results.json`。
- **序列化陷阱（必须继续遵守）**：TSX 会给传给 `.map()/.filter()` 的箭头回调注入 `__name`，`page.evaluate` 会报 `__name is not defined`。解析器内只用对象方法或直接调用；必须先用 `.kff/run-composer-probe-051.ts` 在本地空白页面验证真实序列化。

### 3.3.1 第二轮收紧：局部异常隔离与只读读取（2026-09-16，用户补充指令后）

用户已直接约定运行策略，**不需要再让用户在两种做法之间选择**：

- **局部异常隔离**：单个会话如果已完成账号身份与会话身份核验，只是限定观察时间内没有 composer，就保留完整观测、标记待复查，然后继续下一个会话。
- **身份/运行安全异常停止**：身份不一致、账号环境不一致、Guardian/Agent 异常、关闭证明失败或无法确认读取对象身份时，停止对应环境或窗口。
- **禁止硬编码跳过 thread ID**：不得为通过验收写死任何会话 ID，包括 `2079341482680484`。
- **只读路径**：修掉"能发送＝能读取"的隐含前置。`composer` 只用于授权"已接受会话"这条路径；当**完全没有观察到输入框**时，改用只读路径，但仍要求同一套身份条件：标题唯一数字主页身份 + 唯一消息区域 + 消息区域标题等于该已核实姓名 + 逐条来信头像主页 ID 核对 + 前后操作账号身份核对。核实不了就跳过，不代读。
- **只读路径不是绕过**：输入框存在但只重复目录占位名、指向他人、被禁用或被遮挡时，仍记为未读取并跳过（`THREAD_COMPOSER_UNVERIFIED` / `THREAD_INPUT_FOREIGN` / `THREAD_INPUT_UNUSABLE`）。只读路径只在"本次观察没有输入框"时启用。
- **跳过不等于成功**：`discovery.threads[].read` 只为真正读到的会话置位；跳过项进 `discovery.skipped`，并新增 `discovery.coverage`（`threads_attempted/threads_read/threads_skipped/threads_failed`）与 `discovery.observed`（只读读取的原因留证）。控制器在入库前校验"逐会话条数＝本批次消息数"和"覆盖计数＝实际读取/跳过数"，不一致直接拒绝入库。跳过的会话不推进任何水位，下一轮仍会重新尝试（目录发现每轮从列表顶部重读，不做持久化跳过）。
- **原因分级不越证据**：新增 `THREAD_INPUT_UNUSABLE`、`THREAD_INPUT_FOREIGN`；`THREAD_NOT_ACCEPTED` 仅保留给历史记录与确有页面证据的情形，输入框不存在/禁用/遮挡一律记客观状态，不推断 Facebook 会话的业务原因。
- 契约：`browserInboxThreadTarget`（`read`/`message_count`/`read_only_reason`/`composer_surface`）、`browserInboxSkippedThread`、`browserInboxDiscoveryCoverage`、`browserInboxComposerSurface.placeholder`、`facebook-inbox-read-only` 失败阶段。
- 本地验证：**194 项契约、26 项 Inbox 目录浏览器回归、11 项 Inbox 集成**、typecheck、lint、生产 build 全部通过，无失败无跳过；无新增迁移。
- 证据 `docs/evidence/inbox-read-only-isolation-053-20260916.json`；浏览器报告在 `.kff/checks/`（`KFF_CHECK_NAME=inbox-directory-053-r*`）。
- **验收脚本同步改动**：`.kff/run-matrix-window-053.ts` 把停止规则拆成"运行安全停止"（身份/环境/Guardian/关闭证明）与"局部会话跳过"，按 `PLANNED_CYCLES_FINISHED` 计算接受度，并分别报告成功读取数、跳过数、失败数与实际覆盖率。局部跳过不再让整个窗口失败，但也不会被计成读取成功。

### 3.4 下一步：新窗口需要用户确认（已知会话不再需要单独约定）

0.1.53 起，3.3.1 的规则已实现，**已知会话 `2079341482680484` 不再需要另行约定跳过方式**：它与其他会话同规则处理，读不到就记录原因并继续。

仍需用户确认的只有一件事：是否授权执行这次真实只读窗口。计划已备好但**未批准**：`.kff/matrix-window-053-plan.json`（`approval=PENDING_USER_CONFIRMATION`、`approved_at=null`、`user_reply` 为空），入口脚本 `.kff/run-matrix-window-053.ts`（SHA-256 `086d0ae3efc4b6f73ddced505bf860c009d8b983ee4d3c1e7f3756daec89d692`）。用户确认后才写入 `USER_APPROVED`、`user_reply` 与 `approved_at`。

`live_composer_fix_acceptance` 在证据里仍是 `PENDING_FRESH_AUTHORIZED_WINDOW`。历史 0.1.51 窗口的授权已经消耗，不得重用旧计划里的 `USER_APPROVED`。

重开前要做：查询当前版本与配置（现在是 **0.1.53**、运行 ID `6f5c4e9b-5fd5-456c-9751-f1e44666d56f`、`release_id=kff-agent-0.1.53-win32-x64-660e67dac2d6`；验收脚本会在预检里要求 `0.1.53` 且源码与已安装 Agent 摘要一致，不一致会直接拒绝启动，**运行 ID 需要在执行前重新查询**）、确认 33 个采集监控与 5 个收件监控全部 PAUSED、未关闭命令 0、8/10 环境 IDLE、9 号仍 `outbound_paused=true` 且 DISABLED、真实发送关闭。

原8号 Inbox 监控：`6a14ca96-4988-4aa2-a0c7-686fc01c15eb`；10号：`e693f9db-6faa-4b7f-9e98-cf1079297665`。不能用旧版本强写。

### 3.5 历史：0.1.51 双号窗口（保留原结论，不得改成通过）

北京时间 **13:20:34–13:23:51**，总计 197.019 秒。原计划为 60 分钟，每号 2 次搜索与 2 次 Inbox，间隔 30 分钟；每次搜索最多接续 1 个来源、25 条评论，每轮 Inbox 最多 3 个会话、合计 25 条消息。遇首次异常停止整个窗口。

实际结果：

- 8、10 号各完成首轮“八字”搜索，共 4 条来源候选，0 条合格线索；来源候选不等于客户。
- 8 号 Inbox 前两个会话可核验，8 条旧消息全部去重，新增消息 0。
- 第三个会话 `2079341482680484` **已经通过修复后的标题身份校验**，随后在 `facebook-inbox-directory-composer` 阶段 TIMEOUT，跳过原因为 `THREAD_WINDOW_UNAVAILABLE`。真实原因已由 3.1 查清。
- 10 号 Inbox 与自动派生的评论任务在派发前取消，没有 command_id，不能说已执行。该窗口没有完成评论读取。
- 3 个实际执行命令均有本地 Guardian / 数据库一致的关闭证明，串行和身份核对成立，全部监控恢复暂停。窗口 accepted=false。
- 独立原报告已生成，结论 `INCOMPLETE`，包括轮次不足、未执行任务和 Inbox 部分覆盖。不得改成通过。

证据（相对项目根目录）：

- `docs/evidence/matrix-window-051-20260915.json`
- `docs/evidence/matrix-window-report-051-20260915.json`
- 原观察记录 `.kff/matrix-window-051.json`、`.kff/matrix-window-051.log`
- 执行脚本 `.kff/run-matrix-window-051.ts`，计划 `.kff/matrix-window-051-plan.json`
- 原报告计划 `.kff/matrix-window-051-report-plan.json`

## 4. 已修好的问题，不要回退

### 0.1.53：输入框判断收紧（当前版本，取代 0.1.52 的第一版）

- `packages/adapters/src/facebook-inbox-directory-dom.ts`：`inspectFacebookInboxComposerDom(expected)` 现在接收 `{display_name, allow_other_name, operating_identity_id}`，返回 `{composer, absent, candidate_count, surface}`。标签分级 `ABSENT/EXACT_NAME/NAMED_PREFIX/BARE_PREFIX/OTHER`；`NAMED_PREFIX` 只在 `allow_other_name`（目录仍为占位名）时可用；裸前缀、占位名本身、操作账号身份一律不通过。零输入框也返回完整 `surface`（`label_kind=ABSENT`）。
- `packages/adapters/src/facebook-browser-inbox.ts`：`resolveThreadComposer(..., viaPlaceholder)`；内层 `readFacebookInboxThread` 用同一个解析器，标签不等于已核实姓名且不是"没有输入框"时报 `INBOX_SOURCE_MISMATCH`；失败原因分为 `THREAD_COMPOSER_ABSENT` / `THREAD_COMPOSER_UNVERIFIED` / `THREAD_NOT_ACCEPTED`；整个任务失败关闭时把 `discovery` 挂在错误上，逐会话观测不丢失。
- `packages/contracts/src/browser-inbox.ts`：`browserInboxComposerSurface` 的 `label_kind` 与 `skipped.reason`、`failure.code` 枚举同步扩展。
- `tests/browser/fixtures/facebook-inbox-directory.spec.ts`：24 项，覆盖精确标签、占位名下的他人标签、目录有真名时的他人标签、裸前缀、搜索框、零输入框、禁用输入框、操作账号自身、内外层一致性。
- 证据 `docs/evidence/inbox-composer-fix-053-20260915.json`；探针 16 项 `.kff/probe-composer-surface-051.js`。

### 0.1.52：会话输入框不再盲等（已被 0.1.53 取代，保留记录）

- 首次把精确标签门改成语义解析 + 事实观测，并用实机诊断查清"没有输入框"这一真实原因。
- **该版本的判断有 4 处不严、1 处记录错误，已由 0.1.53 修正**（详见 3.2）。不要回退到 0.1.52 的规则，也不要用它的包做验收窗口。
- 证据 `docs/evidence/inbox-composer-fix-052-20260915.json` 保留原样，作为"复核前状态"的历史记录，不改写。

### 0.1.51：目录名称占位与标题加载

真实诊断发现目录初始名字为“Facebook 用户”，随后同一会话标题加载为“郑成功”并出现唯一数字主页链接 `/61594334430750/`。旧逻辑一直要求等于目录占位名，导致身份门禁失败。

- `packages/adapters/src/facebook-inbox-directory-dom.ts`：只有初始目录名确为“Facebook 用户”时，允许唯一可见标题中的实际姓名和数字主页身份。保留唯一 main、唯一标题链接、数字 ID、同源、精确会话 URL、排除消息 Log 等约束。占位名自身不能作为已核实身份，已有真实姓名不匹配仍拒绝。
- `packages/adapters/src/facebook-browser-inbox.ts`：占位名时先等待主区域标题可见，再按原严格解析核验。每条入站消息头像的身份校验保留。
- `tests/browser/fixtures/facebook-inbox-directory.spec.ts`：11 项新增浏览器回归，包含延迟加载/已加载和拒绝情形。测试拦截 Facebook URL 使用本地固定页面。
- 原错误可复现：修复前 4 项失败、7 项通过；修复后新增 11 项加原组 17 项，共 **28 项浏览器检查通过**。
- **192 项契约、19 项 Inbox 集成、typecheck、lint、生产 build 通过**。这是本地验证；最新真实窗口只证明标题关口已前进，完整 Inbox 仍失败。
- 证据 `docs/evidence/inbox-header-diagnostic-050-r2-20260915.json`、`docs/evidence/inbox-placeholder-release-051-20260915.json`。发布证据中的 pending 是当时状态，后续以 051 窗口证据为准，不重写历史。

诊断脚本曾因 TSX 在 page.evaluate 内给嵌套箭头函数插入 `__name` 而失败，随后改成自包含对象方法并在真实浏览器执行序列化代码验证。复用 `.kff/inbox-header-surface-050.ts` 的方式；不要用仅 transpileModule 通过冒充浏览器序列化通过。旧失败记录保留。

### 0.1.50：商家广告误判

真实新评论“想瞭解自身八字可直接私信我（批八字需卦金！）”属于商家招揽，不是咨询客户。`packages/core/src/acquisition-scoring.ts` 已补付费服务报价与卖家联系组合排除，保留正常询价。误判 lead 已沿原审核 API DISMISSED/v2，历史分数保留，不能回填历史评分。证据 `docs/evidence/paid-bazi-promotion-050-20260915.json`。

### 0.1.49：原命令关闭前不得调度下一账号

原命令终态但缺少关闭证明时，仍必须占用同一 Agent。已在原 dispatchOne、claimCommand、claimEnvironmentCommand 补齐关闭门禁，复用 Agent 行锁。不要把 DONE/EXPIRED 直接等同于浏览器已关闭。旧 AdsPower 启动失败经用户另批重启和原恢复流程解除隔离，原失败动作仍 NEEDS_HUMAN，没有重发或补成功。

相关：`packages/core/src/execution.ts`、`packages/core/src/environments.ts`、`tests/integration/agent-closure-gate.test.ts`，证据 `docs/evidence/agent-closure-gate-049-20260915.json`。

## 5. 已经取得哪些真实成功

- 0.1.49 两号有限纯搜索窗口 209.124 秒通过；10 号自动选取此前没有入库的新 Reel，沿原队列读到 3 条不重复评论。**搜索→自动新来源→评论入库技术链成立**。唯一命中的评论是商家广告，新增有效咨询客户 0。
- 证据 `docs/evidence/search-continuation-049-20260915.json` 和 `docs/evidence/matrix-window-report-049-20260915.json`。
- 更早的 3 条自然咨询评论仍待审，作者数字 ID 未返回，不能据此直接私信。Lead：`5045122f-c939-42b6-999a-d6fbcf03237a`、`87afb3e5-ad2c-4206-8faa-6837dd234824`、`cd7d9b87-93d5-4be8-920d-e72a86452599`。
- 历史受控对象 C 已验证公开回复、Messenger 收件、DeepSeek 草稿审核后实际回复，以及用户确认收到正确 WhatsApp **+86 18730936793**。模型沿现有 `deepseek-flash` 配置；不要再问已有 Key，也不要打印它。
- C 的移交 `61f34822-3028-49c8-9255-0aebc01a0e5b` CONFIRMED/v3；它不能与其他自然评论拼成一个自然客户完整链。证据 `docs/evidence/c-correct-number-confirmed-20260915.json`。
- iPhone Messenger 内 WhatsApp 链接可进入聊天；Facebook App 内仍可能仅打开 WhatsApp，保留已有操作提示。不要重复发送邀请来演示。

## 6. 剩余目标逐项交接

| 项目 | 尚需完成 |
| --- | --- |
| R01 | 自动选源到评论已真实通过；还需要有效自然咨询样本，不能用广告候选充数 |
| R02 | 自然线索明确作者身份和公开回复资格；缺 ID 不猜测、不强行解锁 |
| R03 | 同一自然客户从公开线索到自愿 Inbox，再到销售确认 WhatsApp；等待真实业务条件 |
| R04 | 指定 Facebook 主页先做基线，之后真正新发布帖子时验证发现、评论接续和再次扫描去重 |
| R05 | 新广告误判已修；继续按真实样本评价质量，保留原文和历史评分 |
| R06 | 0.1.49 纯搜索通过；0.1.51 标题修复经真实窗口通过该关口，随后 composer 超时；0.1.52 查清真实原因（观察不到输入框）；0.1.53 收紧判断，并按用户 2026-09-16 补充指令实现"局部异常隔离 + 身份/运行安全异常停止"与只读读取路径 | 用 0.1.53 执行完整两轮（**需新授权窗口，计划已备好未批准**）；不再需要单独约定已知会话：`2079341482680484` 与其他会话同规则处理，不硬编码跳过；历史 AdsPower 内部原因仍未确认 |
| R07 | 原生占用/人工接管及真实在途竞争场景仍有缺口，不重复发送未知旧动作 |
| R08 | 人工辅助接待可作为首期模式；连续无人审核回复未放行 |
| R09 | 已有有限窗口耗时报告，持续吞吐量未证明；新窗口脚本已按成功/跳过/失败/覆盖率分别报告，仍待真实数据 |
| R10 | 用户说明“明天上班安排另外的电脑测试”；另有 **0.1.53 完整包**可用，待另一台 Windows x64 首装和安排重启 |
| R11 | 0.1.26→0.1.50 完整包隔离升级通过；0.1.53 对应完整包跨版本升级、整机重启/异常恢复尚缺 |
| R12 | 本次已补用户说明书；操作员独立实操交接仍待现场验证 |

R04 对用户的通俗解释：指定“要关注的 Facebook 公共主页”，先记住已有帖子，等它后来发一条新帖子，查看 KFF 是否发现且不会重复收集。可以继续提议此前主页 `61594197356279`，但用户尚未确认新内容安排。不要把 R04 理解成要求用户现在发广告；本轮没有发布授权。

## 7. 安装包与新电脑

**当前交付版本 0.1.53（推荐，含局部异常隔离与只读读取路径）**

- 本机正在运行与验收的 Agent 包：`dist/kff-agent-0.1.53-win32-x64-660e67dac2d6.zip`
- Agent ZIP SHA-256：`6236ddd3b8374d88dac3bad3b97983b0fb2c03f5ae3cc18fe6c61a8a7485f3e5`，1348 文件
- 已安装 Agent（当前 configure 指向）：`C:\Users\17731\AppData\Local\KFF\Agent\releases\kff-agent-0.1.53-win32-x64-660e67dac2d6`
- 源码与已安装 Agent 的 Facebook 适配器摘要一致：`4818f7ea3d567b4401c45550337fa98fb19953a01422feab362c93ca34e09c02`
- **完整包尚未按本轮修复重打包**：`dist/kff-controller-0.1.53-win32-x64-984bc7dad026.zip` 仍是第一轮（无只读路径）内容，**不能当作本轮修复的交付物**。要交付到另一台电脑，必须先重新生成完整包并核对摘要。
- 版本号没有升到 0.1.54：`package-agent.mjs` 的 release id 含源码摘要，源码变化即产生新目录，满足"发布目录不可变"；验收版本仍统一为 **0.1.53**。
- 证据：`docs/evidence/inbox-read-only-isolation-053-20260916.json`（本轮）、`docs/evidence/inbox-composer-fix-053-20260915.json`（第一轮）

**历史包（保留，不要当当前版本）**

- 0.1.53 第一轮 Agent（无只读路径）：`dist/kff-agent-0.1.53-win32-x64-153bd4ef175d.zip`，SHA-256 `bf5d8034b47d302f35cd8395b2aebc8e82174cbd64b79ea7f40f3b65d643d39c`
- 0.1.52：`dist/kff-controller-0.1.52-win32-x64-0759eeb12cc5.zip`、`dist/kff-agent-0.1.52-win32-x64-5b9afdd9aa26.zip`（判断未收紧，不要用于验收）
- 0.1.51：`dist/kff-controller-0.1.51-win32-x64-2f035924a1fb.zip`，SHA-256 `06c53b3cd9ccd65c0aadb7e157374352a18e4c369ba9edc87c6610d0d79fb023`
- 0.1.51 Agent：`C:\Users\17731\AppData\Local\KFF\Agent\releases\kff-agent-0.1.51-win32-x64-5ed5eaa11e77`，ZIP SHA-256 `468fcc1c92e29ab63d87015e7e1993e44b5992b9e8460f6839f32c92c377e0db`

明天按 `docs/api/controller-delivery.md` 在新英文路径解压后 verify → setup → start → status；用新机自己的 AdsPower 配置。旧电脑开发目录不要运行 setup 或直接覆盖。注意：**Agent 与源码必须成对使用**，版本不一致会被启动校验直接拒绝（`Installed Agent differs from the current source`），这是设计如此。

`docs/evidence/controller-upgrade-050-20260915.json` 是本机隔离目录的 0.1.26→0.1.50 证据，不能改称 0.1.53 或跨电脑证据。

## 8. 开发、检查与交付命令

在项目根目录 PowerShell 执行，一次一个步骤，检查退出码：

```powershell
git status --short
.\scripts\local-runtime.ps1 -Action Status
node scripts/run-check.mjs typecheck
node scripts/run-check.mjs lint
node scripts/run-check.mjs contracts
node scripts/run-check.mjs build
```

只对相关修改运行必要的测试；集成测试使用原 `node --import tsx scripts/integration.ts <具体测试文件>`，创建独立随机数据库，绝不清空主库。共享结果位于 `.kff/checks`，新检查前保留需引用的旧报告。

发布顺序：正常 Stop → 相关检查/构建 → 登记当前证据 → 打包 Agent → 完整性校验并安装新目录 → 用原 configure 指向新 Agent（`--discovery --inbox`，省略 `--live`）→ 原 Start → 核对健康、代码摘要和业务数据。参阅 `docs/api/local-runtime.md`、`docs/api/agent-delivery.md`，不要绕过原升级和关闭流程。

**本会话已知的两个环境坑（不是产品缺陷）：**

1. `.\scripts\local-runtime.ps1 -Action Start` 会在 `Start-Process` 处报 `Item has already been added. Key in dictionary: 'NO_PROXY' Key being added: 'no_proxy'`。原因是本会话环境同时存在大小写两个代理变量，Windows 的 `Start-Process` 环境字典不区分大小写。改用等价的 detached 启动入口：`node --import tsx .kff/relaunch-local-runtime.ts`，然后用 `node --import tsx scripts/local-runtime.ts status` 轮询到 `RUNNING`。`Stop` 与 `Status` 照原命令使用，不受影响。
2. 打包 `node scripts/package-agent.mjs` 的发布目录是**不可变**的。release id 里含源码摘要，所以**源码变化后重跑会生成新目录，不需要升版本号**；只有源码摘要完全相同才会报 `Release already exists; keep it immutable`，那时不要删旧目录。本轮就是这样在 0.1.53 内生成 `...-660e67dac2d6` 的。

原窗口独立报告已经运行过，不需要重做平台动作：

```powershell
node --import tsx scripts/matrix-window-report.ts --plan .kff/matrix-window-051-report-plan.json --output docs/evidence/matrix-window-report-051-20260915.json
```

PowerShell 使用 `$false/$true`。`rg` 搜文件时用 `rg --files` 或 `-g`，不要把 `目录/*片段*` 当 Windows 文件名传入。后台启动用隐藏窗口；终端等待超时只表示观察未完成，继续轮询原会话，不再启动第二份升级/测试。不要复制整个私有配置到输出。

**本轮新增环境坑（已踩过一次，务必避免）**：不要用 `Get-Content`/`Set-Content` 这类 PowerShell 文本往返去改项目源码（含中文的 `.ts`）。本会话实测会把 UTF-8 读成中文 ANSI 代码页并写出乱码，导致源文件损坏、只能整文件重写。需要批量改动就用 edit/write 工具，或用 Node 脚本处理。改动后建议核对：`node -e "const s=require('fs').readFileSync('<file>','utf8');console.log(/\\uFFFD/.test(s))"`。

## 9. 恢复工作的完成标准

先读并重新核对状态，再修当前可复现问题；每次报告分清“本地检查通过”“真实窗口通过”“客户实际转化”。所有真实动作必须沿原审批、联系资格、提交意图和关闭证明链。遇身份不符、读取失败、关闭不确定时按窗口约定停止，记录事实。不能伪造客户、历史回执、关闭证明或统计成功。

**0.1.53 目前的定位（不要夸大）**：输入框超时的原因已有实机证据；第一轮按用户复核收紧；第二轮按用户 2026-09-16 补充指令实现局部异常隔离、只读读取路径与成功/跳过/失败/覆盖率分别计数，本地 **194 项契约、26 项 Inbox 目录浏览器回归、11 项 Inbox 集成**、typecheck、lint、生产 build 全部通过，Agent 包已按新源码重新生成并安装，运行中源码与 Agent 摘要一致。但**没有**用这一版跑过任何真实业务窗口：`live_composer_fix_acceptance=PENDING_FRESH_AUTHORIZED_WINDOW`。R06 因此仍是未完成。**完整交付包尚未按本轮修复重打包**，交付到另一台电脑前必须先重新生成完整包。

**关于"未发现输入框"的措辞纪律**：可以写"本次观察未显示输入框"；**不要**写"会话未接受""已封禁""已注销"或任何未取得页面证据的结论。诊断记录里 `platform_account_deactivation_or_ban_proven` 是 false，必须保持。

用户操作说明在同目录：`KFF-使用说明书-0.1.51.md`（内容对应 0.1.51 界面；0.1.52 与 0.1.53 只改了 Inbox 读取的内部判定，没有新增用户操作步骤）。本交接完成不等于原完整开发目标完成。

**本轮（0.1.53 第二轮）结束时的真实定位**：本地修复与回归全部通过，Agent 包已按新源码重新生成并安装，本机运行中源码与 Agent 摘要一致；**真实业务窗口 0 个**，没有打开任何 Facebook 账号，监控全部 PAUSED，真实发送与自动接待关闭。下一步只需要用户回答一个问题：是否授权执行已备好的只读窗口（8、10 号，最多 60 分钟，每号 2 轮搜索 + 2 轮收件，不发送、不改代理、不重启电脑、不启用 9 号）。

### 9.1 已授权的第 1 次真实窗口：6.365 秒被安全门禁拒绝（保留记录）

用户回复“授权”（`approved_at=2026-09-16T04:09:03.519Z`）。窗口 `04:09:19.612Z` 开始、`04:09:25.977Z` 结束，结果 `CLOSED_WITH_FINDINGS / RUN_SAFETY_FAILURE`。记录：`.kff/matrix-window-053-attempt1-version-conflict.json`，计划 `.kff/matrix-window-053-plan-attempt1.json`。

**根因**：四条命令全部 `VERSION_CONFLICT`。运行器按设计在 `packages/core/src/execution.ts` 校验任务快照的 `implementation_digest`，而 8/10 号能力行的该字段仍是**本机重装源码之前的旧值**（`eb68a138…`），与当前 `adapterImplementationDigest`（`4818f7ea…`）不一致，因此在任何命令到达 Agent 之前就拒绝。这是既有安全门禁正常工作，不是只读路径改动引入的问题，也不是平台异常。

**没有发生的事**：没有命令到达 Agent / Guardian；没有打开任何 Facebook Profile（复查两个 Profile 仍 Inactive）；没有打开浏览器、没有读取任何会话或消息、没有发送；没有改代理、没有重启电脑；`action_attempts` 在窗口内为 0。

**修复（不是绕过）**：`node --import tsx scripts/register-evidence.ts` 按当前全部通过的合同报告登记当前实现摘要，再用 `.kff/attach-capability-evidence-053.ts` 调用**原有** `attachLocalEvidence`，把 8/10 号四类 Facebook 浏览器能力的证据刷新到当前实现摘要（只刷新证据，不新增发送权限）。随后新增隔离复现 `tests/integration/inbox-capability-digest.test.ts`：旧摘要会在排队前被拒、`agent_commands` 为 0；当前摘要让同一命令正常到达 Agent。两项通过。

**重跑需要用户新的明确授权**：按用户规则，一次授权对应一次有边界窗口；本次授权已被消耗，不自动重跑真实账号。重跑前应确认 `adapter_match=true`、未关闭命令 0、监控全部 PAUSED、两个 Profile Inactive。

### 9.2 已授权的第 2 次真实窗口：39.881 秒，身份页导航失败（保留记录）

用户选择“授权重跑一次”（`approved_at=2026-09-16T04:20:30.434Z`）。窗口 `04:20:40.390Z` 开始、`04:21:20.271Z` 结束，结果 `CLOSED_WITH_FINDINGS / RUN_SAFETY_FAILURE`。记录：`.kff/matrix-window-053.json`。

- 第 1 次尝试的 `VERSION_CONFLICT` 已不再出现：能力实现摘要门禁通过，**命令首次真正到达 Agent 与 Guardian**。
- 第 1 条命令（8 号收件）在账号身份核验阶段报 `IDENTITY_NAVIGATION_FAILED`：`page.goto('https://www.facebook.com/me/')` 抛错（非超时），窗口按约定立即停止；另外 3 条在派发前取消，未到达平台。
- 关闭证明齐全：两条已领取命令都有本地 Guardian 与数据库一致的证明（`c33dbc8b…` 证明 `773e2913…`、`d1de17b4…` 证明 `2b74f6f3…`）。`action_attempts` 提交数 0，说明**没有发生任何真实发送**。
- 两个 Profile 复查仍为 Inactive，没有遗留打开的账号；`messages` 仍为 140，**没有任何会话被读取**，`coverage` 为空。
- **缺的证据**：AdsPower 内该 Profile 的浏览器是否能访问 Facebook。本机自身网络正常，但失败发生在供应商浏览器进程内。这是环境未验证项，不是产品代码结论，也不代表账号异常或封禁。

**下一步（需用户批准）**：先做一次有边界的只读连通性探针——打开 8 号 Profile，只访问 `about:blank` 与 `https://www.facebook.com/`，记录导航结果与最终 URL，不进入任何会话、不读消息、不发送，随后按原受管流程关闭并核对关闭证明。确认环境可达后再申请新的窗口授权，避免再消耗一次窗口。

### 9.3 已授权的连通性探针：根因是 Profile 代理不可连接（保留记录）

用户选择“授权做这个探针”。探针 `04:28:39.056Z` 开始、`04:28:52.897Z` 结束，关闭证明 `closure_confirmed=true`、`after_status=Inactive`；记录 `.kff/connectivity-probe-053.json`，私有截图 `.kff/connectivity-probe-053.png`。

- `about:blank` 正常（74 毫秒）；`https://www.facebook.com/` 失败：**`net::ERR_PROXY_CONNECTION_FAILED`**（2051 毫秒）。
- 结论：8 号 Profile 的浏览器使用自身配置的代理，而**该代理当前不可连接**，所以 Facebook 完全打不开。这正好解释第 2 次窗口的 `IDENTITY_NAVIGATION_FAILED`（`facebook.com/me/` 立刻抛错、不是超时）。
- **不是产品缺陷**：本机自身网络正常，失败发生在供应商浏览器进程的代理路径内，与 0.1.53 的只读路径、身份判断、调度逻辑无关；也不是账号被封的证据。
- 代理地址与口令没有记录（只读列举接口未返回代理字段），需要操作员在 AdsPower 内查看 8 号 Profile 的代理配置。

**下一步**：操作员在 AdsPower 里确认或更换 8 号（必要时 10 号）Profile 的代理，确认浏览器能打开 `facebook.com` 后，再申请新的窗口授权。重跑前应确认 `adapter_match=true`、未关闭命令 0、监控全部 PAUSED、两个 Profile Inactive。

### 9.4 复验探针与代理诊断：本机代理端口没有监听进程（保留记录）

用户再次回复“授权”复验。结果仍为 `net::ERR_PROXY_CONNECTION_FAILED`（`closure_confirmed=true`、`after_status=Inactive`、未读消息、未发送；记录 `.kff/connectivity-probe-053.json`）。

随后做了只读诊断（不改任何设置）：

- 8 号 Profile 的 `user_proxy_config`：`proxy_soft=other`、`proxy_type=socks5`、IPv4 主机、端口 **10907**、无账号口令；10 号同主机 socks5 端口 **10920**。
- 本机 TCP 探测：`127.0.0.1:10907`、`10919`、`10920` 以及 `10809/7890/7897/1080` **全部 ECONNREFUSED**（1 毫秒内立即拒绝 = 没有进程监听）。
- 只有 `127.0.0.1:10808` 可连接（Windows 系统代理 `ProxyEnable=1` 指向它，会话环境变量 `HTTPS_PROXY` 也是它）。
- **结论**：Profile 配置所指向的 SOCKS5 代理端口在本机没有任何监听进程，浏览器无法建立代理隧道，所以 Facebook 完全打不开。既不是产品代码问题，也不是账号状态问题。
- 未取直接证据的部分：Chromium 实际走的是 Profile 的 socks5 配置还是继承的 Windows 系统代理；两种情况下当前都不可用。
- **需要操作员做的**：启动/恢复 Profile 指向的本地代理客户端并确认 8 号、10 号端口都可用。修改本机代理软件状态属于用户保留确认的操作，我不擅自处理；处理完我可以用同一个探针（约 14 秒、不读消息不发送）复验。

### 9.5 代理恢复、第 3 次窗口：搜索成功、收件异常（保留记录）

代理恢复后探针第 3 次通过：`https://www.facebook.com/` 返回 **200**，8 号环境显示已登录 `XiangHuan Master`（私有截图仅存 `.kff/connectivity-probe-053.png`）。

用户授权第 3 次窗口（`approved_at=05:04:50.522Z`）。窗口 `05:05:00.663Z`–`05:07:20.024Z`，143.361 秒，`CLOSED_WITH_FINDINGS / RUN_SAFETY_FAILURE`。记录 `.kff/matrix-window-053.json`。

**成功部分**：8 号「八字」公开搜索**执行成功并正常关闭**（命令 `c052905c…`，05:05:00 领取、05:06:02 关闭）：扫描 `PARTIAL / MAX_PAGES`，返回 3 条、去重 3 条、提交 1 页；系统按原规则自动派生「8号八字搜索 · 评论接续」监控（目标 `https://www.facebook.com/reel/3444005145770677/`，与 0.1.49 窗口同一 Reel）；新增 **1 条 NEW 线索**（score 50）。搜索→自动选源链路再次真实成立。

**失败部分**：8 号收件命令 `9f20ac1b…`（05:06:03 领取、05:07:04 关闭）返回 `BLOCKED / EXECUTOR_ERROR`，窗口按运行安全规则停止；10 号搜索与两条收件命令在派发前取消，未到平台。`EXECUTOR_ERROR` 说明抛出的是**非 AppError**，而当时 Agent 的阻塞报告只记步骤、不记异常内容，**真实原因缺失**——这是本轮新发现的留证缺口。

关闭证明齐全（`4b6972c3…`、`fd5d0eea…`、`24f300ad…`），提交 0，两个 Profile 仍 Inactive，`messages` 仍 140，收件覆盖 `0/0/0/0`。

**已补的留证修复（尚未用于真实读取）**：`packages/adapters/src/facebook-browser-inbox.ts` 新增 `blockedDiagnostic()`，阻塞报告带上 `error_kind` 与截断后的 `error_message`；`packages/contracts/src/index.ts` 的 report diagnostic 增加可选 `error_kind`/`error_message`（向后兼容）。契约 194/194、Inbox 浏览器回归 26/26 通过；Agent 已重新打包安装为 `kff-agent-0.1.53-win32-x64-7f1bf4d37bad`，能力证据已刷新到当前实现摘要，运行 ID `5516f7db-7690-4f8c-9012-517960a7dc6b`，`adapter_match=true`。

**下一步（需用户授权）**：跑一次**收件专项诊断读取**（8、10 号各 1 轮收件，每轮最多 3 个会话、25 条消息，不搜索、不发送），用新留证拿到真实异常类别与信息，再决定是修代码还是重跑完整窗口。这比再消耗一次完整窗口更省，也不会重复搜索。

### 9.6 收件专项诊断：失败在"读完之后核对账号身份"（保留记录）

用户授权后于 `05:25:19Z`–`05:40:23Z` 执行。两个账号各实际跑了一次收件（`e6da4370…`、`3097580d…`），**都在 `facebook-inbox-identity-after` 阶段 BLOCKED / EXECUTOR_ERROR**：也就是**收件读取本身没有报错，失败发生在读完之后重新核对操作账号身份**的那一步（读完之后浏览器/目标页不可用）。两个账号同阶段失败，指向环境或浏览器连接层面，而不是某个账号或某个会话，也**不是** 0.1.53 只读路径与会话身份判断的缺陷。按约定作为运行安全异常停止，没有降级成局部跳过。没有 `page_committed`，因此没有读取、没有入库。

**又发现并修掉一个留证缺口**：第一次补的 `error_kind`/`error_message` 只进了 action report，而报告正文不落库（`action.reported` 只记 outcome/error_code/evidence_kind），所以仍看不到原因。现在 `buildDiagnostic()` 把这两个字段一起写进 `kff.diagnostic_bundles`（允许清单内，仍不含消息正文、DOM、截图、Cookie）。

**状态**：Agent 重新打包安装为 `kff-agent-0.1.53-win32-x64-09426d5344c9`；契约 194/194、typecheck、build 通过；能力证据已刷新到当前实现摘要；运行 ID `a7d7a836-12b2-4d7f-85ee-3210dcf66311`，`adapter_match=true`；监控全部 PAUSED、未关闭命令 0、两个 Profile Inactive、真实发送关闭。

**记录在案的操作痕迹**：为定位"为什么没有任务"，做过一次单发 SCAN 本地探针；它缺少运行时开关变量，在 enqueue 阶段被拒（`LIVE_DISABLED`）且事务整体回滚，没有留下任务/run/action/job，只在监控行留了一个 `last_error_code` 标记并已最小范围清空。探针没有打开账号、没有平台动作。

**下一步（需用户授权）**：再用同一个收件专项诊断跑一次（每号 1 轮、不搜索、不发送），这次会拿到确切的错误类别与信息，用于区分"浏览器/网络在读取期间掉线"与"会话需要人工重新登录"。

### 9.7 真相：会话其实读到了，是新增契约把报告拒了（已修，本地全绿）

第 2 次收件诊断（`05:45`–`05:50`）拿到了确切原因，来自 `kff.diagnostic_bundles`：

> `error_kind = ZodError`，`error_message = discovery.threads[0]：读到的会话必须保留输入框或只读原因证据`

**含义**：会话**确实读到了**（8 号与 10 号都在约 72 秒内读完 3 个会话才进入账号身份复核），但报告在 `browserInboxPage.parse()` 被 0.1.53 自己新增的契约拒绝。原因是我在"已接受输入框"这条路径上沿用了旧写法：`resolveThreadComposer` 成功时把 `surface` 置成 `null`，于是读到的会话既没有 `composer_surface` 也没有 `read_only_reason`。拒绝发生在 parse 阶段，被 executor 归类成 `EXECUTOR_ERROR`，读到的内容被丢弃、没有入库——看起来像"收件又崩了"。这条路径改动前后相同，所以 0.1.51 窗口的收件失败里也含同一个原因。

**修复**（不是放宽契约）：

1. `resolveThreadComposer` 无条件返回事实型 `surface`，成功时不再置 `null`；
2. `discovery.threads.push` 与 `discovery.observed` 统一使用同一个 `evidence` 值，结构上不可能再漏；
3. 新增浏览器回归用例 `every read conversation carries the evidence its window contract requires`，对已接受输入框和只读两条路径都把结果送进 `browserInboxPage.parse`——**未修前会红，修后通过**。

**本地验证**：浏览器回归 **27/27**、契约 **194/194**、typecheck、build 全部通过。Agent 重新打包安装为 `kff-agent-0.1.53-win32-x64-7b5073d59dc3`；能力证据已刷新；运行 ID `05aab051-c9ec-498f-8ccd-2bd9f9fee23e`，`adapter_match=true`；未关闭命令 0、监控全部 PAUSED、两个 Profile Inactive。

**结论（对用户的实话）**：三次真实读取尝试（第 3 次窗口 + 两次收件诊断）都读到了会话，但都因为这一处证据缺失被自己的契约丢弃，所以数据库里仍然没有任何 Inbox 读取记录，也没有发送。这不是平台问题、不是账号问题，也不是身份判断问题。修复后需要一次新的授权窗口来取得真实入库与覆盖率证据。

### 9.8 第 4 次窗口：Inbox 只读路径在真实账号上通过（1870.85 秒）

用户授权完整只读窗口（`approved_at=05:58:27.135Z`）。窗口 `05:58:38.449Z`–`06:29:49.299Z`，8 条命令：

- **收件两轮全部成功**：8 号 3 个会话、10 号 2 个会话，**读到 5、跳过 0、失败 0、覆盖率 1.0**（`fully_read=true`）；`unparsed_rows=0`，两页都 `window_limited=false`。
- **只读路径首次在真实账号上被用到**：8 号这一轮有 1 个会话是"观察不到输入框"仍安全读到的（`discovery.observed=["THREAD_COMPOSER_ABSENT"]`）——正是用户第 5 条指令要的只读路径。
- 入库：8 号可见消息 10 条全部去重（`stored=0/duplicates=10`）；10 号 `stored=1/duplicates=8`，这一条被判定为**我们自己的回执**（自有 echo），所以没有新增 `messages` 行，总数仍 140。**本次窗口没有新的客户来信需要入库**。
- 搜索与接续：两号各一轮搜索（各 2 条来源、`PARTIAL/MAX_PAGES`）并各自派生评论接续（`COMPLETED/SOURCE_EXHAUSTED`，读到 6 条与 2 条评论），新增 3 条 NEW 线索（score 50，关键词匹配）。
- 关闭与身份：8 条命令全部有本地 Guardian 与数据库一致的关闭证明；`serialized=true`、`identity_matches=true`、`platform_submissions=0`；两个 Profile 复查 Inactive。
- **唯一异常**：第 7 条（8 号第 2 轮搜索）报 `SOURCE_WINDOW_ENDED`——第 1 轮自动派生的评论来源已过 1 小时有效期，既有来源窗口规则按设计拦截；第 8 条随即取消。窗口按"运行安全异常停止"约定停止，但**收件两轮已经跑完**。

**结论**：0.1.53 的收件只读路径、局部异常隔离与覆盖率计数在真实账号上按设计工作。`live_composer_fix_acceptance` 的真实窗口部分已经取得；仍缺的是新的自然来信入库样本（本次窗口没有新来信）。
