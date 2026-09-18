// B01 probe: can a running Node process be made to fail spawn() with a REAL libuv error,
// deterministically, from outside the process? guardian.ts:37 uses { cwd: process.cwd() },
// so the only lever available to a test is the process's own cwd.
// This probe answers: after the process's cwd directory is renamed away, what does
// process.cwd() return, and does spawn() then emit error/exit/close — and in what order?
const { spawn } = require('node:child_process');
const { mkdtempSync, renameSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (process.argv[2] === 'child') {
  const report = (payload) => process.send && process.send(payload);
  let cwdValue, cwdThrew = null;
  try { cwdValue = process.cwd(); } catch (error) { cwdThrew = error.code || String(error); }
  report({ stage: 'before-rename', cwdValue, cwdThrew });
  process.on('message', (message) => {
    if (message !== 'go') return;
    let nowCwd, nowThrew = null;
    try { nowCwd = process.cwd(); } catch (error) { nowThrew = error.code || String(error); }
    const events = [];
    const started = Date.now();
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: nowCwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      events.push({ at: Date.now() - started, name: 'spawn-returned', pid: child.pid === undefined ? null : child.pid });
      child.on('error', (error) => events.push({ at: Date.now() - started, name: 'error', code: error.code, pidDefined: child.pid !== undefined }));
      child.on('exit', (code) => events.push({ at: Date.now() - started, name: 'exit', code }));
      child.on('close', (code) => events.push({ at: Date.now() - started, name: 'close', code }));
    } catch (error) {
      events.push({ at: Date.now() - started, name: 'threw-synchronously', code: error.code || String(error) });
    }
    setTimeout(() => report({ stage: 'after-rename', nowCwd, nowThrew, events }), 1500);
  });
  return;
}

const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-probe-'));
const live = path.join(root, 'live');
require('node:fs').mkdirSync(live);
const child = spawn(process.execPath, [__filename, 'child'], { cwd: live, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
const seen = [];
child.on('message', (message) => {
  seen.push(message);
  if (message.stage === 'before-rename') {
    renameSync(live, path.join(root, 'moved-away'));
    child.send('go');
  }
  if (message.stage === 'after-rename') {
    console.log(JSON.stringify({ root, seen }, null, 2));
    child.kill('SIGKILL');
    process.exit(0);
  }
});
child.on('error', (error) => { console.log('probe child error:', error.code); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT', JSON.stringify(seen, null, 2)); process.exit(1); }, 15000);
