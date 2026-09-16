import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '@kff/database';

// One-use, loopback-only credential setup. The token never appears in terminal output.
const expectedEmail=process.argv[2];
if(!expectedEmail||!expectedEmail.includes('@'))throw new Error('Usage: tsx scripts/apify-connect.ts expected-email');
const nonce=randomBytes(24).toString('hex'),host='127.0.0.1:4377',route='/'+nonce;
let saved=false,busy=false;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  const reply=(status:number,body:string)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end(body);};
  if(req.headers.host!==host||req.url!==route)return reply(404,'Not found');
  if(req.method==='GET')return reply(200,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>KFF · 连接 Apify</title><style>body{font:18px system-ui;max-width:640px;margin:80px auto;padding:24px}input{display:block;width:95%;padding:12px;margin:16px 0}button{padding:12px 24px}</style><h1>连接 Apify 到 KFF</h1><p>仅验证账号并保存本地凭据，不启动采集。</p><form method="post"><label>Apify API Token<input type="password" name="token" autocomplete="off" required maxlength="200"></label><button>验证并保存连接</button></form></html>`);
  const sameOrigin=req.headers.origin==='http://'+host||(req.headers.origin==='null'&&req.headers['sec-fetch-site']==='same-origin');
  if(req.method!=='POST'||!sameOrigin||saved||busy)return reply(403,'Request rejected');
  busy=true;
  try{
    let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>1024)throw new Error('Input too large');}
    const token=new URLSearchParams(body).get('token')?.trim();
    if(!token||!/^apify_api_[A-Za-z0-9_-]{20,160}$/.test(token))throw new Error('Invalid token');
    const response=await fetch('https://api.apify.com/v2/users/me',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Authentication failed');
    const user=(await response.json()).data;
    if(user?.email!==expectedEmail||typeof user.id!=='string')throw new Error('Account mismatch');
    const dir=path.join(projectRoot,'.kff');await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,'apify-connection.json'),JSON.stringify({token,user_id:user.id,email:user.email,username:user.username,verified_at:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
    saved=true;reply(200,'<title>KFF · Apify 已连接</title><h1>Apify 连接验证成功</h1><p>凭据已保存在 KFF 本地私有配置。未启动采集，未发送任何消息。</p>');
    console.log(JSON.stringify({connected:true,user_id:user.id,username:user.username,external_runs_started:0}));
    server.close();
  }catch{reply(400,'<h1>连接未保存</h1><p>请检查 Token、账号是否正确，或本地是否已有配置。现有配置不会被覆盖。</p>');}
  finally{busy=false;}
});
server.listen(4377,'127.0.0.1',()=>console.log('Apify setup: http://'+host+route));
setTimeout(()=>server.close(),15*60*1000).unref();
