import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { isProcessAlive, terminateProcessTree } from '../../apps/agent/src/process-tree';

// The guardian is spawned detached and the browser it launches is a descendant of it, so ending the
// guardian alone would leave that browser running with nobody left to close it. What that costs is
// measured here with real, throwaway node processes instead of being read off the platform
// documentation: a two-level tree is created, and both the direct kill and the tree kill are observed.
// Every process here is a copy of the interpreter this test already runs on, started with `-e`, and
// each of them exits on its own after 60 seconds so a failed assertion cannot leak a process.

/** A real parent that spawns a real grandchild and reports its pid, then stays alive itself. */
async function spawnTree(): Promise<{ guardian: number; descendant: number; child: ChildProcess }> {
  const inner = "const {spawn}=require('node:child_process');const grandchild=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000)'],{stdio:'ignore'});console.log(grandchild.pid);setTimeout(()=>process.exit(0),60000);";
  // The pid is read back through a pipe, and a shell that exports FORCE_COLOR makes the child decorate
  // its own output, so both the child's environment and the parsing have to be made independent of it.
  const child = spawn(process.execPath, ['-e', inner], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform === 'win32', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const descendant = await new Promise<number>((resolve, reject) => {
    let raw = '';
    child.stdout?.on('data', chunk => { raw += String(chunk); const match = /^(\d+)/.exec(raw.replace(/\[[0-9;]*m/g, '').trim()); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('The process tree exited before it reported its descendant')));
  });
  return { guardian: child.pid!, descendant, child };
}
const reap = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

it('reports liveness only for a process that really exists', () => {
  expect(isProcessAlive(undefined)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(-1)).toBe(false);
  expect(isProcessAlive(process.pid)).toBe(true);
  // A pid that has already been reaped is a different fact from a pid that was never valid, and the
  // probe has to report both as gone rather than throwing.
  expect(isProcessAlive(2147483646)).toBe(false);
  expect(terminateProcessTree(undefined)).toBe(false);
});

/**
 * The reason the utility exists. Killing the direct child is not enough: the grandchild was never this
 * process's child, so nothing about the guardian's own death reaches it.
 */
it('leaves a descendant running when only the direct child is killed', async () => {
  const tree = await spawnTree();
  try {
    expect(isProcessAlive(tree.guardian)).toBe(true);
    expect(isProcessAlive(tree.descendant)).toBe(true);
    tree.child.kill('SIGKILL');
    await expect.poll(() => isProcessAlive(tree.guardian), { timeout: 10000 }).toBe(false);
    expect(isProcessAlive(tree.descendant)).toBe(true);
  } finally { reap(tree.descendant); }
}, 30000);

/** And the reason it works: the tree walk reaches a process the guardian never owned directly. */
it('ends the guardian and everything it started', async () => {
  const tree = await spawnTree();
  try {
    expect(isProcessAlive(tree.guardian)).toBe(true);
    expect(isProcessAlive(tree.descendant)).toBe(true);
    expect(terminateProcessTree(tree.guardian)).toBe(true);
    await expect.poll(() => isProcessAlive(tree.guardian), { timeout: 15000 }).toBe(false);
    await expect.poll(() => isProcessAlive(tree.descendant), { timeout: 15000 }).toBe(false);
  } finally { reap(tree.guardian); reap(tree.descendant); }
}, 40000);
