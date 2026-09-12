export const leadNames:Record<string,string>={NEW:'新客户',ENGAGED:'接待中',QUALIFIED:'有效咨询',WHATSAPP_REFERRED:'已发送 WhatsApp 邀请',HANDOFF_COMPLETE:'已交销售跟进',IGNORED:'忽略',BLOCKED:'停止接待'};
export const modeNames:Record<string,string>={AI:'自动接待',HUMAN:'人工接待',PAUSED:'暂停接待'};
export const intentNames:Record<string,string>={UNKNOWN:'待判断',LOW:'低意向',MEDIUM:'中意向',HIGH:'高意向'};
export const sourceNames:Record<string,string>={MESSENGER:'Facebook 私信',COMMENT:'Facebook 评论',INTERACTION:'Facebook 互动',UNKNOWN:'未知'};
export const actionNames:Record<string,string>={READY:'排队中',QUEUED:'排队中',LEASED:'正在判断',DONE:'判断完成',DEAD:'已转人工',PREPARING:'准备发送',SUBMITTING:'提交中',SUBMITTED:'提交中',UNKNOWN_OUTCOME:'结果未知，需核验',VERIFIED_SUCCEEDED:'已确认发送',VERIFIED_FAILED:'已确认失败',BLOCKED:'已阻止',CANCELED:'已取消',NEEDS_HUMAN:'需人工核验',REFERRED:'已确认发送邀请',CONFIRMED:'人工确认已联系',DECLINED:'人工记录未添加',UNKNOWN:'结果未知',FAILED:'发送失败',REPLY:'基础回复',ASK_QUESTION:'追问需求',REFER_WHATSAPP:'引导 WhatsApp',HANDOFF:'转人工',STOP:'停止接待'};
