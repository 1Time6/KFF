import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {agentCommandSchema,taskSnapshotSchema,templateManifestSchema} from '@kff/contracts';
import {digest} from '@kff/core';
import {fixedPageManifest} from '../../packages/adapters/src/templates';
import {executeFacebookBrowserComment,facebookCommentEditorName} from '../../packages/adapters/src/facebook-browser-comment';

it('matches observed Chinese spacing while keeping the complete recipient name literal',()=>{
  const chinese=facebookCommentEditorName('郑一哲');
  for(const label of ['回复郑一哲…','回复 郑一哲…','Reply to 郑一哲...'])expect(chinese.test(label)).toBe(true);
  for(const label of ['回复郑一哲2…','回复 郑一…','写评论…','Reply to郑一哲…'])expect(chinese.test(label)).toBe(false);
  const literal=facebookCommentEditorName('A.*[B]');expect(literal.test('Reply to A.*[B]…')).toBe(true);expect(literal.test('Reply to AxB…')).toBe(false);
});

it('runs the serialized reply reader without host-side transform helpers',()=>{
  // Use the Agent's TSX transform; Vite's transform alone can hide a serialization regression.
  const script=`import {runInNewContext} from 'node:vm';
    import {inspectFacebookCommentRepliesDom} from './packages/adapters/src/facebook-comment-reply-dom.ts';
    const input={source_url:'https://www.facebook.com/reel/123456/',comment_id:'000999'};
    const result=runInNewContext('('+inspectFacebookCommentRepliesDom.toString()+')('+JSON.stringify(input)+')',{URL,location:{origin:'https://unrelated.example',pathname:'/'}});
    process.stdout.write(JSON.stringify(result));`;
  const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{encoding:'utf8',windowsHide:true});
  expect(JSON.parse(result)).toEqual({rows:[],invalid:1});
});

function snapshot(){
  const account=randomUUID(),environment=randomUUID(),agent=randomUUID(),profile=randomUUID(),manifest=fixedPageManifest('facebook.comment.reply.browser');
  return {account_id:account,external_account_id:'123',account_version:1,credential_ref:null,environment_id:environment,environment_version:2,profile_key:profile,agent_id:agent,capability_id:randomUUID(),capability_key:'facebook.comment.reply.browser',capability_revision:1,adapter_version:'facebook-browser-comment-v1',implementation_digest:'a'.repeat(64),platform_api_version:null,body:'Reviewed public reply',content_hash:digest('Reviewed public reply'),mode:'CONTROLLED_PILOT',fixture_scenario:'normal',is_synthetic:false,template:{version_id:randomUUID(),version_number:1,manifest_hash:digest(manifest),manifest},browser_environment:{account_id:account,environment_id:environment,agent_id:agent,organization_id:randomUUID(),brand_id:randomUUID(),profile_key:profile,configuration_version:2,platform:'facebook',account_type:'profile',is_synthetic:false,configuration:{driver:'adspower',provider_profile_id:'contract-only',login_account_id:'123',operating_identity_id:'123',locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null}},outreach:{lead_id:randomUUID(),observation_id:randomUUID(),monitor_id:randomUUID(),monitor_version:1,platform:'facebook',action:'COMMENT_REPLY',source_object_id:'facebook:comment:000999',parent_id:'https://www.facebook.com/reel/123456/',author_id:'456',lead_version:2,authorization_basis:'This isolated public comment only.',stop_epochs:{organization:0,brand:0,account:0,agent:0},browser:{source_url:'https://www.facebook.com/reel/123456/',comment_id:'000999',comment_url:'https://www.facebook.com/reel/123456/?comment_id=000999',source_body:'Original question',source_content_hash:digest('Original question'),displayed_time:'刚刚',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}}};
}
it('binds a personal AdsPower account and exact public comment without API or Messenger scope',()=>{
  const s=snapshot();expect(taskSnapshotSchema.safeParse(s).success).toBe(true);
  const wrong=[{mode:'PRODUCTION'},{is_synthetic:true},{platform_api_version:'v25.0'},{credential_ref:'FACEBOOK_TOKEN'},{outreach:{...s.outreach,action:'PRIVATE_REPLY'}},{outreach:{...s.outreach,browser:undefined}},{outreach:{...s.outreach,source_object_id:'facebook:comment:another'}},{outreach:{...s.outreach,occurred_at:new Date().toISOString()}},{outreach:{...s.outreach,browser:{...s.outreach.browser,comment_url:'https://www.facebook.com/reel/999/?comment_id=000999'}}},{browser_environment:{...s.browser_environment,account_type:'page'}},{browser_environment:{...s.browser_environment,configuration:{...s.browser_environment.configuration,driver:'native',provider_profile_id:null}}}];
  for(const patch of wrong)expect(taskSnapshotSchema.safeParse({...s,...patch}).success).toBe(false);
});
it('pins public reply to one submission and rejects a Messenger or API template',()=>{
  const manifest=fixedPageManifest('facebook.comment.reply.browser');expect(manifest).toMatchObject({engine:'fixed-browser-comment-v1',adapter_version:'facebook-browser-comment-v1',automatic_write_retry:false,input:{body_required:true,max_body_length:1000}});
  for(const patch of [{automatic_write_retry:true},{adapter_version:'facebook-browser-messenger-v1'},{engine:'fixed-social-v1'},{steps:['validate_input','submit_once','submit_once']}])expect(templateManifestSchema.safeParse({...manifest,...patch}).success).toBe(false);
});
it('refuses the real comment executor before any provider opens when sending is disabled',async()=>{
  const s=taskSnapshotSchema.parse(snapshot()),command=agentCommandSchema.parse({protocol_version:'kff.agent.v1',id:randomUUID(),action_id:randomUUID(),attempt_id:randomUUID(),run_id:randomUUID(),organization_id:s.browser_environment!.organization_id,brand_id:s.browser_environment!.brand_id,agent_id:s.agent_id,snapshot:s,snapshot_hash:digest(s),leases:[{resource_type:'account',resource_id:s.account_id,token:'1'},{resource_type:'environment',resource_id:s.environment_id,token:'1'}],expires_at:new Date(Date.now()+60000).toISOString()});
  const previous=process.env.KFF_ENABLE_LIVE;process.env.KFF_ENABLE_LIVE='false';try{await expect(executeFacebookBrowserComment(command,'unused-contract-root',{assertControlled(){},beforeSubmit:async()=>{throw Error('Unexpected submission');},onContext(){throw Error('Unexpected browser');}})).rejects.toMatchObject({code:'LIVE_DISABLED'});}finally{if(previous===undefined)delete process.env.KFF_ENABLE_LIVE;else process.env.KFF_ENABLE_LIVE=previous;}
});
