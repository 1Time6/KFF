// B01 probe #2: guardian.ts:37 spawns with { cwd: process.cwd() } and process.execPath.
// Renaming the process's cwd is blocked on Windows (EBUSY). Question: can a parent make a
// *running* child's process.execPath unresolvable — by spawning it from a copy of node.exe
// and then renaming that copy away — and restore it afterwards for a second, successful spawn?
// If yes, an integration test can produce a genuine libuv spawn ENOENT inside the real agent.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (process.argv[2] === 'child') {
  const report = (payload) => process.send && process.send(payload);
  report({ stage: 'boot', execPath: process.execPath, exists: fs.existsSync(process.execPath) });
  process.on('message', (message) => {
    if (message !== 'go') return;
    const events = [];
    const started = Date.now();
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      events.push({ at: Date.now() - started, name: 'spawn-returned', pid: child.pid === undefined ? null : child.pid });
      child.on('error', (error) => events.push({ at: Date.now() - started, name: 'error', code: error.code, pidDefined: child.pid !== undefined }));
      child.on('exit', (code) => events.push({ at: Date.now() - started, name: 'exit', code }));
      child.on('close', (code) => events.push({ at: Date.now() - started, name: 'close', code }));
    } catch (error) {
      events.push({ at: Date.now() - started, name: 'threw-synchronously', code: error.code || String(error) });
    }
    setTimeout(() => report({ stage: 'round', execPathExists: fs.existsSync(process.execPath), events }), 1200);
  });
  return;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kff-b01-exec-'));
const copy = path.join(root, 'node-copy.exe');
fs.copyFileSync(process.execPath, copy);
const child = spawn(copy, [__filename, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
const seen = [];
child.on('message', (message) => {
  seen.push(message);
  if (message.stage === 'boot') {
    // Round 1: try to make process.execPath unresolvable.
    try {
      fs.renameSync(copy, path.join(root, 'node-renamed.exe'));
      seen.push({ action: 'rename-running-exe', result: 'OK' });
    } catch (error) {
      seen.push({ action: 'rename-running-exe', result: error.code });
      try { fs.copyFileSync(process.execPath, copy); fs.truncateSync(copy, 0); seen.push({ action: 'truncate-running-exe', result: 'OK' }); }
      catch (inner) { seen.push({ action: 'truncate-running-exe', result: inner.code }); }
    }
    child.send('go');
  }
  if (message.stage === 'round') {
    if (!message.execPathExists) {
      try { fs.renameSync(path.join(root, 'node-renamed.exe'), copy); seen.push({ action: 'rename-back', result: 'OK' }); }
      catch (error) { seen.push({ action: 'rename-back', result: error.code }); }
      child.send('go');
    } else {
      console.log(JSON.stringify({ root, seen }, null, 2));
      child.kill('SIGKILL');
      process.exit(0);
    }
  }
});
child.on('error', (error) => { console.log('probe child error:', error.code); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT', JSON.stringify(seen, null, 2)); process.exit(1); }, 20000);
