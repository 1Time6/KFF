/**
 * §7-A measurement probe for Machine B (measurement only; no production-code change).
 *
 * The Machine B matrix exposed a new upstream failure shape: the stall cases fail at the termination
 * assertion because the recorded fact is the fallback (`enumeration: UNAVAILABLE`, `tool: SKIPPED`,
 * `elapsed_ms: 0`) instead of the termination call's real verdict. This probe measures, separately,
 * what the two termination stages actually cost at 3.0x load on this machine: the process listing and
 * the taskkill, plus the combined terminateProcessTree call, against a live twelve-descendant tree.
 *
 * Load unit: 60 spinner processes / 20 logical cores = 3.0x. Cores are read live, not assumed.
 */
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { listProcesses, terminateProcessTree } from '../../../apps/agent/src/process-tree';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const SPIN = 'const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}';
const FILTER = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*Math.sqrt(Math.random())*\' }';
const spinnerCount = () => {
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(${FILTER} | Measure-Object).Count`], { encoding: 'utf8', windowsHide: true });
  return Number(String(out.stdout).trim() || 0);
};
const killSpinners = () => {
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${FILTER} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
};
const armSpinners = (n: number) => {
  for (let i = 0; i < n; i += 1) spawn(process.execPath, ['-e', SPIN], { stdio: 'ignore', windowsHide: true });
};
const buildTree = (): number | undefined => {
  const parent = spawn(process.execPath, ['-e', "const{spawn}=require('child_process');for(let i=0;i<12;i++){spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});}setInterval(()=>{},1000)"], { stdio: 'ignore', windowsHide: true });
  return parent.pid;
};
const waitAlive = async (pid: number | undefined) => {
  if (!pid) return false;
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(pid, 0); return true; } catch { await sleep(250); }
  }
  return false;
};

const report: Record<string, unknown> = {};
try {
  const cores = os.availableParallelism();
  report.machine = 'Machine-B';
  report.logical_cores = cores;
  report.load_multiplier = 3.0;
  report.spinners_armed = 60;
  report.started_at = new Date().toISOString();
  armSpinners(60);
  await sleep(5000);
  report.spinners_running = spinnerCount();

  // Enumeration cost at 3.0x, three samples.
  const enumSamples: Array<{ ms: number; rows: number | null }> = [];
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    const rows = await listProcesses(7500);
    enumSamples.push({ ms: Date.now() - started, rows: rows ? rows.length : null });
  }
  report.enumeration_deadline_ms = 7500;
  report.enumeration_samples_3x = enumSamples;

  // Combined terminateProcessTree against a live twelve-descendant tree at 3.0x.
  const pid = buildTree();
  const alive = await waitAlive(pid);
  if (!alive) throw new Error('probe tree parent did not come alive');
  const combinedStarted = Date.now();
  const termination = await terminateProcessTree(pid, { deadlineMs: 9000 });
  report.terminate_deadline_ms = 9000;
  report.terminate_combined = { ...termination, wall_ms: Date.now() - combinedStarted };

  // Kill-only cost against a second twelve-descendant tree at 3.0x.
  const pid2 = buildTree();
  const alive2 = await waitAlive(pid2);
  if (!alive2) throw new Error('probe tree parent 2 did not come alive');
  const killStarted = Date.now();
  const kill = spawnSync('taskkill', ['/PID', String(pid2), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  report.kill_only = { wall_ms: Date.now() - killStarted, exit_code: kill.status ?? null };
  report.finished_at = new Date().toISOString();
  console.log('[§7-A machine-b probe] ' + JSON.stringify(report, null, 2));
} finally {
  killSpinners();
  await sleep(3000);
  console.log('[§7-A machine-b probe] post_run_spinners=' + spinnerCount());
}
