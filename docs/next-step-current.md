# 当前优先级：Facebook → WhatsApp

当前用户目标已覆盖退款后暂停；优先级依据为 [ADR-020](decisions/020-facebook-whatsapp-priority.md)。P0 接待与可靠发送、P1 标签/话术/引流统计已实施，最终本地验收记录以 [40 项审计](kff-lead-generation-status.md) 为准。

继续使用现有客户、会话、任务、Worker、Agent、guardian 和证据链。商品、订单、支付、退款保持冻结。KFF 与其他项目数据独立。下一阶段只在取得真实 Page/App 权限、受控验证条件后做 Facebook 联调；模型接口配置与真实语言/质量验证也单独验收，不自动放开生产能力。

本地操作入口：`/inbox`、`/customers`、`/lead-analytics`。额外 Agent 使用各自配对文件和独立运行目录。已提交的未知动作继续核验原结果，未关闭 guardian 不释放资源。说明见 [引流 API](api/facebook-leads.md)。

P2 高级批量、导出增强、运营报表和更多规则可另行安排。旧 134 项任务账本及退款检查点保留历史范围，不等于本轮或整个项目完成。
