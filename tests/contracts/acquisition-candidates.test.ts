import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {monitorInput} from '../../packages/contracts/src/acquisition';
import {unifiedAcquisitionCandidates,facebookPublicProfileId,type CandidateLeadInput} from '../../packages/core/src/acquisition-candidates';
import type {ProviderProspect} from '../../packages/core/src/acquisition-provider';
const source='https://www.facebook.com/reel/123456/';
function lead(patch:Partial<CandidateLeadInput>={}):CandidateLeadInput{
 const account_id=randomUUID(),environment_id=randomUUID();
 return {id:randomUUID(),account_id,monitor_id:randomUUID(),version:2,state:'QUALIFIED',score:75,reason:'Source rule',config:monitorInput.parse({request_id:randomUUID(),title:'Known source',account_id,discovery:{platform:'facebook',strategy:'COMMENTS',provider:'LOCAL_BROWSER',browser:{environment_id,template:'facebook-comments-dom-v1'},keywords:['BaZi'],target:source,processing_basis:'Isolated public source comparison'},interval_minutes:60,max_records:10,max_pages:1,page_size:10,retention_days:7}),source_object_id:'facebook:comment:123',source_url:source+'?comment_id=123',fields:{message:{kind:'VALUE',value:'I need help with BaZi'},author_id:{kind:'VALUE',value:'0009876'},created_time:{kind:'DISPLAYED_TIME',value:'刚刚'}},observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),publication_age:'UNRESTRICTED',...patch};
}
function prospect(patch:Partial<ProviderProspect>={}):ProviderProspect{return {id:randomUUID(),source_id:randomUUID(),import_id:randomUUID(),platform:'facebook',kind:'COMMENT',remote_id:'123',source_url:source+'?comment_id=123',parent_url:source,body:'I need help with BaZi',author_name:'Public person',profile_ref:'0009876',profile_url:'https://www.facebook.com/profile.php?id=0009876',occurred_at:null,search_keywords:['BaZi'],score:65,score_reason:'Provider scoring before normalization',state:'NEW',version:1,review_note:null,expires_at:new Date(Date.now()+60000).toISOString(),last_seen_at:new Date().toISOString(),...patch};}
it('groups exact public profile references across accounts and providers while retaining every source, state and version',()=>{
 const a=lead(),b=lead(),p=prospect(),before=JSON.stringify({a,b,p}),view=unifiedAcquisitionCandidates([a,b],[p]);
 expect(view.group_count).toBe(1);expect(view.record_count).toBe(3);expect(view.groups[0].records.map(r=>[r.origin,r.version,r.state])).toEqual([['LEAD',2,'QUALIFIED'],['LEAD',2,'QUALIFIED'],['PROSPECT',1,'NEW']]);
 expect(view.groups[0].records.filter(r=>r.can_prepare_public_reply)).toHaveLength(2);expect(view.groups[0].records[2].can_prepare_public_reply).toBe(false);
 expect(new Set(view.groups[0].records.map(r=>r.score))).toEqual(new Set([75]));expect(JSON.stringify({a,b,p})).toBe(before);
});
it('keeps vanity names, contradictory IDs, missing identities and API-scoped authors separate',()=>{
 const a=lead(),p=prospect({profile_url:'https://www.facebook.com/same.name',profile_ref:null}),other=prospect({profile_ref:'999'}),api=lead();api.config.discovery={platform:'facebook',provider:'META_API',strategy:'COMMENTS',keywords:['BaZi'],exclusions:[],target:'123_456',processing_basis:'Isolated API reference only'};
 const view=unifiedAcquisitionCandidates([a,api],[p,{...p,id:randomUUID()},other]);expect(view.group_count).toBe(5);
 expect(view.groups.filter(g=>g.identity_basis==='PUBLIC_PROFILE_LINK')).toHaveLength(1);
});
it('never merges synthetic authors or Instagram identifiers with Facebook public identities',()=>{
 const a=lead(),fixture=lead();fixture.config.discovery={...fixture.config.discovery,browser:{...fixture.config.discovery.browser!,template:'fixture-discovery-dom-v1'}};
 const ig=prospect({platform:'instagram',profile_url:'https://www.instagram.com/person/'}),view=unifiedAcquisitionCandidates([a,fixture],[ig]);
 expect(view.group_count).toBe(3);expect(view.groups.flatMap(g=>g.records).find(r=>r.id===fixture.id)?.synthetic).toBe(true);
});
it('uses the same inquiry and promotion rules without mutating stored provider scores or authorizing a send',()=>{
 const a=lead(),p=prospect({body:'BaZi readings. We offer personal consultations. Message us to book.',state:'QUALIFIED'}),post=prospect({id:randomUUID(),kind:'POST',body:'BaZi keyword post'});
 const view=unifiedAcquisitionCandidates([a],[p,post]),rows=view.groups.flatMap(g=>g.records);expect(rows.find(r=>r.id===p.id)).toMatchObject({score:0,source_score:65,state:'QUALIFIED',can_prepare_public_reply:false});expect(rows.find(r=>r.id===post.id)?.score).toBe(0);
});
it('preserves parent topic context but gives unverified topics no score',()=>{
 const a=prospect({body:'PM'}),b=prospect({body:'PM',search_keywords:[]});const rows=unifiedAcquisitionCandidates([],[a,b]).groups.flatMap(g=>g.records);
 expect(rows.find(r=>r.id===a.id)?.score).toBe(50);expect(rows.find(r=>r.id===b.id)?.score).toBe(0);
});
it('surfaces a same-reference opt-out without overwriting any other review or creating a contact',()=>{
 const a=lead(),p=prospect({state:'OPTED_OUT'}),view=unifiedAcquisitionCandidates([a],[p]);expect(view.groups[0].has_opted_out).toBe(true);expect(view.groups[0].records[0].state).toBe('QUALIFIED');expect(view).not.toHaveProperty('customer_id');expect(view).not.toHaveProperty('permission_id');
});
it('preserves unknown and displayed source times without inventing a timezone',()=>{
 const rows=unifiedAcquisitionCandidates([lead()],[prospect()]).groups[0].records;expect(rows[0]).toMatchObject({time_kind:'DISPLAYED_TIME',source_time:'刚刚'});expect(rows[1]).toMatchObject({time_kind:'UNKNOWN',source_time:null});
});
it('recognizes only exact supported public-profile URL shapes and keeps platform IDs as strings',()=>{
 for(const url of ['https://www.facebook.com/0009876/','https://facebook.com/profile.php?id=0009876','https://www.facebook.com/people/Name/0009876/'])expect(facebookPublicProfileId(url)).toBe('0009876');
 for(const url of ['https://www.facebook.com/vanity/','https://www.facebook.com/profile.php?id=1&id=2','https://www.facebook.com/profile.php?id=1&tracking=2','https://evil.example/1/','https://www.facebook.com/1/?x=1','https://user:secret@www.facebook.com/1/'])expect(facebookPublicProfileId(url)).toBeNull();
});
it('keeps comments outside their monitor time range out of ranked candidates and reply preparation without changing their review',()=>{
 const old=lead({publication_age:'OLDER'});old.config.discovery.max_age_days=7;
 old.fields.created_time={kind:'DISPLAYED_TIME',value:'2026年9月1日12:00'};
 const before=JSON.stringify(old),view=unifiedAcquisitionCandidates([old],[]),row=view.groups[0].records[0];
 expect(row).toMatchObject({score:0,source_score:75,state:'QUALIFIED',version:2,can_prepare_public_reply:false,source_time:'2026年9月1日12:00'});
 expect(row.score_reason).toContain('超出最近 7 天');expect(view.groups[0].score).toBe(0);expect(JSON.stringify(old)).toBe(before);
});
it('marks an unresolved publication time for review and only offers preparation when no time limit was requested',()=>{
 const uncertain=lead({publication_age:'UNKNOWN'});uncertain.config.discovery.max_age_days=7;
 const unrestricted=lead(),rows=unifiedAcquisitionCandidates([uncertain,unrestricted],[]).groups[0].records;
 expect(rows[0]).toMatchObject({score:75,can_prepare_public_reply:false,publication_age:'UNKNOWN'});expect(rows[0].score_reason).toContain('发布时间待核对');
 expect(rows[1]).toMatchObject({score:75,can_prepare_public_reply:true,publication_age:'UNRESTRICTED'});
});
it('preserves eligible recent comments while respecting the original positive-source-score requirement',()=>{
 const recent=lead({publication_age:'RECENT'});const stamp=new Date(Date.now()-2*86400000);recent.fields.created_time={kind:'DISPLAYED_TIME',value:stamp.getUTCFullYear()+'年'+(stamp.getUTCMonth()+1)+'月'+stamp.getUTCDate()+'日12:00'};recent.config.discovery.max_age_days=7;
 const zeroSource={...recent,id:randomUUID(),score:0};const rows=unifiedAcquisitionCandidates([recent,zeroSource],[]).groups[0].records;
 expect(rows[0]).toMatchObject({score:75,source_score:75,can_prepare_public_reply:true});
 expect(rows[1]).toMatchObject({score:75,source_score:0,state:'QUALIFIED',can_prepare_public_reply:false});
});
it('keeps a browser time limit local to that source when another provider shares the public identity',()=>{
 const old=lead({publication_age:'OLDER'});old.config.discovery.max_age_days=7;
 const external=prospect(),view=unifiedAcquisitionCandidates([old],[external]);
 expect(view.group_count).toBe(1);expect(view.groups[0].records[0].score).toBe(0);
 expect(view.groups[0].records[1]).toMatchObject({score:75,can_prepare_public_reply:false});expect(view.groups[0].score).toBe(75);
});
