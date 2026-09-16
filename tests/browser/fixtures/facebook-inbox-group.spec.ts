import {test,expect} from '@playwright/test';
import {inspectFacebookInboxDom} from '../../../packages/adapters/src/facebook-inbox-dom';
import {readFacebookInboxThread} from '../../../packages/adapters/src/facebook-browser-inbox';
import type {BrowserInboxTask} from '../../../packages/contracts/src/browser-inbox';

const avatar='<div role="button" aria-haspopup="dialog" style="width:30px;height:30px" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<a role=menuitem href=/1122/>查看个人主页</a>\');document.body.dataset.avatarClicks=String(Number(document.body.dataset.avatarClicks||0)+1)"><span aria-hidden="true"><img alt="Peer Fullname" style="width:20px;height:20px"></span></div>';
const row=(id:string,body:string,withAvatar=false,actor='Peer')=>'<div><div role="article"><div data-message-id="'+id+'" aria-label="03:57，'+actor+'：'+body+'"><div dir="auto">'+body+'</div>'+(withAvatar?avatar:'')+'</div></div></div>';
const group=(rows:string)=>'<div role="none"><div><div>03:57</div>'+rows+'</div></div>';
const shell=(content:string)=>'<main><div role="textbox" aria-label="发消息给Peer Fullname" contenteditable="true"></div><div role="log" aria-label="与Peer Fullname的对话中的消息">'+content+'</div></main><script>document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelector("[role=menuitem]")?.remove()})</script>';
// The operating account is the bound environment identity, never the peer being read. These
// fixtures used to describe the request without an environment at all, which is not a request the
// runtime can produce: the composer probe reads the operating identity from the binding, so the
// request has to carry one for the read to be the read under test.
const request=():Pick<BrowserInboxTask,'binding'|'template'|'cursor'|'limit'>=>({binding:{
  account_version:1,
  environment:{
    environment_id:'11111111-1111-4111-8111-111111111111',
    account_id:'22222222-2222-4222-8222-222222222222',
    agent_id:'33333333-3333-4333-8333-333333333333',
    organization_id:'44444444-4444-4444-8444-444444444444',
    brand_id:'55555555-5555-4555-8555-555555555555',
    profile_key:'inbox-group-fixture',
    configuration_version:1,
    platform:'facebook',
    is_synthetic:true,
    configuration:{driver:'adspower',provider_profile_id:'inbox-group-fixture',login_account_id:'987654321',operating_identity_id:'987654321',locale:'zh-CN',timezone_id:'Asia/Shanghai',proxy_ref:null},
  },
  target:{thread_id:'9988',peer_id:'1122',display_name:'Peer Fullname'},
},template:'facebook-inbox-dom-v1',cursor:null,limit:5});

test('resolves the observed grouped incoming text to its own final avatar',async({page})=>{
 await page.setContent(shell(group(row('first','Marker')+row('second','Full inquiry',true))));
 expect(await page.evaluate(inspectFacebookInboxDom)).toEqual({invalid:0,rows:[
  {message_id:'first',body:'Marker',direction:'INBOUND',display_name:'Peer Fullname',displayed_time:'03:57',has_attachment:false,sender_anchor_message_id:'second'},
  {message_id:'second',body:'Full inquiry',direction:'INBOUND',display_name:'Peer Fullname',displayed_time:'03:57',has_attachment:false},
 ]});
});

for(const [name,content]of Object.entries({
 'different actor label':group(row('first','Marker',false,'Other')+row('second','Full inquiry',true)),
 'different group':group(row('first','Marker'))+group(row('second','Full inquiry',true)),
 'outgoing anchor':group(row('first','Marker')+row('second','Full inquiry',true,'你')),
 'two possible avatars':group(row('first','Marker')+row('second','Other',true)+row('third','Full inquiry',true)),
 'avatar before the missing sender':group(row('first','Full inquiry',true)+row('second','Marker')),
 'one unresolved sender':group(row('first','Marker')),
 'untrusted generic container':'<div>'+row('first','Marker')+row('second','Full inquiry',true)+'</div>',
 'duplicate anchor identifier':group(row('first','Marker')+row('first','Full inquiry',true)),
})){
 test('does not accept grouped sender with '+name,async({page})=>{
  await page.setContent(shell(content));
  const result=await page.evaluate(inspectFacebookInboxDom);
  if(name==='duplicate anchor identifier')expect(new Set(result.rows.map(r=>r.message_id)).size).toBeLessThan(result.rows.length);
  else expect(result.invalid).toBeGreaterThan(0);
 });
}

test('original thread reader verifies the shared avatar once and emits both messages without parser-only fields',async({page})=>{
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(group(row('first','Marker')+row('second','Full inquiry',true)))}));
 const req=request();
 const rows=await readFacebookInboxThread(page,req,()=>{});
 expect(rows.map(r=>[r.message_id,r.peer_id,r.body])).toEqual([['first','1122','Marker'],['second','1122','Full inquiry']]);
 expect(rows.every(r=>!('sender_anchor_message_id'in r))).toBe(true);
 expect(await page.locator('body').getAttribute('data-avatar-clicks')).toBe('1');
});

test('original reader rejects a shared avatar that points to another profile',async({page})=>{
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(group(row('first','Marker')+row('second','Full inquiry',true))).replace('href=/1122/','href=/9999/')}));
 await expect(readFacebookInboxThread(page,request(),()=>{})).rejects.toMatchObject({code:'ACCOUNT_MISMATCH'});
});

test('waits for an earlier incoming message when only outgoing text initially renders',async({page})=>{
 const body=shell(group(row('outgoing','Reply already sent',false,'你')));
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
 await page.goto('https://www.facebook.com/messages/e2ee/t/9988/');
 expect((await page.evaluate(inspectFacebookInboxDom)).rows.map(r=>r.direction)).toEqual(['OUTBOUND']);
 await page.evaluate(html=>{setTimeout(()=>document.querySelector('[role="log"]')!.insertAdjacentHTML('afterbegin',html),750);},group(row('incoming','Original inquiry',true)));
 const rows=await readFacebookInboxThread(page,request(),()=>{},()=>{},false);
 expect(rows.map(r=>[r.message_id,r.direction])).toEqual([['incoming','INBOUND'],['outgoing','OUTBOUND']]);
 expect(await page.locator('body').getAttribute('data-avatar-clicks')).toBe('1');
});

test('still rejects a later incoming sender with a different verified profile',async({page})=>{
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(group(row('outgoing','Existing reply',false,'你')))}));
 await page.goto('https://www.facebook.com/messages/e2ee/t/9988/');
 await page.evaluate(html=>{setTimeout(()=>document.querySelector('[role="log"]')!.insertAdjacentHTML('afterbegin',html),750);},group(row('incoming','Original inquiry',true)).replace('href=/1122/','href=/9999/'));
 await expect(readFacebookInboxThread(page,request(),()=>{},()=>{},false)).rejects.toMatchObject({code:'ACCOUNT_MISMATCH'});
});

test('verifies consecutive incoming links in the observed flat container after earlier incoming and outgoing turns',async({page})=>{
 const content=group(row('original','Earlier inquiry',true)+row('reply','Reply',false,'你')+row('link1','https://wa.me/1122?text=Hi')+row('link2','https://wa.me/message/ABC',true));
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(content)}));
 const rows=await readFacebookInboxThread(page,{...request(),limit:10},()=>{});
 expect(rows.map(r=>[r.message_id,r.direction,r.peer_id])).toEqual([['original','INBOUND','1122'],['reply','OUTBOUND','1122'],['link1','INBOUND','1122'],['link2','INBOUND','1122']]);
 expect(await page.locator('body').getAttribute('data-avatar-clicks')).toBe('2');
});

for(const [name,boundary] of Object.entries({outgoing:row('boundary','Reply',false,'你'),other_actor:row('boundary','Other text',false,'Another')})){
 test('does not borrow an avatar across a '+name+' boundary in a flat container',async({page})=>{
  await page.setContent(shell(group(row('unresolved','Link')+boundary+row('anchor','Other link',true))));
  expect((await page.evaluate(inspectFacebookInboxDom)).invalid).toBeGreaterThan(0);
 });
}

test('rejects a consecutive run whose final avatar points to another numeric profile',async({page})=>{
 const content=group(row('reply','Reply',false,'你')+row('link1','First link')+row('link2','Second link',true)).replace('href=/1122/','href=/9999/');
 await page.route('https://www.facebook.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(content)}));
 await expect(readFacebookInboxThread(page,{...request(),limit:10},()=>{})).rejects.toMatchObject({code:'ACCOUNT_MISMATCH'});
});
