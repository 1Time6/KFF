import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const origin='http://127.0.0.1:3000';
test.use({actionTimeout:10000});
async function ownedOnly(context:BrowserContext){await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());}
async function login(page:Page){await page.goto('/inbox');const config=JSON.parse(readFileSync('.kff/local-config.json','utf8'));await page.getByLabel('密码',{exact:true}).fill(config.operator_password);await page.getByRole('button',{name:'进入工作台'}).click();await expect(page.getByRole('heading',{name:'客户收件箱',exact:true})).toBeVisible();}
async function createChannel(page:Page){await page.getByText('站内咨询入口',{exact:false}).first().click();const name='Inbox '+randomUUID().slice(0,8),form=page.getByRole('form',{name:'新增咨询入口'});await form.getByLabel('入口名称',{exact:true}).fill(name);const response=page.waitForResponse(response=>response.url().endsWith('/api/site-channels')&&response.request().method()==='POST');await form.getByRole('button',{name:'创建咨询入口'}).click();const result=await response;expect(result.ok()).toBe(true);const channel=await result.json();return {id:channel.id as string,name};}
async function send(page:Page,name:string,body:string){await page.getByLabel('您的称呼（选填）',{exact:true}).fill(name);await page.getByLabel('咨询内容',{exact:true}).fill(body);await page.getByRole('button',{name:'发送咨询',exact:true}).click();await expect(page.getByRole('status')).toContainText('消息已保存');}
test('owns visitor inquiries, isolates equal names, restores history and maintains one customer timeline',async({page,browser})=>{
  await ownedOnly(page.context());await login(page);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const channel=await createChannel(page),visitorA=await browser.newContext({baseURL:origin}),visitorB=await browser.newContext({baseURL:origin});await ownedOnly(visitorA);await ownedOnly(visitorB);
  try{
    const a=await visitorA.newPage(),b=await visitorB.newPage();for(const current of [a,b]){current.on('pageerror',error=>errors.push(error.message));await current.goto('/chat/'+channel.id);await current.getByRole('button',{name:'开始咨询',exact:true}).click();await expect(current.getByRole('form',{name:'发送咨询'})).toBeVisible();current.on('console',message=>{if(message.type()==='error')errors.push(message.text());});}
    const name='同名访客 '+randomUUID().slice(0,6),textA='客户 A 的问题 <script>window.leaked = true</script>',textB='客户 B 的独立咨询';await send(a,name,textA);await send(b,name,textB);
    await a.reload();await expect(a.getByRole('list',{name:'我的咨询记录'})).toContainText(textA);await expect(a.getByRole('list',{name:'我的咨询记录'})).not.toContainText(textB);expect(await a.evaluate(()=>Object.hasOwn(window,'leaked'))).toBe(false);
    const inbox=await (await page.request.get('/api/inbox')).json();const conversations=inbox.conversations.filter((row:{channel_id:string})=>row.channel_id===channel.id);expect(conversations).toHaveLength(2);expect(new Set(conversations.map((row:{customer_id:string})=>row.customer_id)).size).toBe(2);
    const history=await (await a.request.get('/api/public/chat/'+channel.id+'/messages')).json();const selected=conversations.find((row:{id:string})=>row.id===history.messages[0].conversation_id);
    await page.goto('/inbox?conversation='+selected.id);const conversation=page.getByRole('region',{name:'会话详情'});await expect(conversation).toContainText(textA);await expect(conversation).not.toContainText(textB);await conversation.screenshot({path:'output/playwright/inbox-owned-conversation.png'});
    await conversation.getByRole('link',{name:'客户档案 →'}).click();const customer=page.getByRole('region',{name:'客户详情'});await expect(customer).toContainText('KFF 站内主动咨询');await expect(customer).toContainText('未知');
    const form=page.getByRole('form',{name:'编辑客户档案'});await form.getByLabel('客户阶段',{exact:true}).selectOption('QUALIFIED_INQUIRY');await form.getByLabel('负责人',{exact:true}).selectOption({label:'我 · 管理员'});await form.getByLabel('档案修改依据',{exact:true}).fill('合成咨询已明确范围，安排继续跟进');await form.getByRole('button',{name:'保存客户档案'}).click();await expect(customer.getByRole('status')).toContainText('客户档案已保存');
    const note=page.getByRole('form',{name:'新增跟进备注'});await note.getByLabel('跟进备注',{exact:true}).fill('确认需求后准备方案，付款尚未核实。');await note.getByRole('button',{name:'保存跟进备注'}).click();await expect(customer).toContainText('确认需求后准备方案，付款尚未核实。');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'output/playwright/customer-owned-timeline.png',fullPage:true});
    await a.setViewportSize({width:390,height:844});await expect.poll(()=>a.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await a.screenshot({path:'output/playwright/visitor-chat-mobile.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'output/playwright/customer-mobile.png',fullPage:true});
    const csrf=await a.request.post('/api/public/chat/'+channel.id+'/messages',{headers:{Origin:'https://untrusted.invalid'},data:{client_message_id:randomUUID(),body:'Forgery',display_name:null,client_sent_at:null}});expect(csrf.status()).toBe(403);
    const spoof=await a.request.post('/api/public/chat/'+channel.id+'/messages',{headers:{Origin:origin},data:{client_message_id:randomUUID(),body:'Forgery',display_name:null,client_sent_at:null,customer_id:selected.customer_id}});expect(spoof.status()).toBe(400);
    const adminFromVisitor=await a.request.get('/api/customers/'+selected.customer_id);expect(adminFromVisitor.status()).toBe(401);
    const forged=await a.request.get('/api/public/chat/'+channel.id+'/messages',{headers:{Cookie:'kff-visitor-'+channel.id+'='+'a'.repeat(64)}});expect(forged.status()).toBe(401);
    await a.getByRole('button',{name:'结束此会话'}).click();await expect(a.getByRole('button',{name:'开始咨询',exact:true})).toBeVisible();expect((await a.request.get('/api/public/chat/'+channel.id+'/messages')).status()).toBe(401);await expect(b.getByRole('list',{name:'我的咨询记录'})).toContainText(textB);expect(errors).toEqual([]);
  }finally{await visitorA.unrouteAll({behavior:'ignoreErrors'});await visitorB.unrouteAll({behavior:'ignoreErrors'});await visitorA.close();await visitorB.close();}
});
test('retries the exact saved inquiry after the acknowledgement connection is lost',async({page,browser})=>{
  await ownedOnly(page.context());await login(page);const channel=await createChannel(page),context=await browser.newContext({baseURL:origin});await ownedOnly(context);
  try{
    const visitor=await context.newPage();await visitor.goto('/chat/'+channel.id);await visitor.getByRole('button',{name:'开始咨询',exact:true}).click();await expect(visitor.getByRole('form',{name:'发送咨询'})).toBeVisible();
    let dropped=false;const requests:unknown[]=[];
    await visitor.route('**/api/public/chat/'+channel.id+'/messages',async route=>{if(route.request().method()==='POST'){requests.push(route.request().postDataJSON());if(!dropped){dropped=true;const saved=await route.fetch();expect(saved.ok()).toBe(true);await route.abort('failed');return;}}await route.continue();});
    await visitor.getByLabel('咨询内容',{exact:true}).fill('只保存一次的合成咨询');await visitor.getByRole('button',{name:'发送咨询',exact:true}).click();await expect(visitor.getByRole('alert').filter({hasText:'原消息仍保留'})).toBeVisible();await expect(visitor.getByLabel('咨询内容',{exact:true})).toBeDisabled();await visitor.getByRole('button',{name:'按原消息重试',exact:true}).click();await expect(visitor.getByRole('status')).toContainText('消息已保存');expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
    const history=await (await visitor.request.get('/api/public/chat/'+channel.id+'/messages')).json();expect(history.messages).toHaveLength(1);const inbox=await (await page.request.get('/api/inbox')).json();expect(inbox.conversations.filter((row:{channel_id:string})=>row.channel_id===channel.id)).toHaveLength(1);
  }finally{await context.close();}
});
