import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

/**
 * Detached launcher for the local runtime host.
 *
 * `scripts/local-runtime.ps1 -Action Start` used to spawn the host with `Start-Process`. On Windows
 * that call builds a case-insensitive environment dictionary from this process, so an environment
 * carrying both spellings of a variable - `NO_PROXY` and `no_proxy` is the one seen on this machine -
 * fails with `Item has already been added. Key in dictionary: 'NO_PROXY' Key being added: 'no_proxy'`
 * before the host ever starts. The recovery was a private script under the gitignored `.kff/`
 * directory, so a fresh checkout or another machine had no working start path at all.
 *
 * Node hands the child an environment block it has already de-duplicated, so the same launch works
 * with or without the duplicate spellings, and nothing about proxy values is written into source.
 * This file is the tracked, reviewed equivalent of that workaround; the PowerShell entry keeps
 * ownership of status polling, duplicate-start refusal and the log directory.
 *
 * Usage: node --import tsx scripts/relaunch-local-runtime.ts <root> <log-directory>
 * Prints one JSON line: { launched_pid, stamp, host_log, host_error_log }.
 */
const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const logDirectory = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, '.kff', 'local-runtime');
// Timestamp in the same shape the PowerShell entry used, so log names stay familiar.
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '');
const hostLog = path.join(logDirectory, stamp + '-host.log');
const hostErrorLog = path.join(logDirectory, stamp + '-host-error.log');
mkdirSync(logDirectory, { recursive: true });
const stdout = openSync(hostLog, 'a');
const stderr = openSync(hostErrorLog, 'a');
try {
  // `detached` plus stdio redirected to files keeps the host alive after this launcher exits and
  // after the launching shell closes, which is what the hidden Start-Process call provided.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/local-runtime.ts', 'run'], {
    cwd: root, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true,
  });
  // A spawn failure (a missing cwd, no Node, a refused pipe) is reported as JSON with a null pid
  // rather than crashing with an unhandled 'error' event, so the caller gets the refusal it can
  // act on instead of a stack trace.
  let refusal = null;
  child.on('error', error => { refusal = error.message; });
  child.unref();
  if (refusal) process.stderr.write('启动进程创建失败：' + refusal + '\n');
  process.stdout.write(JSON.stringify({ launched_pid: refusal ? null : child.pid ?? null, stamp, host_log: hostLog, host_error_log: hostErrorLog }) + '\n');
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
