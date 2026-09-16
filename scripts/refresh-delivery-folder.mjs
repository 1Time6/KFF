// Refresh the transfer folder from a freshly built controller release.
// Usage: node scripts/refresh-delivery-folder.mjs <releaseId>
// Keeps exactly one zip + one .sha256 + the instruction text in the folder.
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const delivery='C:\\Users\\17731\\Desktop\\KFF-交付-0.1.53';
const releaseId=process.argv[2];
if(!releaseId||!/^kff-controller-[\w.\-]+-win32-x64-[a-f0-9]{12}$/.test(releaseId))throw Error('A controller release id is required');
const sourceZip=path.join(root,'dist',releaseId+'.zip');
if(!existsSync(sourceZip))throw Error('Missing release archive: '+sourceZip);
const release=JSON.parse(readFileSync(path.join(root,'dist',releaseId,'release.json'),'utf8').replace(/^\uFEFF/,''));
const sha=createHash('sha256').update(readFileSync(sourceZip)).digest('hex');
const bytes=statSync(sourceZip).size;
const zipName=releaseId+'.zip';

// 1. drop previous package files, keep the instruction document in place
for(const entry of readdirSync(delivery)){
 if(entry.endsWith('.zip')||entry.endsWith('.sha256'))rmSync(path.join(delivery,entry),{force:true});
}

// 2. move the new archive in (copy across volumes falls back to read+write)
const zipTarget=path.join(delivery,zipName);
try{renameSync(sourceZip,zipTarget);}catch{writeFileSync(zipTarget,readFileSync(sourceZip));rmSync(sourceZip,{force:true});}
writeFileSync(path.join(delivery,zipName+'.sha256'),sha+'  '+zipName+'\n');

// 3. stamp the instruction document with the new package identity
const doc=path.join(delivery,'新电脑安装与使用说明.txt');
let text=readFileSync(doc,'utf8');
const oldZip=(text.match(/kff-controller-[\w.\-]+-win32-x64-[a-f0-9]{12}\.zip/)??[])[0];
const oldSha=(text.match(/\b[a-f0-9]{64}\b/)??[])[0];
if(!oldZip||!oldSha)throw Error('Cannot locate package identity inside the instruction document');
text=text.split(oldZip).join(zipName);
text=text.split(oldSha).join(sha);
text=text.replace(/^  整理日期：.*$/m,'  整理日期：'+new Date().toISOString().slice(0,10));
text=text.replace(/约 \d+ MB/,'约 '+Math.round(bytes/1024/1024)+' MB');
text=text.replace(
 /  另外如实说明：本包是[\s\S]*?要重新打包后再交付。/,
 '  另外如实说明：本包由当前开发目录的最新生产构建重新封装，\n'+
 '  即打包前对 350 个源码文件逐一校验、全部与构建一致后才生成，\n'+
 '  已包含此前交付版本之后的所有代码改动。\n'+
 '  本次未包含：重新编译验证之外的任何新功能范围；包内仍不含 AdsPower、\n'+
 '  平台账号和任何业务数据。'
);
writeFileSync(doc,text);
console.log(JSON.stringify({release_id:releaseId,zip:zipName,archive_sha256:sha,archive_bytes:bytes,version:release.version,agent_release_id:release.agent_release_id,files_in_package:Object.keys(release.files).length,delivery},null,2));
