import { spawnSync } from 'node:child_process';

/**
 * Ends a guardian and everything it started. A browser the guardian launched is a descendant of the
 * guardian process, so ending only the guardian would leave that browser running with nobody left to
 * close it. On Windows the tree-walking tool is `taskkill /T`, which follows the parent chain; on
 * POSIX the guardian is spawned detached, so its own process group is the tree.
 */
export function terminateProcessTree(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid! < 1) return false;
  if (process.platform === 'win32') return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
  try { process.kill(-pid!, 'SIGKILL'); return true; }
  catch { try { process.kill(pid!, 'SIGKILL'); return true; } catch { return false; } }
}

/** A signal 0 probe: it reports whether the process still exists without touching it. */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid! < 1) return false;
  try { process.kill(pid!, 0); return true; } catch { return false; }
}
