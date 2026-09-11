import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from '@kff/database';
import { importLimits, parsedImportSchema, type ImportUpload } from '../../contracts/src/imports';
import { AppError, requireCondition } from './index';

let active = 0;
export async function parseImportFile(bytes: Buffer, input: Pick<ImportUpload,'format'|'encoding'>) {
  requireCondition(bytes.length > 0 && bytes.length <= importLimits.file_bytes, 'FILE_LIMIT_EXCEEDED', '文件必须在 8 MiB 以内', 413);
  requireCondition(active < 2, 'PARSER_BUSY', '当前文件解析繁忙，请稍后重试', 429); active++;
  try {
    return await new Promise<ReturnType<typeof parsedImportSchema.parse>>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=256','--disable-proto=throw',path.join(projectRoot,'scripts/import-parser.mjs'),input.format,input.encoding], { cwd:projectRoot, windowsHide:true, env:{ NODE_ENV:'production',SystemRoot:process.env.SystemRoot, PATH:process.env.PATH }, stdio:['pipe','pipe','ignore'] });
      let length = 0; const chunks:Buffer[] = []; let failure:AppError|undefined;
      const stop = (code:string, message:string) => { failure ??= new AppError(code,message,422); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('PARSER_TIMEOUT','文件解析超时，未入库'),importLimits.parser_ms);
      child.on('error', () => { clearTimeout(timer); reject(new AppError('PARSER_UNAVAILABLE','文件解析进程未能启动',503)); });
      child.stdout.on('data', (chunk:Buffer) => { length += chunk.length; if (length > 16*1024*1024) stop('FILE_LIMIT_EXCEEDED','文件展开内容过大'); else chunks.push(chunk); });
      child.stdin.on('error', () => { /* Process exit determines the outcome; a rejected file may close stdin early. */ });
      child.on('close', () => {
        clearTimeout(timer); if (failure) { reject(failure); return; }
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result.ok) { reject(new AppError(result.code ?? 'INVALID_FILE','文件格式、编码或大小不符合导入要求',422)); return; } resolve(parsedImportSchema.parse(result.parsed)); }
        catch { reject(new AppError('INVALID_FILE','文件解析未返回有效结果',422)); }
      }); child.stdin.end(bytes);
    });
  } finally { active--; }
}
