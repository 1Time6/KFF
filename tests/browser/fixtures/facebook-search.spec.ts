import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { CollectionRead } from '../../../packages/adapters/src/collection-fixture';
import { inspectFacebookSearchDom } from '../../../packages/adapters/src/facebook-search-dom';
import { readFacebookSearchPage, facebookSearchCursor } from '../../../packages/adapters/src/facebook-browser-discovery';

const article = (id: string, author = '/profile.php?id=9876', body = '八字测算 full public text') => `<article><h3><a href="${author}">Local author</a></h3><a href="/reel/${id}/?tracking=remove">2天</a><svg role="img" title="分享对象： 公开" width="12" height="12"></svg><div data-ad-preview="message">${body}</div><button>发消息</button><div role="textbox">Write comment</div><a href="https://example.com/send?secret=exclude">External CTA</a></article>`;
const shell = (body: string) => `<input role="combobox" aria-label="搜索 Facebook" value="八字测算"><main aria-label="搜索结果">${body}</main>`;
function request(): CollectionRead {
  return { query_id: randomUUID(), cursor: null, limit: 2, snapshot: { external_account_id: '1234', fields: ['author_id','comment_count','created_time','message','reaction_count'], discovery: { platform: 'facebook', provider: 'LOCAL_BROWSER', strategy: 'KEYWORD', keywords: ['八字测算'], browser: { template: 'facebook-search-dom-v1' } } } as CollectionRead['snapshot'] };
}

test('waits for the delayed search shell before checking its scope',async({page})=>{
 const html=shell(article('735','/profile.php?id=9876','八字测算 genuine question'));
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<title>八字测算 - 搜索结果</title><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(html)+'),750)</script>'}));
 const r=request();r.limit=1;r.snapshot.fields=['message','author_id'];
 const steps:string[]=[];const result=await readFacebookSearchPage(page,r,()=>{},step=>steps.push(step));
 expect(result.rows[0].source_object_id).toBe('facebook:reel:735');
 expect(result.rows[0].fields.author_id).toEqual({kind:'VALUE',value:'9876'});
 expect(steps.indexOf('wait-search-shell')).toBeLessThan(steps.indexOf('scope'));
});

test('still rejects a different keyword after a delayed shell appears',async({page})=>{
 const html=shell(article('735')).replace('value="八字测算"','value="Other keyword"');
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(html)+'),750)</script>'}));
 await expect(readFacebookSearchPage(page,request(),()=>{})).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
});
test('reads only visible public post bodies, keeps string IDs, and excludes comments, CTAs and hidden copies', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell(article('000123', '/profile.php?id=00009876', 'Full text<button>收起</button>') + article('2','/vanity.profile') + '<article><h2>Page card</h2></article><div hidden>' + article('hidden') + '</div>' + article('3').replace('分享对象： 公开','好友')) }));
  await page.goto('https://www.facebook.com/search/top?q=x');
  const observed = await page.evaluate(inspectFacebookSearchDom);
  expect(observed).toEqual({ invalid: 0, rows: [ { id: 'facebook:reel:000123', url: 'https://www.facebook.com/reel/000123/', author_id: '00009876', message: 'Full text', expanded: true, displayed_time: '2天' }, { id: 'facebook:reel:2', url: 'https://www.facebook.com/reel/2/', author_id: null, message: '八字测算 full public text', expanded: true, displayed_time: '2天' } ] });
  await page.locator('article').first().evaluate(node => node.insertAdjacentHTML('beforeend','<a href="/reel/999/">Ambiguous source</a>'));
  expect((await page.evaluate(inspectFacebookSearchDom)).invalid).toBe(1);
});
test('expands post text and resumes after a stable anchor without reimporting earlier DOM rows', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/*', route => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell(article('1') + article('2') + article('3','/profile.php?id=9876','Short<button onclick="this.parentElement.textContent=\'八字测算 expanded complete\'">展开</button>')) + `<script>addEventListener('wheel',()=>{if(!document.querySelector('[data-added]')){const d=document.createElement('div');d.dataset.added='yes';d.innerHTML=${JSON.stringify(article('4'))};document.querySelector('main').append(d)}})</script>` });
  });
  const read = request(), first = await readFacebookSearchPage(page, read, () => {});
  expect(first.rows.map(row => row.source_object_id)).toEqual(['facebook:reel:1','facebook:reel:2']);
  const second = await readFacebookSearchPage(page, { ...read, cursor: first.next_cursor }, () => {});
  expect(second.rows.map(row => row.source_object_id)).toEqual(['facebook:reel:3','facebook:reel:4']);
  expect(second.rows[0].fields.message).toEqual({ kind: 'VALUE', value: '八字测算 expanded complete' });
  expect(second.rows[0].fields.created_time).toEqual({ kind: 'DISPLAYED_TIME', value: '2天' });
  expect(second.rows[0].fields.comment_count).toEqual({ kind: 'NOT_RETURNED' });
  expect(writes).toEqual([]);
});
test('fails changed ordering and empty windows without claiming the source is exhausted', async ({ page }) => {
  let html = shell(article('1'));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const read = request();
  await expect(readFacebookSearchPage(page, { ...read, cursor: facebookSearchCursor(read, 'facebook:reel:missing'.replace('missing','999')) }, () => {})).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  html = shell('<article>Loading placeholder</article>');
  await expect(readFacebookSearchPage(page, read, () => {})).rejects.toMatchObject({ code: 'SOURCE_WINDOW_ENDED' });
});
test('honors a lost control connection before any navigation', async ({ page }) => {
  const read = request();
  await expect(readFacebookSearchPage(page, read, () => { throw new Error('stopped'); })).rejects.toThrow('stopped');
  expect(page.url()).toBe('about:blank');
});
test('waits for delayed result bodies and preserves an observed opaque post ID', async ({ page }) => {
  const id = 'pfbid0123456789AbCdEf', post = article('100').replace('/reel/100/?tracking=remove', '/local.author/posts/' + id + '?tracking=remove');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell('') + `<script>setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(post)},4500)</script>` }));
  const result = await readFacebookSearchPage(page, { ...request(), limit: 1 }, () => {});
  expect(result.rows[0]).toMatchObject({ source_object_id: 'facebook:post:' + id, source_url: 'https://www.facebook.com/local.author/posts/' + id + '/' });
});
test('omits an ambiguous card while preserving a separately verified public source', async ({ page }) => {
  const ambiguous = article('1').replace('</article>','<a href="/reel/999/">Other source</a></article>');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell(ambiguous + article('2')) }));
  const result = await readFacebookSearchPage(page, { ...request(), limit: 1 }, () => {});
  expect(result.rows.map(row => row.source_object_id)).toEqual(['facebook:reel:2']);
  expect(result.unparsedVisibleMax).toBe(1);
  expect(result.next_cursor).not.toBeNull();
});
test('expands a newly appended result before advancing the checkpoint past it', async ({ page }) => {
  const extra = article('2', '/profile.php?id=9876', 'New excerpt<button onclick="this.parentElement.textContent=\'New full text\'">展开</button>');
  const first = article('1','/profile.php?id=9876','First excerpt<button onclick="document.querySelector(\'main\').insertAdjacentHTML(\'beforeend\',window.extra);this.parentElement.textContent=\'First full text\'">展开</button>');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell(first) + '<script>window.extra=' + JSON.stringify(extra) + '</script>' }));
  const result = await readFacebookSearchPage(page, request(), () => {});
  expect(result.rows.map(row => row.fields.message)).toEqual([{ kind: 'VALUE', value: 'First full text' },{ kind: 'VALUE', value: 'New full text' }]);
});
import { assertFacebookPageSource, readFacebookPagePage } from '../../../packages/adapters/src/facebook-browser-page';
const modernPageHeader = '<a aria-label="查看主页封面照片" href="/photo/?fbid=11">Cover</a><div role="button">Local Page</div><div data-pagelet="ProfileActions"><button>发消息</button><button>关注</button></div><div role="button">产品/服务</div><div data-pagelet="ProfileTabs"><a role="tab" href="/profile.php?id=9876">全部</a><a role="tab" href="/profile.php?id=9876&sk=followers">粉丝</a></div><div data-pagelet="ProfileTilesFeed_0"><h2>详细信息</h2><div role="button">尚无评分（0 次点评）</div></div>';

test('reads the observed modern Page header while retaining public post and author checks', async ({ page }) => {
  const publicPost = article('1').replace('<h3>', '<h2>').replace('</h3>', '</h2>');
  const privatePost = article('2').replaceAll('h3', 'h2').replace('分享对象： 公开', '好友');
  const wrongAuthor = article('3', '/profile.php?id=1111').replaceAll('h3', 'h2');
  const reads: string[] = [];
  await page.route('**/*', route => { reads.push(route.request().method()); return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+modernPageHeader+'<h2>帖子</h2>'+wrongAuthor+privatePost+publicPost+'</main>'}); });
  const r=request(); r.limit=1;r.snapshot.fields=['message','author_id'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  const result=await readFacebookPagePage(page,r,()=>{});
  expect(result.rows.map(r=>r.source_object_id)).toEqual(['facebook:reel:1']);
  expect(result.rows[0].fields.author_id).toEqual({kind:'VALUE',value:'9876'});
  expect(reads).toEqual(['GET']);
});

test('rejects missing Page markers, wrong publisher tabs and feed-only header copies', async ({ page }) => {
  let body=modernPageHeader;
  await page.route('**/*', route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+body+'</main>'}));
  for(const changed of [modernPageHeader.replace('查看主页封面照片','个人照片'),modernPageHeader.replace('产品/服务','个人简介'),modernPageHeader.replace('尚无评分（0 次点评）','关注我'),modernPageHeader.replace('&sk=followers','&sk=friends'),modernPageHeader.replaceAll('id=9876','id=1111'),'<article>'+modernPageHeader+'</article>',modernPageHeader.replace('data-pagelet="ProfileActions"','data-pagelet="Unknown"'),modernPageHeader+'<h1>Unexpected</h1>',modernPageHeader.replace('>Local Page<','> <')]) {
    body=changed; await page.goto('https://www.facebook.com/9876/');
    await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});
  }
  body=modernPageHeader;await page.goto('https://www.facebook.com/1111/');
  await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
  body='<input type="password">';await page.goto('https://www.facebook.com/9876/');
  await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'LOGIN_REQUIRED'});
  await page.goto('https://www.facebook.com/checkpoint/');
  await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'LOGIN_CHALLENGE'});
});

test('preserves legacy Page identity and rejects ambiguous legacy headings',async({page})=>{
  let body='<main><h1>Local Page</h1><button>公共主页 · 产品/服务</button></main>';
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
  await page.goto('https://www.facebook.com/9876/');await assertFacebookPageSource(page,'9876');
  body=body.replace('</main>','<h1>Other</h1></main>');await page.reload();
  await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});
});

test('waits for the native Page type marker after tabs render and records the failing source check',async({page})=>{
  const tile='<div data-pagelet="ProfileTilesFeed_0"><h2>详细信息</h2><div role="button">尚无评分（0 次点评）</div></div>';
  const post=article('1').replaceAll('h3','h2');
  let body='<main>'+modernPageHeader.replace(tile,'')+'<h2>帖子</h2>'+post+'</main><script>setTimeout(()=>document.querySelector("main").insertAdjacentHTML("beforeend",'+JSON.stringify(tile)+'),1200)</script>';
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
  const r=request();r.limit=1;r.snapshot.fields=['message'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  const steps:string[]=[];expect((await readFacebookPagePage(page,r,()=>{},step=>steps.push(step))).rows).toHaveLength(1);
  expect(steps).toContain('page-type-ready');expect(steps).toContain('source-modern-verified');
  body='<main>'+modernPageHeader.replace('产品/服务','Unknown')+'</main>';await page.goto('https://www.facebook.com/9876/');
  await expect(assertFacebookPageSource(page,'9876',step=>steps.push(step))).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});
  expect(steps.at(-1)).toBe('source-modern-cover-category-review-tile');
});

test('waits for later publisher tabs without another navigation and preserves immediate identity refusal',async({page})=>{
  const follower='<a role="tab" href="/profile.php?id=9876&sk=followers">粉丝</a>';
  let body='<main>'+modernPageHeader.replace(follower,'')+'<h2>帖子</h2>'+article('1').replaceAll('h3','h2')+'</main><script>setTimeout(()=>document.querySelector("[data-pagelet=ProfileTabs]").insertAdjacentHTML("beforeend",'+JSON.stringify(follower)+'),1200)</script>';
  const requests:string[]=[];await page.route('**/*',route=>{requests.push(route.request().method());return route.fulfill({contentType:'text/html; charset=utf-8',body});});
  const r=request();r.limit=1;r.snapshot.fields=['message'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  const steps:string[]=[];expect((await readFacebookPagePage(page,r,()=>{},step=>steps.push(step))).rows).toHaveLength(1);
  expect(steps).toContain('source-modern-followers-tab');expect(steps).toContain('source-modern-verified');expect(requests).toEqual(['GET']);
  body='<script>history.replaceState(null,"","/profile.php?id=1111")</script><main>'+modernPageHeader+'</main>';
  await expect(readFacebookPagePage(page,r,()=>{})).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
});

test('stops a Page source readiness wait when original control is lost',async({page})=>{
  const follower='<a role="tab" href="/profile.php?id=9876&sk=followers">粉丝</a>';const requests:string[]=[];
  await page.route('**/*',route=>{requests.push(route.request().method());return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+modernPageHeader.replace(follower,'')+'</main>'});});
  const r=request();r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  let checks=0;await expect(readFacebookPagePage(page,r,()=>{if(++checks===3)throw Error('control lost');})).rejects.toThrow('control lost');expect(requests).toEqual(['GET']);
});

test('uses the observed header follower link only when the compact Page omits its tab',async({page})=>{
  const tab='<a role="tab" href="/profile.php?id=9876&sk=followers">粉丝</a>',headerLink='<a href="/profile.php?id=9876&sk=followers">7 位粉丝</a>';
  const compact=modernPageHeader.replace(tab,'').replace('<div data-pagelet="ProfileActions">',headerLink+'<div data-pagelet="ProfileActions">');
  let body=compact;const requests:string[]=[];await page.route('**/*',route=>{requests.push(route.request().method());return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+body+'<h2>帖子</h2>'+article('1').replaceAll('h3','h2')+'</main>'});});
  const r=request();r.limit=1;r.snapshot.fields=['message'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  expect((await readFacebookPagePage(page,r,()=>{})).rows).toHaveLength(1);expect(requests).toEqual(['GET']);
  for(const changed of [compact.replace(headerLink,headerLink.replace('id=9876','id=1111')),compact.replace(headerLink,headerLink+headerLink),compact.replace(headerLink,'')+headerLink,compact.replace(headerLink,'<div hidden>'+headerLink+'</div>'),compact.replace('<div data-pagelet="ProfileTabs">','<div data-pagelet="ProfileTabs">'+tab+tab),compact.replace('<div data-pagelet="ProfileTabs">','<div data-pagelet="ProfileTabs">'+tab.replace('id=9876','id=1111'))]){
    body=changed;await page.goto('https://www.facebook.com/9876/');await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});
  }
});

test('binds a Page with deferred tab children to its verified header link and refuses conflicting tabs',async({page})=>{
  const follower='<a role="tab" href="/profile.php?id=9876&sk=followers">粉丝</a>',all='<a role="tab" href="/profile.php?id=9876">全部</a>',headerLink='<a href="/profile.php?id=9876&sk=followers">7 位粉丝</a>';
  const compact=modernPageHeader.replace(follower,'').replace(all,'').replace('<div data-pagelet="ProfileActions">',headerLink+'<div data-pagelet="ProfileActions">');
  let body=compact;const requests:string[]=[];await page.route('**/*',route=>{requests.push(route.request().method());return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+body+'<h2>帖子</h2>'+article('1').replaceAll('h3','h2')+'</main>'});});
  const r=request();r.limit=1;r.snapshot.fields=['message','author_id'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  expect((await readFacebookPagePage(page,r,()=>{})).rows[0].fields.author_id).toEqual({kind:'VALUE',value:'9876'});expect(requests).toEqual(['GET']);
  for(const changed of [compact.replace('id=9876&sk=followers','id=1111&sk=followers'),compact.replace(headerLink,''),compact.replace(headerLink,headerLink+headerLink),compact.replace('<div data-pagelet="ProfileTabs">','<div data-pagelet="ProfileTabs">'+all.replace('id=9876','id=1111')),compact.replace('<div data-pagelet="ProfileTabs">','<div data-pagelet="ProfileTabs">'+all+all)]){body=changed;await page.goto('https://www.facebook.com/9876/');await expect(assertFacebookPageSource(page,'9876')).rejects.toMatchObject({code:'SOURCE_UNSUPPORTED'});}
});

test('retains the verified Page source when its header collapses after scrolling and rejects a changed address',async({page})=>{
  let changeAddress=false;const requests:string[]=[];
  // The spacer makes "after scrolling" real; the address change is scheduled by a timer because a
  // wheel event is delivered on the browser's input schedule, which can land after the read has
  // already finished (observed: the handler ran after list-like completion and the assertion raced).
  await page.route('**/*',route=>{requests.push(route.request().method());return route.fulfill({contentType:'text/html; charset=utf-8',body:'<main>'+modernPageHeader+'<h2>帖子</h2>'+article('1').replaceAll('h3','h2')+'</main><div style="height:3000px"></div><script>addEventListener("wheel",()=>{document.querySelector("main>a").setAttribute("hidden","")});'+(changeAddress?'setTimeout(()=>history.replaceState(null,"","/profile.php?id=1111"),0);':'')+'</script>'});});
  const r=request();r.limit=1;r.snapshot.fields=['message','author_id'];r.snapshot.discovery={...r.snapshot.discovery!,strategy:'PAGE',target:'https://www.facebook.com/9876/',browser:{...r.snapshot.discovery!.browser!,template:'facebook-page-dom-v1'}};
  const steps:string[]=[];expect((await readFacebookPagePage(page,r,()=>{},step=>steps.push(step))).rows[0].fields.author_id).toEqual({kind:'VALUE',value:'9876'});expect(steps).toContain('source-modern-verified');expect(steps).toContain('scope-location');expect(steps.at(-1)).toBe('final-location');expect(requests).toEqual(['GET']);
  changeAddress=true;await expect(readFacebookPagePage(page,r,()=>{})).rejects.toMatchObject({code:'COLLECTION_SOURCE_MISMATCH'});
});
