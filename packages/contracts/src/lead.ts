import {z} from 'zod';
import {contactSelectionSchema} from './contact';

const uuid=z.string().uuid();
const remote=z.string().regex(/^[0-9]{1,128}$/);
export const leadStatuses=['NEW','ENGAGED','QUALIFIED','WHATSAPP_REFERRED','HANDOFF_COMPLETE','IGNORED','BLOCKED'] as const;
export const leadStatus=z.enum(leadStatuses);
export type LeadStatus=z.infer<typeof leadStatus>;
export const intentLevel=z.enum(['UNKNOWN','LOW','MEDIUM','HIGH']);
export const handlingMode=z.enum(['AI','HUMAN','PAUSED']);
export const leadSource=z.object({kind:z.enum(['MESSENGER','COMMENT','INTERACTION']),page_id:remote,source_id:z.string().max(200).nullable(),ref:z.string().max(300).nullable(),ad_id:remote.nullable()}).strict();
export const facebookEvent=z.object({
  event_id:z.string().min(1).max(400),page_id:remote,sender_id:remote,
  kind:z.enum(['MESSAGE','COMMENT','INTERACTION','ECHO']),body:z.string().min(1).max(5000).refine(value=>value.trim().length>0,'消息不能为空白'),
  display_name:z.string().max(80).nullable(),occurred_at:z.string().datetime(),source:leadSource,
  has_attachment:z.boolean().default(false),
  correlation_id:uuid.optional(),
}).strict().refine(value=>value.page_id===value.source.page_id&&value.source.kind===(value.kind==='COMMENT'?'COMMENT':value.kind==='INTERACTION'?'INTERACTION':'MESSENGER'),'来源与事件不一致');
export type FacebookEvent=z.infer<typeof facebookEvent>;
export const facebookConnectionInput=z.object({request_id:uuid,account_id:uuid,environment_id:uuid,expected_version:z.number().int().min(0),state:z.enum(['ACTIVE','PAUSED']),auto_reply:z.boolean(),reply_window_hours:z.number().int().min(1).max(24),policy_ref:z.string().trim().min(5).max(160)}).strict();
export const facebookFixtureInput=z.object({request_id:uuid,name:z.string().trim().min(1).max(80),page_id:remote,agent_id:uuid}).strict();
export const leadUpdateInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),lead_status:leadStatus,tags:z.array(z.string().trim().min(1).max(30)).max(20),intent_level:intentLevel,valid_inquiry:z.boolean(),reason:z.string().trim().min(1).max(500)}).strict();
export const conversationControlInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),mode:handlingMode,reason:z.string().trim().min(1).max(500)}).strict();
export interface FacebookConnection {account_id:string;environment_id:string;page_id:string;is_synthetic:boolean;state:'ACTIVE'|'PAUSED';version:number;auto_reply:boolean;reply_window_hours:number;policy_ref:string;display_name:string;reception_policy:Partial<ReceptionPolicy>}
export const receptionPolicy=z.object({
  provider:z.enum(['LOCAL_RULES','OPENAI_COMPATIBLE']).default('LOCAL_RULES'),business_context:z.string().trim().max(3000).default(''),
  greeting_reply:z.string().trim().min(1).max(1000).default('你好，欢迎咨询。你想了解哪一款产品或服务？'),
  question_reply:z.string().trim().min(1).max(1000).default('了解了。你主要想了解哪方面，或者有哪些具体需求？销售同事可以在 WhatsApp 继续为你介绍。'),
  qualification_keywords:z.array(z.string().trim().min(1).max(40)).max(40).default(['产品','价格','了解','需要','购买','product','price','buy','interested','available']),
  referral_after_replies:z.number().int().min(0).max(5).default(1),min_confidence:z.number().min(0.5).max(1).default(0.7),
  max_replies_per_conversation:z.number().int().min(1).max(20).default(6),max_account_replies_per_day:z.number().int().min(1).max(1000).default(100),
  min_reply_interval_seconds:z.number().int().min(0).max(3600).default(10),stop_after_referral:z.boolean().default(true),
}).strict();
export type ReceptionPolicy=z.infer<typeof receptionPolicy>;
export const receptionPolicyInput=z.object({request_id:uuid,account_id:uuid,expected_version:z.number().int().positive(),policy:receptionPolicy}).strict();
export const receptionDecision=z.object({
  action:z.enum(['REPLY','ASK_QUESTION','REFER_WHATSAPP','HANDOFF','STOP']),intent:z.enum(['GREETING','PRODUCT','PRICING','WHATSAPP','COMPLAINT','UNSUBSCRIBE','SPAM','OTHER']),
  valid_inquiry:z.boolean(),intent_level:intentLevel,confidence:z.number().min(0).max(1),reply:z.string().max(1600),reason:z.string().min(1).max(500),tags:z.array(z.string().trim().min(1).max(30)).max(10),
}).strict();
export type ReceptionDecision=z.infer<typeof receptionDecision>;
export const whatsappDestinationInput=z.object({request_id:uuid,account_id:uuid.nullable(),expected_version:z.number().int().min(0),name:z.string().trim().min(1).max(80),phone:z.string().regex(/^[1-9][0-9]{6,14}$/),state:z.enum(['ACTIVE','PAUSED']),template:z.string().trim().min(1).max(1500).refine(value=>value.includes('{whatsapp_url}'),'话术必须包含 {whatsapp_url}'),cooldown_hours:z.number().int().min(1).max(720)}).strict();
export interface WhatsappDestination {id:string;account_id:string|null;name:string;phone:string;state:'ACTIVE'|'PAUSED';version:number;template:string;cooldown_hours:number}
export const replyInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),body:z.string().trim().max(2000),refer_whatsapp:z.boolean(),fixture_scenario:z.enum(['normal','slow','lost_after_submit']).default('normal')}).strict().refine(value=>value.refer_whatsapp||value.body.length>0,'回复内容不能为空');
export const referralResultInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),result:z.enum(['CONFIRMED','DECLINED']),reason:z.string().trim().min(1).max(500)}).strict();
export const messageSnapshot=z.object({
  conversation_id:uuid,trigger_message_id:uuid,trigger_sequence:z.number().int().positive(),control_version:z.number().int().positive(),
  actor_kind:z.enum(['AI','HUMAN']),actor_id:uuid,connection_version:z.number().int().positive(),
  contact:contactSelectionSchema,
  stop_epochs:z.object({organization:z.number().int().min(0),brand:z.number().int().min(0),account:z.number().int().min(0),agent:z.number().int().min(0)}).strict(),
  referral:z.object({destination_id:uuid,destination_version:z.number().int().positive(),phone:z.string().regex(/^[1-9][0-9]{6,14}$/),template:z.string().max(1500),cooldown_hours:z.number().int().positive()}).strict().nullable(),
}).strict();
