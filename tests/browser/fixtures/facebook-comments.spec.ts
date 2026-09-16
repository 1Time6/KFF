import {randomUUID} from 'node:crypto';
import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:net';
import type {CollectionRead} from '../../../packages/adapters/src/collection-fixture';
import {inspectFacebookCommentsDom} from '../../../packages/adapters/src/facebook-comments-dom';
import {readFacebookCommentsPage} from '../../../packages/adapters/src/facebook-browser-comments';
import {facebookSearchCursor} from '../../../packages/adapters/src/facebook-browser-discovery';
const target='https://www.facebook.com/local.author/posts/pfbid0123456789abcdef/';
const comment=(id:string,author='/profile.php?id=0009876',text='pm 测算')=>`<article aria-label="评论者：Local author6周前"><a href="https://www.facebook.com${author}" aria-hidden="true">Hidden avatar</a><a href="https://www.facebook.com${author}">Local author</a><a href="${target}?comment_id=${id}&tracking=remove">6周</a><span dir="auto" lang="zh-CN">${text}</span><button onclick="window.sent=true">回复</button><button onclick="window.sent=true">赞</button></article>`;
const shell=(comments:string,sort='由新到旧')=>`<div role="dialog"><div role="dialog"><h2>Local 的帖子</h2><article><h3>Local</h3><a href="${target}">Date</a><svg role="img" title="分享对象： 公开" width="12" height="12"></svg><button>${sort}</button>${comments}</article><div role="textbox">Never collect the composer</div></div></div>`;
const request=():CollectionRead=>({query_id:randomUUID(),cursor:null,limit:2,snapshot:{external_account_id:'1234',fields:['author_id','comment_count','created_time','message','reaction_count'],discovery:{platform:'facebook',provider:'LOCAL_BROWSER',strategy:'COMMENTS',target,keywords:['测算'],browser:{template:'facebook-comments-dom-v1'}}} as CollectionRead['snapshot']});
test('reads visible comment bodies and numeric author IDs without turning vanity names or timestamps into IDs',async({page})=>{
 await page.setContent(shell(comment('000123')+comment('2','/vanity.name','我要預約')+'<div hidden>'+comment('3')+'</div>'));
 const result=await page.evaluate(inspectFacebookCommentsDom,target);
 expect(result).toEqual({publicPost:true,invalid:0,rows:[{id:'facebook:comment:000123',url:target+'?comment_id=000123',author_id:'0009876',message:'pm 测算',expanded:true,displayed_time:'6周'},{id:'facebook:comment:2',url:target+'?comment_id=2',author_id:null,message:'我要預約',expanded:true,displayed_time:'6周'}]});
 await page.locator('article[aria-label]').first().evaluate(n=>n.insertAdjacentHTML('beforeend','<article aria-label="评论者：Nested"><span dir="auto" lang="en">Do not collect replies</span></article>'));
 expect((await page.evaluate(inspectFacebookCommentsDom,target)).rows).toHaveLength(2);
});
test('rejects private or changed source posts and omits ambiguous or missing comment bodies',async({page})=>{
 await page.setContent(shell(comment('1')+comment('2').replace('<span dir="auto" lang="zh-CN">pm 测算</span>','')));
 expect((await page.evaluate(inspectFacebookCommentsDom,target)).invalid).toBe(1);
 expect((await page.evaluate(inspectFacebookCommentsDom,target.replace('local.author','wrong.author'))).publicPost).toBe(false);
 await page.locator('svg').evaluate(n=>n.setAttribute('title','好友'));
 expect((await page.evaluate(inspectFacebookCommentsDom,target)).rows).toEqual([]);
});
test('replays bounded pages by exact comment anchor and never clicks reply or like',async({page})=>{
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:shell(comment('1')+comment('2')+comment('3','/vanity','Full text<button onclick="this.parentElement.textContent=\'Expanded text\'">展开</button>')+comment('4'))}));
 const read=request(),first=await readFacebookCommentsPage(page,read,()=>{});
 const second=await readFacebookCommentsPage(page,{...read,cursor:first.next_cursor},()=>{});
 expect(first.rows.map(r=>r.source_object_id)).toEqual(['facebook:comment:1','facebook:comment:2']);
 expect(second.rows.map(r=>r.source_object_id)).toEqual(['facebook:comment:3','facebook:comment:4']);
 expect(second.rows[0].fields.message).toEqual({kind:'VALUE',value:'Expanded text'});
 expect(second.rows[0].fields.created_time).toEqual({kind:'DISPLAYED_TIME',value:'6周'});
 expect(await page.evaluate(()=>Boolean((window as unknown as {sent:boolean}).sent))).toBe(false);
});
test('distinguishes confirmed empty comments from missing anchors and respects lost control',async({page})=>{
 let body=shell('<h3>还没有任何评论哦</h3>').replace('<button>由新到旧</button>','');
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
 const read=request();expect(await readFacebookCommentsPage(page,read,()=>{})).toEqual({rows:[],next_cursor:null,unparsedVisibleMax:0});
 body=shell(comment('1'));
 await expect(readFacebookCommentsPage(page,{...read,cursor:facebookSearchCursor(read,'facebook:comment:999')},()=>{})).rejects.toMatchObject({code:'CURSOR_EXPIRED'});
 await expect(readFacebookCommentsPage(page,read,()=>{throw new Error('stopped')})).rejects.toThrow('stopped');
});
test('waits for sorted comments to load before reading',async({page})=>{
 const html=shell('<div id="rows"></div>','最相关')+`<script>document.querySelector('button').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">由新到旧 显示所有评论，优先显示最新评论。</button></div>');document.querySelector('[role=menuitem]').onclick=()=>{document.querySelector('article>button').textContent='由新到旧';document.querySelector('[role=menu]').remove();setTimeout(()=>document.getElementById('rows').innerHTML=${JSON.stringify(comment('1')+comment('2'))},1500)}};</script>`;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
 expect((await readFacebookCommentsPage(page,request(),()=>{})).rows).toHaveLength(2);
});

for(const role of ['roleless','complementary'])test('reads the bounded Reel panel with '+role+' markup',async({page})=>{
 const reel='https://www.facebook.com/reel/123456/',rows=comment('11').replaceAll(target,reel)+comment('12').replaceAll(target,reel);
 const panel=`<div ${role==='complementary'?'role="complementary"':''}><h2><a href="https://www.facebook.com/profile.php?id=555">Owner</a></h2><button aria-label="分享对象： 公开"></button><section><button>由新到旧</button><h2>评论</h2>${rows}</section><div role="textbox">Never collect the composer</div></div>`;
 const html=`<main><button aria-label="评论" onclick="window.clicks=(window.clicks||0)+1;setTimeout(()=>document.getElementById('panel').innerHTML=${JSON.stringify(panel).replaceAll('"','&quot;')},150)">Comments</button></main><div id="panel"></div>`;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
 const input=request();input.snapshot={...input.snapshot,max_pages:1,discovery:{...input.snapshot.discovery!,target:reel,browser:{...input.snapshot.discovery!.browser!,comment_order:'VISIBLE_WINDOW'}}};
 const result=await readFacebookCommentsPage(page,input,()=>{});
 expect(result.rows.map(r=>r.source_object_id)).toEqual(['facebook:comment:11','facebook:comment:12']);
 expect(await page.evaluate(()=>({clicks:(window as unknown as {clicks:number}).clicks,sent:Boolean((window as unknown as {sent:boolean}).sent)}))).toEqual({clicks:1,sent:false});
 const scope=await page.evaluate(inspectFacebookCommentsDom,reel);expect(scope.publicPost).toBe(true);
 if(role==='roleless'){expect(scope.container_path).toBeTruthy();expect(await page.locator(scope.container_path!).getByRole('heading',{name:'Owner'}).count()).toBe(1);}
});

test('roleless Reel scope rejects private, duplicate or page-wide panels',async({page})=>{
 const reel='https://www.facebook.com/reel/123456/';
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));await page.goto(reel);
 const owner='<h2><a href="/profile.php?id=555">Owner</a></h2><button aria-label="分享对象： 公开">Public</button>',comments='<h2>评论</h2>'+comment('11').replaceAll(target,reel);
 await page.setContent('<div>'+owner+comments+'</div>');expect((await page.evaluate(inspectFacebookCommentsDom,reel)).publicPost).toBe(true);
 expect((await page.evaluate(inspectFacebookCommentsDom,reel.replace('123456','999'))).publicPost).toBe(false);
 await page.setContent('<div>'+owner.replace('分享对象： 公开','好友')+comments+'</div>');expect((await page.evaluate(inspectFacebookCommentsDom,reel)).publicPost).toBe(false);
 await page.setContent('<div>'+owner+comments+'<h2>评论</h2></div>');expect((await page.evaluate(inspectFacebookCommentsDom,reel)).publicPost).toBe(false);
 await page.setContent('<div>'+owner+'</div><div>'+comments+'</div>');expect((await page.evaluate(inspectFacebookCommentsDom,reel)).publicPost).toBe(false);
 await page.setContent('<div><main>Neighboring Reels</main><div>'+owner+'</div><div>'+comments+'</div></div>');expect((await page.evaluate(inspectFacebookCommentsDom,reel)).publicPost).toBe(false);
});

test('reads a roleless Reel with CSP and Trusted Types headers',async({page})=>{
 const reel='https://www.facebook.com/reel/123456/',panel='<div><h2><a href="/profile.php?id=555">Owner</a></h2><button aria-label="分享对象： 公开">Public</button><h2>评论</h2><button>由新到旧</button>'+comment('11').replaceAll(target,reel)+'</div>';
 await page.route('**/*',route=>route.fulfill({headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"script-src 'self'; require-trusted-types-for 'script'"},body:'<main><button aria-label="评论">Comments</button></main>'+panel}));
 const input=request();input.snapshot={...input.snapshot,max_pages:1,discovery:{...input.snapshot.discovery!,target:reel,browser:{...input.snapshot.discovery!.browser!,comment_order:'VISIBLE_WINDOW'}}};
 expect((await readFacebookCommentsPage(page,input,()=>{})).rows.map(r=>r.source_object_id)).toEqual(['facebook:comment:11']);
});

test('reads through a CDP connection with no default context overrides',async()=>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing test port');const port=address.port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 const launched=await chromium.launch({headless:true,args:['--remote-debugging-port='+port]});
 try{const connected=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true}),page=await connected.contexts()[0].newPage(),reel='https://www.facebook.com/reel/123456/';
 const panel='<div><h2><a href="/profile.php?id=555">Owner</a></h2><button aria-label="分享对象： 公开">Public</button><h2>评论</h2><button>由新到旧</button>'+comment('11').replaceAll(target,reel)+'</div>';
 await page.route('**/*',route=>route.fulfill({headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"script-src 'self'; require-trusted-types-for 'script'"},body:'<main><button aria-label="评论">Comments</button></main>'+panel}));
 // Stock Chromium does not reproduce AdsPower's CSP error; exercise the same connection mode.
 // The real EvalError is retained separately in the controlled diagnostic evidence.
 const input=request();input.snapshot={...input.snapshot,max_pages:1,discovery:{...input.snapshot.discovery!,target:reel,browser:{...input.snapshot.discovery!.browser!,comment_order:'VISIBLE_WINDOW'}}};
 expect((await readFacebookCommentsPage(page,input,()=>{})).rows.map(r=>r.source_object_id)).toEqual(['facebook:comment:11']);
 }finally{await launched.close();}
});
