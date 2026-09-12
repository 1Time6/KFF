import {randomUUID} from 'node:crypto';
import {query} from '../../packages/database/src/index';
import {localIds} from '../../scripts/seed';
import type {Scope,AgentCommand,ActionReport} from '../../packages/contracts/src/index';
import {receptionPolicy,type FacebookEvent,type ReceptionPolicy} from '../../packages/contracts/src/lead';
import {configureReceptionPolicy} from '../../packages/core/src/reception-worker';
import {createFacebookFixture,configureFacebook,injectFacebookFixture} from '../../packages/core/src/facebook-inbound';
import {configureWhatsapp} from '../../packages/core/src/lead-reception';
import {dispatchOne,claimCommand,acceptReport} from '../../packages/core/src/execution';
import {recordQuiescence} from '../../packages/core/src/reconciliation';
export const leadScope:Scope={organization_id:localIds.organization,brand_id:localIds.brand,user_id:localIds.user,role:'admin'};
export const leadAgent={id:localIds.agent,organization_id:localIds.organization,brand_id:localIds.brand,status:'ONLINE'};
export const leadEvent=(page:string,overrides:Partial<FacebookEvent>={}):FacebookEvent=>({event_id:'m_'+randomUUID(),page_id:page,sender_id:'999888777666555',body:'Please tell me more about the product',kind:'MESSAGE',display_name:'本地测试客户',occurred_at:new Date().toISOString(),source:{kind:'MESSENGER',page_id:page,source_id:null,ref:'campaign_one',ad_id:'456'},has_attachment:false,...overrides});
export async function clearLeads(){
  const name=(await query('SELECT current_database() AS name'))[0].name;if(name!==process.env.KFF_TEST_DATABASE||!/^kff_test_[a-f0-9]{20}$/.test(name))throw new Error('Isolated test database required');
  await query('TRUNCATE kff.facebook_connections,kff.whatsapp_destinations,kff.site_channels,kff.customers,kff.tasks CASCADE');
  await query("DELETE FROM kff.inbound_events WHERE source_kind='facebook'");
  await query('UPDATE kff.organizations SET outbound_paused=false');await query('UPDATE kff.brands SET outbound_paused=false');await query('UPDATE kff.accounts SET outbound_paused=false');
  await query("UPDATE kff.environments SET state='IDLE'");await query("UPDATE kff.agents SET status='ONLINE',heartbeat_at=clock_timestamp() WHERE id=$1",[localIds.agent]);
}
export async function seedLead(options:{agent_id?:string;scope?:Scope;auto_reply?:boolean;event?:Partial<FacebookEvent>;policy?:Partial<ReceptionPolicy>}={}){
  const scope=options.scope??leadScope,page=BigInt('0x'+randomUUID().replaceAll('-','')).toString();
  const account=await createFacebookFixture(scope,{request_id:randomUUID(),name:'Messenger '+page.slice(-5),page_id:page,agent_id:options.agent_id??localIds.agent});
  const config={request_id:randomUUID(),...account,expected_version:0,state:'ACTIVE' as const,auto_reply:options.auto_reply??true,reply_window_hours:24,policy_ref:'fixture.messenger.service-window.v1'};
  await configureFacebook(scope,config);if(options.policy)await configureReceptionPolicy(scope,{request_id:randomUUID(),account_id:account.account_id,expected_version:1,policy:receptionPolicy.parse(options.policy)});const event=leadEvent(page,options.event),result=await injectFacebookFixture(scope,account.account_id,event);
  return {...account,...result,conversation_id:result.conversation_id!,customer_id:result.customer_id!,page,event,config};
}
export async function seedDestination(account_id:string|null=null,phone='15550001111'){
  return configureWhatsapp(leadScope,{request_id:randomUUID(),account_id,expected_version:0,name:'WhatsApp sales',phone,state:'ACTIVE',template:'欢迎添加销售 WhatsApp：{whatsapp_url}',cooldown_hours:24});
}
export async function claimLead(){await dispatchOne();const command=await claimCommand(leadAgent);if(!command)throw new Error('Expected a message command');return command;}
export function successReport(command:AgentCommand):ActionReport{return {event_id:randomUUID(),command_id:command.id,outcome:'VERIFIED_SUCCEEDED',receipt:{remote_id:'synthetic_'+randomUUID(),actual_account_id:command.snapshot.external_account_id,recipient_id:command.snapshot.message!.contact.remote_id,content_hash:command.snapshot.content_hash,evidence_kind:'synthetic_message',observed_at:new Date().toISOString()},diagnostic:{step:'message-accepted'}};}
export async function closeCommand(command:AgentCommand,report:ActionReport){await acceptReport(leadAgent,report);await recordQuiescence(leadAgent,command.id,{protocol_version:'kff.guardian-closure.v1',command_id:command.id,action_id:command.action_id,closed_at:new Date().toISOString(),proof_sha256:'c'.repeat(64)});}
