import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {query,closePool} from '../../packages/database/src/index';
import {leadScope as scope,leadAgent as agent,seedLead,seedDestination,clearLeads,claimLead,successReport,closeCommand} from '../helpers/lead-fixture';
import {sendConversationReply,conversationReception,configureWhatsapp,referralResult} from '../../packages/core/src/lead-reception';
import {beginSubmission} from '../../packages/core/src/execution';
const request=(version:number,corrects_referral_id?:string)=>({request_id:randomUUID(),expected_version:version,body:'',refer_whatsapp:true,corrects_referral_id});
beforeAll(async()=>{await migrate();await seed();});beforeEach(clearLeads);afterAll(closePool);
async function original(min_reply_interval_seconds=0){
 const lead=await seedLead({policy:{min_reply_interval_seconds}}),destination=await seedDestination(lead.account_id);
 await sendConversationReply(scope,lead.conversation_id,request(1));const command=await claimLead();await beginSubmission(agent,command.id);await closeCommand(command,successReport(command));
 const referral=(await conversationReception(scope,lead.conversation_id)).referrals[0];return {lead,destination,command,referral};
}
async function change(x:Awaited<ReturnType<typeof original>>){return configureWhatsapp(scope,{request_id:randomUUID(),account_id:x.lead.account_id,expected_version:x.destination.version,name:x.destination.name,phone:'15550009999',state:'ACTIVE',template:x.destination.template,cooldown_hours:24});}
it('requires explicit correction, preserves the old receipt, and confirms only the corrected destination',async()=>{
 const x=await original();await change(x);
 await expect(sendConversationReply(scope,x.lead.conversation_id,request(2))).rejects.toMatchObject({code:'REFERRAL_COOLDOWN'});
 const input=request(2,x.referral.id);const a=await sendConversationReply(scope,x.lead.conversation_id,input),replay=await sendConversationReply(scope,x.lead.conversation_id,input);expect(replay.action_id).toBe(a.action_id);
 const command=await claimLead();expect(command.snapshot.message?.referral).toMatchObject({phone:'15550009999',corrects_referral_id:x.referral.id});expect(command.snapshot.body).toContain('号码更正：');expect(command.snapshot.body).not.toContain(x.destination.phone);
 await beginSubmission(agent,command.id);await closeCommand(command,successReport(command));
 const detail=await conversationReception(scope,x.lead.conversation_id),current=detail.referrals.find(r=>r.action_id===command.action_id),old=detail.referrals.find(r=>r.id===x.referral.id);
 expect(old).toMatchObject({state:'REFERRED',destination_snapshot:x.referral.destination_snapshot});expect(current).toMatchObject({state:'REFERRED'});
 const corrections=await query("SELECT details FROM kff.audit_events WHERE object_id=$1 AND event_type='whatsapp.invitation_corrected'",[x.referral.id]);expect(corrections).toHaveLength(1);expect(corrections[0].details.corrected_by_referral_id).toBe(current.id);
 await expect(referralResult(scope,x.referral.id,{request_id:randomUUID(),expected_version:old.version,result:'CONFIRMED',reason:'Wrong historical number'})).rejects.toMatchObject({code:'REFERRAL_SUPERSEDED'});
 await expect(sendConversationReply(scope,x.lead.conversation_id,request(3,x.referral.id))).rejects.toMatchObject({code:'REFERRAL_SUPERSEDED'});
 await expect(sendConversationReply(scope,x.lead.conversation_id,request(3))).rejects.toMatchObject({code:'REFERRAL_COOLDOWN'});
 await expect(referralResult(scope,current.id,{request_id:randomUUID(),expected_version:current.version,result:'CONFIRMED',reason:'Recipient confirmed the corrected number'})).resolves.toMatchObject({state:'CONFIRMED'});
});
it('rejects correction when the phone has not changed and rejects references to another conversation',async()=>{
 const x=await original();await expect(sendConversationReply(scope,x.lead.conversation_id,request(2,x.referral.id))).rejects.toMatchObject({code:'REFERRAL_CORRECTION_INVALID'});
 await change(x);const other=await seedLead();await seedDestination(other.account_id,'15550009999');await expect(sendConversationReply(scope,other.conversation_id,request(1,x.referral.id))).rejects.toMatchObject({code:'REFERRAL_CORRECTION_INVALID'});
});
it('retains the account reply interval even for an explicitly corrected number',async()=>{
 const x=await original(600);await change(x);await expect(sendConversationReply(scope,x.lead.conversation_id,request(2,x.referral.id))).rejects.toMatchObject({code:'RATE_LIMITED'});
});
for(const invalid of ['unclosed','missing-proof','confirmed'] as const)it('rejects a correction of an original that is '+invalid,async()=>{
 const x=await original();await change(x);
 if(invalid==='unclosed')await query('UPDATE kff.agent_commands SET quiesced_at=NULL WHERE id=$1',[x.command.id]);
 if(invalid==='missing-proof')await query("DELETE FROM kff.audit_events WHERE object_id=$1 AND event_type='guardian.quiesced'",[x.command.id]);
 if(invalid==='confirmed')await referralResult(scope,x.referral.id,{request_id:randomUUID(),expected_version:x.referral.version,result:'CONFIRMED',reason:'Already received on original destination'});
 await expect(sendConversationReply(scope,x.lead.conversation_id,request(2,x.referral.id))).rejects.toMatchObject({code:invalid==='confirmed'?'LEAD_STOPPED':'REFERRAL_CORRECTION_INVALID'});
});
