# Generate the KFF new-computer install & usage tutorial PDF.
# Requires: python + reportlab + Windows CJK fonts.
#
# Layout rules learned the hard way, do not "simplify" these:
#  1. reportlab Paragraph markup eats "\X" as a tag, so a path like .kff\本地登录.txt
#     silently loses its tail. Write Windows paths with "/" in prose.
#  2. Consolas has no CJK glyphs, so any Chinese inside a code block or a MONO span
#     renders as tofu boxes. Chinese only ever uses the YaHei faces.
import os
import re
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

OUT = r"C:\Users\17731\Desktop\KFF-交付-0.1.53\KFF新电脑安装与使用教程.pdf"
FONTS = r"C:\Windows\Fonts"
ENTRY = "kff-controller-0.1.53-win32-x64-e3d87581551d.zip"
SHA = "7ad2436a82785c8f79d2972f03ad947128084aa17e1f67cbee11e6b81ff05949"

pdfmetrics.registerFont(TTFont("YH", os.path.join(FONTS, "msyh.ttc"), subfontIndex=0))
pdfmetrics.registerFont(TTFont("YHB", os.path.join(FONTS, "msyhbd.ttc"), subfontIndex=0))
pdfmetrics.registerFont(TTFont("HEI", os.path.join(FONTS, "simhei.ttf")))
pdfmetrics.registerFont(TTFont("MONO", os.path.join(FONTS, "consola.ttf")))

DARK = colors.HexColor("#15202b")
GRAY = colors.HexColor("#4a5568")
ACCENT = colors.HexColor("#0b6bcb")
WARN_BG, WARN_LINE = colors.HexColor("#fff7ed"), colors.HexColor("#ea8b0b")
STOP_BG, STOP_LINE = colors.HexColor("#fef2f2"), colors.HexColor("#d92d20")
OK_BG, OK_LINE = colors.HexColor("#f0fdf4"), colors.HexColor("#12805c")
CODE_BG = colors.HexColor("#f4f6f8")

getSampleStyleSheet()


def st(name, **kw):
    base = dict(name=name, fontName="YH", fontSize=10, leading=15.5, textColor=DARK)
    base.update(kw)
    return ParagraphStyle(**base)


H1 = st("H1", fontName="HEI", fontSize=17, leading=23, textColor=ACCENT, spaceBefore=2, spaceAfter=9)
H2 = st("H2", fontName="YHB", fontSize=12.5, leading=18, textColor=DARK, spaceBefore=9, spaceAfter=4)
H3 = st("H3", fontName="YHB", fontSize=10.5, leading=15, textColor=ACCENT, spaceBefore=6, spaceAfter=3)
BODY = st("BODY", spaceAfter=5)
BULLET = st("BULLET", leftIndent=13, bulletIndent=2, firstLineIndent=0, spaceAfter=3, leading=15.5)
STEP = st("STEP", leftIndent=16, bulletIndent=1, firstLineIndent=0, spaceAfter=4, leading=15.5)
CODE = st("CODE", fontName="MONO", fontSize=9, leading=13.5, backColor=CODE_BG,
          borderPadding=(5, 5, 5, 5), textColor=colors.HexColor("#0f172a"), spaceAfter=6)
CAP = st("CAP", fontSize=8.5, leading=12, textColor=GRAY, spaceAfter=6)
TITLE = st("TITLE", fontName="HEI", fontSize=25, leading=32, textColor=DARK, alignment=TA_CENTER)
SUBTITLE = st("SUBTITLE", fontSize=11.5, leading=17, textColor=GRAY, alignment=TA_CENTER)
NOTE = st("NOTE", fontSize=9.5, leading=14.5)
FINAL = st("FINAL", fontName="YHB", fontSize=10.5, leading=16, textColor=ACCENT)


def P(t, s=BODY):
    return Paragraph(t, s)


def code(*lines):
    """Code block. Paragraph does NOT honour newlines, so join with <br/>.
    Consolas carries no CJK glyphs, so any Chinese run falls back to YaHei."""
    joined = "<br/>".join(lines)
    joined = re.sub(r"[^\x00-\x7f]+", lambda m: "<font face='YH'>" + m.group(0) + "</font>", joined)
    return Paragraph(joined, CODE)


def B(t, mark="\u2022"):
    return Paragraph(t, BULLET, bulletText=mark)


def N(t, n):
    return Paragraph(t, STEP, bulletText=n)


def note(t, kind="warn"):
    bg, line = {"warn": (WARN_BG, WARN_LINE), "stop": (STOP_BG, STOP_LINE), "ok": (OK_BG, OK_LINE)}[kind]
    tbl = Table([[Paragraph(t, NOTE)]], colWidths=[168 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, line),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return [Spacer(1, 3), tbl, Spacer(1, 6)]


def table(rows, widths, header=True, size=9):
    data = []
    for r_i, row in enumerate(rows):
        cells = []
        for c in row:
            style = st("tc", fontName="YHB" if (header and r_i == 0) else "YH",
                       fontSize=size, leading=size + 4.5,
                       textColor=colors.white if (header and r_i == 0) else DARK)
            cells.append(Paragraph(str(c), style))
        data.append(cells)
    tbl = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d7dee6")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2c3e50")))
    for i in range(1 if header else 0, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f7f9fb")))
    tbl.setStyle(TableStyle(style))
    return tbl


story = []

# ---------- cover ----------
story += [Spacer(1, 6), P("KFF 运营工作台", TITLE), P("新电脑安装与使用教程", SUBTITLE), Spacer(1, 4)]
story += [table([
    ["适用版本", "kff-controller 0.1.53（Windows x64）"],
    ["适用场景", "在一台全新电脑上安装、启动、验收和日常使用"],
    ["前置要求", "64 位 Windows 10 / 11；不需要安装 Node、pnpm、PostgreSQL"],
    ["配套文件", ENTRY],
    ["压缩包校验值", SHA],
    ["整理日期", "2026-09-16"],
], [24 * mm, 144 * mm], header=False, size=9), Spacer(1, 8)]
story += note("本教程描述的是<b>交付包模式</b>：装完从零开始、空工作区。"
              "与开发机上的 KFF-Start.cmd 玩法不同，两套不要混用（见第八章）。", "ok")

# ---------- 1 ----------
story += [P("一、装之前先做两件事", H1)]
story += [P("1.1 只带两个文件", H2)]
story += [P("把这个文件夹里的 <b>zip</b> 和 <b>.sha256</b> 两个文件拷到新电脑即可。")]
story += note("<b>绝对不要</b>拷贝旧电脑的整个 KFF 文件夹，尤其是 .kff 目录 —— "
              "里面有数据库、登录密码、Agent 配对令牌和浏览器登录数据。", "stop")
story += [P("1.2 校验压缩包（防止传输损坏）", H2)]
story += [P("在新电脑上打开 PowerShell，切到这两个文件所在目录，执行下面这条命令：")]
story += [code("certutil -hashfile " + ENTRY + " SHA256")]
story += [P("输出必须等于下面这一串（不区分大小写）。对不上就重新拷一次，不要继续安装：")]
story += [code(SHA)]
story += [P("1.3 确认端口没被占用", H2)]
story += [P("工作台固定用 3000 端口，数据库默认用 55432。新电脑上一般不会被占用，"
            "但先确认一下更稳妥。在 PowerShell 里逐条执行：")]
story += [code("Test-NetConnection 127.0.0.1 -Port 3000  -InformationLevel Quiet",
               "Test-NetConnection 127.0.0.1 -Port 55432 -InformationLevel Quiet")]
story += [P("两条都返回 <b>False</b> 就说明端口空闲，可以继续。<br/>"
            "返回 True 表示被占用：3000 必须先关掉占用它的软件；55432 安装时加参数换一个（见 2.2）。")]

# ---------- 2 ----------
story += [P("二、安装（四步，一步一确认）", H1)]
story += [P("2.1 解压", H2)]
story += [P("解压到<b>纯英文新路径</b>，例如 C:/KFF/0.1.53，保留完整目录结构。")]
story += note("数据库目录暂不支持中文路径，不要解压到“桌面/新建文件夹”这类位置。", "warn")
story += [P("2.2 依次执行四条命令", H2)]
story += [P("进入解压后能看到 controller.cmd 的那一层目录，在<b>该目录</b>打开 PowerShell，"
            "按顺序执行（注意命令开头的 <b>.\\</b> 不能省）：")]
story += [code(".\\controller.cmd verify     (1) check the package",
               ".\\controller.cmd setup      (2) create database + account",
               ".\\controller.cmd start      (3) start the workbench",
               ".\\controller.cmd status     (4) show component status")]
story += [P("如果 55432 被占用，第 2 条改成：", CAP)]
story += [code(".\\controller.cmd setup --database-port 55439")]
story += [P("2.3 四条命令分别会发生什么", H2)]
story += [table([
    ["命令", "作用", "成功的样子"],
    ["verify", "逐项校验包内 2 万多个文件有没有损坏或被改动", "打印校验通过，无报错"],
    ["setup", "启动内置数据库、建库、跑结构迁移、创建初始账号", "最后打印一段 JSON，含 \"empty_workspace\": true"],
    ["start", "启动工作台网页、后台 Worker、本机 Agent", "提示已启动，浏览器可打开"],
    ["status", "查看三个组件各自的状态", "三个都是 RUNNING"],
], [19 * mm, 92 * mm, 57 * mm])]
story += [Spacer(1, 4)]
story += note("(1) <b>setup 只能跑一次。</b>目录里已经有 .kff 时会被直接拒绝。"
              "(2) setup 跑完数据库会自动停掉，这是正常的。"
              "(3) 安装失败请保留整个目录和日志，<b>不要删除后重建</b>。", "warn")

# ---------- 3 ----------
story += [P("三、登录", H1)]
story += [P("浏览器打开 <b>http://127.0.0.1:3000</b>。账号密码在安装目录的 "
            ".kff/本地登录.txt 里（setup 自动生成）：")]
story += [table([
    ["地址", "http://127.0.0.1:3000"],
    ["账号", "operator@kff.local"],
    ["密码", "随机生成，见 .kff/本地登录.txt"],
], [24 * mm, 144 * mm], header=False)]
story += note("这个文件属于本机隐私，不要发给别人，也不要拷回旧电脑。", "stop")
story += [P("首次登录后各页面都是空的：没有客户、没有线索、没有账号。<b>这是正常的</b>，"
            "这个包装出来的就是空工作区，只创建了本机操作者、默认品牌和一个本机 Agent。")]

# ---------- 4 ----------
story += [P("四、界面地图（左侧菜单 14 个页面）", H1)]
story += [table([
    ["分类", "页面", "作用"],
    ["基础设置", "账号中心", "登记平台账号与凭据引用"],
    ["", "环境中心", "绑定本机 Agent、识别浏览器环境（AdsPower 相关）"],
    ["", "能力与验证", "查看每个动作当前允许做到哪一步"],
    ["日常使用", "主动获客与自动执行", "设关键词和来源，持续发现潜客"],
    ["", "客户收件箱", "接收咨询、人工回复、记录 WhatsApp 引流"],
    ["", "客户档案", "维护客户负责人、阶段和跟进备注"],
    ["", "引流统计与日志", "看来源、有效咨询和引流证据"],
    ["", "执行总览", "看任务进展、处理待人工确认的结果"],
    ["进阶功能", "任务工作台", "确认账号、动作、内容后把任务放进执行队列"],
    ["", "运行记录", "从提交到结果核实的完整过程"],
    ["", "查询与结果", "按来源和上限采集，核对部分结果"],
    ["", "模板与版本", "固定动作和输入范围，保留版本与预演"],
    ["", "计划与时区", "设置每日/每周规则与本地时区"],
    ["", "商品与订单", "商品版本、报价与订单（当前冻结区，暂不用）"],
], [20 * mm, 42 * mm, 106 * mm])]
story += note("当前阶段真正要用的只有“基础设置”三页 +“日常使用”那五页。"
              "商品与订单属于留存功能，现在不用管。", "ok")

# ---------- 5 ----------
story += [P("五、30 分钟上手流程（建议照顺序走一遍）", H1)]
story += [P("第 1 步：确认服务正常（2 分钟）", H3)]
story += [B("执行 .\\controller.cmd status，确认 Web / Worker / Agent 都是 RUNNING。")]
story += [B("浏览器打开 http://127.0.0.1:3000 能出现登录页。")]
story += [P("第 2 步：登录并认识页面（5 分钟）", H3)]
story += [B("用 .kff/本地登录.txt 里的账号密码登录。")]
story += [B("依次点开左侧菜单，确认每个页面都能打开、不报错。看到空列表是正常的。")]
story += [P("第 3 步：登记一个平台账号（5 分钟）", H3)]
story += [B("进入<b>账号中心</b>，登记账号并填写凭据引用。")]
story += [B("这里填的是<b>引用名</b>，不是把密码直接写进页面。真实凭据另存在本机配置文件里。")]
story += [P("第 4 步：绑定本机 Agent（5 分钟）", H3)]
story += [B("进入<b>环境中心</b>，确认本机 Agent 在线。")]
story += [B("如需在另一台机器上跑执行，在这里下载<b>一次性配对配置</b>，下载后可排空或撤销。")]
story += [P("第 5 步：走一遍获客工作台（8 分钟）", H3)]
story += [B("进入<b>主动获客与自动执行</b>，新建一个监控：选账号、来源、关键词、扫描间隔和上限。")]
story += [B("先点<b>“扫描一次”</b>，看能不能产出可读的原始字段。")]
story += [B("确认评分与状态后，再决定是否启动持续监控。<b>建议先保持暂停</b>。")]
story += [P("第 6 步：看一眼收件箱和统计（5 分钟）", H3)]
story += [B("<b>客户收件箱</b>：创建一次站内咨询入口，用访客页发一条测试消息，确认能建客户和会话。")]
story += [B("<b>引流统计与日志</b>：确认上面这条记录出现在里面，能区分新增、重复、失败和人工确认。")]
story += note("走完这六步，就完成了一次“线索入池 → 收件 → 统计”的本地闭环演练，"
              "这也是目前这个包能做的完整范围。", "ok")

# ---------- 6 ----------
story += [P("六、日常启停（每天就记这三条）", H1)]
story += [table([
    ["你要做的事", "命令（在安装目录执行）"],
    ["启动", ".\\controller.cmd start"],
    ["看状态", ".\\controller.cmd status"],
    ["正常退出", ".\\controller.cmd stop"],
    ["组件异常退出后恢复", ".\\controller.cmd recover"],
], [52 * mm, 116 * mm])]
story += [Spacer(1, 4)]
story += note("<b>关闭一律用 stop。</b>不要用任务管理器结束进程 —— "
              "会把等待中的任务和浏览器关闭回执打断。", "stop")
story += [P("status 的三种结果：", CAP)]
story += [B("<b>RUNNING</b>：三个组件都正常。")]
story += [B("<b>DEGRADED</b>：有组件退出了，执行 .\\controller.cmd recover。")]
story += [B("<b>STOP_BLOCKED / CONTROL_UNAVAILABLE</b>：先看具体报错信息，不要直接再启动一套，"
            "也不要强删锁文件，把报错发给我。")]

# ---------- 7 ----------
story += [P("七、出问题怎么办", H1)]
story += [P("7.1 常见问题对照表", H2)]
story += [table([
    ["现象", "原因与处理"],
    ["setup 报端口被占用", "3000 必须先腾出来；55432 用 --database-port 55439 换端口"],
    ["setup 报 Fresh Windows<br/>installation required",
     "三种原因：①目录里已有 .kff（换新目录）②当前不在包根目录（先 cd 进去）"
     "③系统设了 DATABASE_URL 环境变量（先清掉）"],
    ["登录后页面全是空的", "正常。这个包就是空工作区，没有客户和线索"],
    ["打不开 http://127.0.0.1:3000", "先 status 看 Web 是否 RUNNING；确认地址就是 127.0.0.1:3000，不是 https"],
    ["装完发现用不了<br/>Facebook / 收件 / 发送", "正常。包内不含 AdsPower 和平台账号，这些要另配（见 7.2）"],
], [50 * mm, 118 * mm])]
story += [P("7.2 这个包现在做不到什么（重要）", H2)]
story += [P("包里<b>不含</b> AdsPower、平台账号登录、代理和任何模型 API Key。"
            "下面这些现在做不了，不是装坏了：")]
story += [B("Facebook 关键词真实搜索、读取指定帖子评论")]
story += [B("Messenger 真实收件和真实消息读取")]
story += [B("任何真实发送、WhatsApp 实际移交")]
story += [B("AdsPower Profile 绑定与账号身份核对")]
story += [B("AI 辅助接待（没配模型 Key 时不可用）")]
story += [P("等新电脑装好 AdsPower、配好 Local API Key 并登录账号后，再单独做真实读取的验收。")]
story += [P("7.3 遇到问题给开发方什么", H2)]
story += [B("操作时间（具体到分钟）、执行的命令和当时所在目录")]
story += [B("完整错误原文（截图或文字都可以）")]
story += [B("涉及启停问题时，附上 .kff/local-runtime/ 下的日志")]
story += note("<b>不要</b>提供密码、API Key 或 .kff/本地登录.txt 的内容。", "stop")

# ---------- 8 ----------
story += [P("八、五条硬规则", H1)]
story += [N("不要把旧电脑的整个 .kff 拷到新电脑。里面有数据库、密码、配对令牌和登录数据。", "1.")]
story += [N("不要在旧电脑上运行这个包的 setup，也不要用它覆盖旧电脑的 KFF。只用于新电脑的新目录。", "2.")]
story += [N("两台电脑不要同时跑同一套业务。新电脑开测前，先在旧电脑运行 KFF-Stop.cmd 正常停止，"
            "避免争抢同一个 AdsPower Profile。", "3.")]
story += [N("每个安装目录的 .kff 是独立数据。重复 setup 会被拒绝，不会覆盖已有数据。", "4.")]
story += [N("不要把密码、API Key、.kff 目录内容发到聊天里。", "5.")]

# ---------- 9 ----------
story += [P("九、验收状态（如实说明）", H1)]
story += [P("已经验证过的：", H3)]
story += [B("压缩包 SHA-256 与随包 .sha256 文件一致，本机复制后已再次核对")]
story += [B("完整控制端在本机隔离目录的首次初始化、登录启动、跨版本停机升级")]
story += [B("本机整套服务的正常启动、重复启动、正常停止与故障恢复")]
story += [P("还没有验证、也就是这次要补的：", H3)]
story += [B("<b>另一台真正干净电脑上的首次安装</b>（本次要做的就是这个）")]
story += [B("整机重启后的自动恢复、断电恢复")]
story += [B("Windows 登录后自动启动（当前没有配置开机自启）")]
story += [B("AdsPower 就绪后的真实平台读取与发送")]
story += [P("所以这次在新电脑上把 <b>verify → setup → start → status → stop</b> 跑通，"
            "再重启一次电脑跑一遍 start，本身就是一条有效的验收记录。"
            "请把每一步的实际输出保留下来（截图或复制文字都可以）。")]
story += note("本包由当前开发目录的最新生产构建重新封装，封包前后各做了一次完整校验，"
              "已包含此前交付版本之后的所有代码改动。包内不含 AdsPower、平台账号和任何业务数据。", "ok")

# ---------- 10 : own page, built to survive as a single sheet ----------
story += [PageBreak(), P("十、速查卡（建议单独打印这一页）", H1)]
story += [P("安装（只做一次）", H3)]
story += [code("certutil -hashfile " + ENTRY + " SHA256",
               ".\\controller.cmd verify",
               ".\\controller.cmd setup",
               ".\\controller.cmd start",
               ".\\controller.cmd status")]
story += [P("日常（每天就这三条）", H3)]
story += [code(".\\controller.cmd start     = 上班开机",
               ".\\controller.cmd status    = 确认状态",
               ".\\controller.cmd stop      = 下班关闭")]
story += [P("关键位置", H3)]
story += [table([
    ["工作台地址", "http://127.0.0.1:3000"],
    ["登录账号", "operator@kff.local"],
    ["登录信息文件", "安装目录/.kff/本地登录.txt"],
    ["运行日志", "安装目录/.kff/local-runtime/"],
    ["端口", "网页 3000，数据库 55432（可换）"],
], [30 * mm, 138 * mm], header=False)]
story += [Spacer(1, 10)]
story += [P("遇到任何报错：保留现场 → 复制错误原文 → 连同操作时间发给我。<br/>"
            "不要删目录重建，不要强杀进程。", FINAL)]


def decorate(canv, doc):
    canv.saveState()
    canv.setFont("YH", 8)
    canv.setFillColor(GRAY)
    canv.drawString(21 * mm, 12 * mm, "KFF 运营工作台 · 新电脑安装与使用教程（0.1.53）")
    canv.drawRightString(A4[0] - 21 * mm, 12 * mm, "第 %d 页" % doc.page)
    canv.setStrokeColor(colors.HexColor("#dfe5ea"))
    canv.setLineWidth(0.5)
    canv.line(21 * mm, 15.5 * mm, A4[0] - 21 * mm, 15.5 * mm)
    canv.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=21 * mm, rightMargin=21 * mm,
                      topMargin=17 * mm, bottomMargin=20 * mm,
                      title="KFF 运营工作台 · 新电脑安装与使用教程",
                      author="KFF")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=decorate)])
doc.build(story)
print("OK ->", OUT, os.path.getsize(OUT), "bytes")
