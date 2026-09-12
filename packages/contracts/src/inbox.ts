import {z} from 'zod';

const uuid=z.string().uuid();
export const channelInput=z.object({
  request_id:uuid,name:z.string().trim().min(1).max(80),is_synthetic:z.boolean(),
  session_hours:z.number().int().min(1).max(720),reply_window_hours:z.number().int().min(1).max(168),
  sessions_per_minute:z.number().int().min(1).max(1000),messages_per_minute:z.number().int().min(1).max(10000),
}).strict();
export const channelControlInput=z.object({request_id:uuid,expected_version:z.number().int().positive(),state:z.enum(['ACTIVE','PAUSED']),reason:z.string().trim().min(1).max(300)}).strict();
export const inboundMessageInput=z.object({
  client_message_id:uuid,body:z.string().trim().min(1).max(5000),
  display_name:z.string().trim().min(1).max(80).nullable(),client_sent_at:z.string().datetime().nullable(),
}).strict();
export const customerStages=['NEW_INQUIRY','QUALIFYING','FOLLOWING_UP','IN_PROGRESS','QUALIFIED_INQUIRY','WON','DELIVERING','DELIVERED','LOST','OPTED_OUT'] as const;
export const customerUpdateInput=z.object({
  request_id:uuid,expected_version:z.number().int().positive(),display_name:z.string().trim().min(1).max(80).nullable(),
  owner_user_id:uuid.nullable(),stage:z.enum(customerStages),reason:z.string().trim().min(1).max(500),
}).strict();
export const customerNoteInput=z.object({request_id:uuid,text:z.string().trim().min(1).max(2000)}).strict();
export const conversationPageInput=z.object({after:z.string().regex(/^(0|[1-9][0-9]{0,8})$/).default('0'),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
export type InboundMessageInput=z.infer<typeof inboundMessageInput>;
export interface SiteChannel {id:string;name:string;account_id:string;state:'ACTIVE'|'PAUSED';version:number;is_synthetic:boolean;session_hours:number;reply_window_hours:number;sessions_per_minute:number;messages_per_minute:number;created_at:string}
export interface Customer {id:string;display_name:string|null;owner_user_id:string|null;stage:typeof customerStages[number];version:number;created_at:string;updated_at:string;first_inquiry_event_id:string}
export interface InboxConversation {id:string;customer_id:string;channel_id:string;identity_id:string;last_sequence:number;last_message_at:string;reply_window_expires_at:string;display_name:string|null;stage:Customer['stage'];owner_user_id:string|null;channel_name:string;is_synthetic:boolean;opted_out:boolean;contact_target_id:string}
export interface InboxMessage {id:string;conversation_id:string;sequence:number;direction:'INBOUND';body:string;received_at:string;client_sent_at:string|null;inbound_event_id:string}
export interface MessagePage {messages:InboxMessage[];next_after:string;has_more:boolean}
