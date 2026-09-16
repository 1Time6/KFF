# 单条 WhatsApp 测试邀请

状态：用户明确回复“发啊”后已发送一次，并独立核对原 Facebook 消息；随后用户回复“WhatsApp已收到”，原移交记录已登记为 CONFIRMED，客户状态为 HANDOFF_COMPLETE。

| 项目 | 本次内容 |
|---|---|
| AdsPower 环境 | 1876794 / sjpdl-SG / k1gvdtft |
| 发送账号 | XiangHuan Master / 61589894042400 |
| 收件人 | 用户测试账号「郑一哲」/ 100050174601107 |
| 原 Messenger 会话 | 27724009533944398 |
| 已收到测试内容 | KFF 联调测试 |
| WhatsApp 接待 | 宸均 / +86 18730936793 |
| 动作数量 | 一条邀请；结果未知时核验原消息，不重复发送 |

已发送正文：

> 你好，可以通过 WhatsApp 联系宸均继续沟通：https://wa.me/8618730936793

原消息 ID：`100050174601107@msgr.7504799492323995768`，页面显示 15:13 和“5分钟前发送”。Agent 已执行一次提交；原模板未识别这种相对发送状态，曾记录 UNKNOWN_OUTCOME。独立核对原消息、双方数字身份及原关闭证明后，通过原裁定入口确认同一动作，未重发。Inbox 保存一条 OUTBOUND 和一条移交记录。

WhatsApp 到达与接手依据为用户对本轮测试的明确确认，未观察 WhatsApp 自动回调。Facebook 实际消息截图：`output/playwright/approved-whatsapp-message.png`。原任务 `4fecccc2-f6c6-43a3-8527-224c0442fad8`，原动作 `df8a42c0-9f23-4af5-b1d7-1398abb16bed`，移交记录 `e23834d4-6c30-43e4-b62e-d9736d4832e9`。

用户随后发送“KFF 增量测试”，已由安装的0.1.4 Agent经原队列入库；两轮读取后共3条来信、1条原邀请，第二轮新增0、重复4，两次关闭证明匹配。最终 Inbox 截图：`output/playwright/verified-messenger-incremental-inbox.png`。完整验收与限制见 [真实移交和增量证据](evidence/real-messenger-whatsapp-handoff.json)。
