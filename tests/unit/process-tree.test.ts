import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyProbeFailure, composeTreeState, isProcessAlive, listDescendants, probeProcess, runToolWithDeadline, terminateProcessTree, treeStateFrom } from '../../apps/agent/src/process-tree';

// The guardian is spawned detached and the browser it launches is a descendant of it, so ending the
// guardian alone would leave that browser running with nobody left to close it. What that costs is
// measured here with real, throwaway node processes instead of being read off the platform
// documentation: a two-level tree is created, and both the direct kill and the tree kill are observed.
// Every process here is a copy of the interpreter this test already runs on, started with `-e`, and
// each of them exits on its own after 60 seconds so a failed assertion cannot leak a process.

/**
 * A real parent that spawns a real grandchild and reports its pid, then stays alive itself.
 *
 * `detachedDescendant` decides whether the grandchild survives its parent, and the difference is
 * measured rather than assumed: on Windows a descendant that shares the dying process's console is
 * terminated with it (observed: gone within 150ms of the parent's death), while a descendant started
 * detached keeps running. The second form is the one a survivor test needs, and it is also the honest
 * model of a browser that outlives the guardian which launched it.
 */
async function spawnTree(detachedDescendant = false): Promise<{ guardian: number; descendant: number; child: ChildProcess }> {
  const grandchild = "spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000)'],{stdio:'ignore'" + (detachedDescendant ? ",detached:true,windowsHide:true" : '') + '})';
  const inner = `const {spawn}=require('node:child_process');const grandchild=${grandchild};console.log(grandchild.pid);setTimeout(()=>process.exit(0),60000);`;
  // The pid is read back through a pipe, and a shell that exports FORCE_COLOR makes the child decorate
  // its own output, so both the child's environment and the parsing have to be made independent of it.
  const child = spawn(process.execPath, ['-e', inner], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform === 'win32', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const descendant = await new Promise<number>((resolve, reject) => {
    let raw = '';
    child.stdout?.on('data', chunk => { raw += String(chunk); const match = /^(\d+)/.exec(raw.replace(/\[[0-9;]*m/g, '').trim()); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('The process tree exited before it reported its descendant')));
  });
  return { guardian: child.pid!, descendant, child };
}
/** A lone process with no children of its own, so a termination of it can never drag in a bystander. */
async function spawnSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  await expect.poll(() => probeProcess(child.pid), { timeout: 10000 }).toBe('ALIVE');
  return child.pid!;
}
const reap = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };
/**
 * Runs the body with no executable search path, so every tool the module spawns by name fails to
 * start. Nothing in the code under test is replaced: the platform call is left exactly as it is and
 * only the operating system's ability to find the program is removed, which is the same condition a
 * machine without the utility would present.
 */
async function withoutToolPath<T>(body: () => Promise<T>): Promise<T> {
  const environment = process.env as Record<string, string | undefined>;
  const saved = [['PATH', environment.PATH], ['Path', environment.Path]] as const;
  delete environment.PATH; delete environment.Path;
  try { return await body(); } finally { for (const [key, value] of saved) { if (value === undefined) delete environment[key]; else environment[key] = value; } }
}

it('reports liveness only for a process that really exists', () => {
  expect(isProcessAlive(undefined)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(-1)).toBe(false);
  expect(isProcessAlive(process.pid)).toBe(true);
  // A pid that has already been reaped is a different fact from a pid that was never valid, and the
  // probe has to report both as gone rather than throwing.
  expect(isProcessAlive(2147483646)).toBe(false);
});

it('answers with three states, not a boolean', () => {
  expect(probeProcess(process.pid)).toBe('ALIVE');
  expect(probeProcess(2147483646)).toBe('DEAD');
  // `pid 0` answers "alive" to a signal-0 probe on Windows (measured), so the guard has to reject a
  // meaningless pid before the probe is even attempted. It is the one absence that is provable without
  // asking the operating system, because no process was ever given that id.
  expect(probeProcess(0)).toBe('DEAD');
  expect(probeProcess(undefined)).toBe('DEAD');
});

it('refuses to read death out of a probe failure it cannot interpret', () => {
  // ESRCH is the one answer that means the process is gone. Everything else - EPERM on a process owned
  // by another user, a malformed pid, an unknown errno - is a failure to find out, and calling that
  // death is how a live browser gets released by mistake.
  expect(classifyProbeFailure(Object.assign(new Error('no such process'), { code: 'ESRCH' }))).toBe('DEAD');
  expect(classifyProbeFailure(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))).toBe('UNKNOWN');
  expect(classifyProbeFailure(new Error('something else'))).toBe('UNKNOWN');
  expect(classifyProbeFailure(undefined)).toBe('UNKNOWN');
});

it('never rounds a partial answer up to dead', () => {
  expect(composeTreeState('DEAD', ['DEAD', 'DEAD'])).toBe('DEAD');
  expect(composeTreeState('DEAD', ['ALIVE'])).toBe('ALIVE');
  expect(composeTreeState('DEAD', ['UNKNOWN'])).toBe('UNKNOWN');
  expect(composeTreeState('ALIVE', ['DEAD'])).toBe('ALIVE');
  expect(composeTreeState('UNKNOWN', ['ALIVE'])).toBe('ALIVE');
  // And an unreadable listing outranks every probe: whatever the root looks like, nobody looked at the
  // rest of the tree, so the tree state cannot be claimed.
  expect(treeStateFrom('UNAVAILABLE', 'DEAD', 'DEAD')).toBe('UNKNOWN');
  expect(treeStateFrom('LISTED', 'DEAD', 'DEAD')).toBe('DEAD');
  expect(treeStateFrom('LISTED', 'DEAD', 'ALIVE')).toBe('ALIVE');
});

it('classifies a termination of an unusable pid as nothing to do', async () => {
  const termination = await terminateProcessTree(undefined, { deadlineMs: 1000 });
  expect(termination.process_tree).toBe('DEAD');
  expect(termination.tool).toBe('SKIPPED');
  expect(termination.sampled).toBe(0);
});

/**
 * The deadline is the reason this function exists. A tool that hangs must not hold the caller, because
 * the caller is an event loop that still has to emit heartbeats and run the watchdog, so a real
 * interpreter that sleeps for a minute is asked to finish in a fraction of a second.
 */
it('ends a tool that outlives its deadline instead of waiting for it', async () => {
  const started = Date.now();
  const slow = await runToolWithDeadline(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 400);
  expect(slow.outcome).toBe('TIMEOUT');
  expect(Date.now() - started).toBeLessThan(10000);
  const failed = await runToolWithDeadline(process.execPath, ['-e', 'process.exit(3)'], 10000);
  expect(failed.outcome).toBe('FAILED');
  expect(failed.code).toBe(3);
  const succeeded = await runToolWithDeadline(process.execPath, ['-e', 'process.exit(0)'], 10000);
  expect(succeeded.outcome).toBe('SUCCESS');
  // A tool that does not exist is an error, not a silent success: a missing taskkill may not read as a
  // terminated process.
  const missing = await runToolWithDeadline('kff-no-such-tool-9d1f', [], 10000);
  expect(missing.outcome).toBe('ERROR');
});

it('lists the descendants of a real process before anything is killed', async () => {
  const tree = await spawnTree();
  try {
    const listing = await listDescendants(tree.guardian, 5000);
    expect(listing.enumeration).toBe('LISTED');
    expect(listing.pids).toContain(tree.descendant);
  } finally { reap(tree.guardian); reap(tree.descendant); }
}, 30000);

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
it('ends the guardian and everything it started, and says so', async () => {
  const tree = await spawnTree();
  try {
    expect(isProcessAlive(tree.guardian)).toBe(true);
    expect(isProcessAlive(tree.descendant)).toBe(true);
    const termination = await terminateProcessTree(tree.guardian, { deadlineMs: 15000 });
    // The judgement is only worth having if it is the composed one: the descendant had to be listed
    // before the kill, or "the root is gone" would be reported as "the tree is gone".
    expect(termination.process_tree).toBe('DEAD');
    expect(termination.enumeration).toBe('LISTED');
    expect(termination.sampled).toBeGreaterThanOrEqual(1);
    expect(termination.root).toBe('DEAD');
    expect(termination.elapsed_ms).toBeLessThan(60000);
    await expect.poll(() => isProcessAlive(tree.guardian), { timeout: 15000 }).toBe(false);
    await expect.poll(() => isProcessAlive(tree.descendant), { timeout: 15000 }).toBe(false);
  } finally { reap(tree.guardian); reap(tree.descendant); }
}, 40000);

/**
 * The case that decides whether an execution slot may be reused. A guardian whose own pid is gone
 * proves nothing about the browser it launched: the descendant was started detached, so nothing about
 * the parent's death reaches it, and the enumeration still finds it.
 */
it('reports ALIVE when the root is gone but a descendant it started is still running', async () => {
  const tree = await spawnTree(true);
  try {
    reap(tree.guardian);
    await expect.poll(() => probeProcess(tree.guardian), { timeout: 10000 }).toBe('DEAD');
    expect(probeProcess(tree.descendant)).toBe('ALIVE');
    const termination = await terminateProcessTree(tree.guardian, { deadlineMs: 9000 });
    // The root probe really says DEAD and the tool really ran; the tree is still ALIVE, because the
    // process that is actually holding the browser profile was listed and answered a probe.
    expect(termination).toMatchObject({ process_tree: 'ALIVE', root: 'DEAD', descendants: 'ALIVE', enumeration: 'LISTED' });
    expect(termination.sampled).toBeGreaterThanOrEqual(1);
    // Windows `taskkill` on a pid that no longer exists exits non-zero (measured: 128), so the tool is
    // recorded as failed. That is the whole point of keeping the two apart: a failed tool and a dead
    // root together still do not add up to a dead tree.
    expect(termination.tool).toBe('FAILED');
    expect(probeProcess(tree.descendant)).toBe('ALIVE');
  } finally { reap(tree.descendant); }
}, 30000);

/**
 * Both halves of the bounded-liveness requirement in one call: the tool is killed at its deadline
 * instead of being waited for, and a tree nobody managed to enumerate is `UNKNOWN` rather than dead.
 */
it('proves nothing about a tree it could not enumerate, and ends the tool at its deadline', async () => {
  const victim = await spawnSleeper();
  try {
    const started = Date.now();
    const termination = await terminateProcessTree(victim, { deadlineMs: 2 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(termination.tool).toBe('TIMEOUT');
    expect(termination.enumeration).toBe('UNAVAILABLE');
    expect(termination.process_tree).toBe('UNKNOWN');
    // The victim is untouched, and that is the point: a tool that timed out did not terminate anything.
    expect(probeProcess(victim)).toBe('ALIVE');
    const tool = await runToolWithDeadline('taskkill', ['/PID', String(victim), '/T', '/F'], 1);
    expect(tool.outcome).toBe('TIMEOUT');
  } finally { reap(victim); }
}, 30000);

/**
 * `tool success`, `root dead` and `tree dead` are three different facts, and the record has to keep
 * them apart. Here the tool fails and the root is dead: the tree judgement still comes from the
 * probes, and it is DEAD for a reason nobody can mistake for the tool's answer.
 */
it('separates what the termination tool did from what the probes proved', async () => {
  const victim = await spawnSleeper();
  reap(victim);
  await expect.poll(() => probeProcess(victim), { timeout: 10000 }).toBe('DEAD');
  const termination = await terminateProcessTree(victim, { deadlineMs: 9000 });
  expect(termination).toMatchObject({ tool: 'FAILED', root: 'DEAD', descendants: 'DEAD', process_tree: 'DEAD', enumeration: 'LISTED', sampled: 0 });
}, 30000);

/**
 * A termination utility that cannot even be started is an error, not a termination. This is the shape
 * of failure that used to be indistinguishable from success: the caller asked for a kill, the call
 * returned, and nothing had happened.
 */
it('never records a termination when the termination utility itself could not run', async () => {
  const victim = await spawnSleeper();
  try {
    const termination = await withoutToolPath(() => terminateProcessTree(victim, { deadlineMs: 6000 }));
    expect(termination.tool).toBe('ERROR');
    expect(termination.process_tree).not.toBe('DEAD');
    expect(probeProcess(victim)).toBe('ALIVE');
  } finally { reap(victim); }
}, 30000);

/** A dead root is one fact; a tree that was never listed is another, and the second one fails closed. */
it('refuses to infer a dead tree from a dead root when no listing was obtained', async () => {
  expect(treeStateFrom('UNAVAILABLE', 'DEAD', 'DEAD')).toBe('UNKNOWN');
  const victim = await spawnSleeper();
  reap(victim);
  await expect.poll(() => probeProcess(victim), { timeout: 10000 }).toBe('DEAD');
  const termination = await terminateProcessTree(victim, { deadlineMs: 2 });
  expect(termination.root).toBe('DEAD');
  expect(termination.enumeration).toBe('UNAVAILABLE');
  expect(termination.process_tree).toBe('UNKNOWN');
}, 30000);

/**
 * POSIX process-group termination stays UNVERIFIED in this batch and is written down as such: the
 * machine runs Windows 11, `runGroupKill` is never reached here, and nothing observed on Windows may
 * be extrapolated to it. These are the acceptance items the next round has to cover on a real Linux
 * or macOS host - they are skipped rather than passed, so no test result can be read as a proof.
 */
describe('POSIX process-group termination (UNVERIFIED on this machine)', () => {
  it.skip('ends a detached descendant through the process group', () => {});
  it.skip('reports ALIVE for a descendant the group kill missed', () => {});
});
