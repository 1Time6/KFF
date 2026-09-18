import { spawn } from 'node:child_process';
import type { GuardianTermination } from '@kff/contracts';

/**
 * Ending a guardian and everything it started needs two things the first version of this module did
 * not have: a bounded termination call, and a proof that distinguishes "the process is gone" from
 * "I could not find out". A browser the guardian launched is a descendant of the guardian process,
 * so the root pid alone never answers the question the caller is really asking.
 *
 * The three states are deliberately not a boolean. `UNKNOWN` is the answer whenever the probe itself
 * could not reach a conclusion, and callers must treat it exactly as strictly as `ALIVE`: only a
 * proven `DEAD` tree may license releasing an execution slot.
 */
export type ProcessState = 'ALIVE' | 'DEAD' | 'UNKNOWN';
/** What the termination tool itself did, kept apart from what the probes concluded afterwards. */
export type ToolOutcome = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'ERROR' | 'SKIPPED';
/**
 * The termination result *is* the wire contract, not a local shape that later gets copied into one:
 * the agent records exactly the fields the receiver validates, so the two can never drift into
 * disagreeing about what was proven.
 */
export type TreeTermination = GuardianTermination;

/**
 * Measured on Windows 11 (node 22, libuv): a reaped child and a pid that was never handed out both
 * fail with ESRCH, and an inaccessible process is not reported as EPERM at all - libuv maps every
 * Windows failure to ESRCH. POSIX does report EPERM for a live process owned by another user, and
 * that is emphatically not death, so it is classified as UNKNOWN rather than folded into `false`.
 */
export function classifyProbeFailure(error: unknown): ProcessState {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ESRCH') return 'DEAD';
  return 'UNKNOWN';
}

/**
 * A signal 0 probe. It reports whether the process still exists without touching it. An unusable pid
 * means the operating system never created the process at all, which is the one case where absence is
 * provable without asking.
 */
export function probeProcess(pid: number | undefined): ProcessState {
  if (!Number.isSafeInteger(pid) || !pid || pid! < 1) return 'DEAD';
  try { process.kill(pid!, 0); return 'ALIVE'; }
  // `pid 0` answering "alive" on Windows is why the guard above runs first: the probe cannot be
  // trusted to reject a meaningless pid by itself.
  catch (error) { return classifyProbeFailure(error); }
}

/**
 * Kept for callers that only need "may I treat this process as gone". It answers `true` unless death
 * was actually proven, so an `UNKNOWN` probe fails closed instead of reading as a clean exit.
 */
export function isProcessAlive(pid: number | undefined): boolean {
  return probeProcess(pid) !== 'DEAD';
}

/** Runs one external tool under a real deadline. The tool itself is never allowed to outlive it. */
export async function runToolWithDeadline(file: string, args: string[], deadlineMs: number): Promise<{ outcome: ToolOutcome; code: number | null }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: ToolOutcome, code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ outcome, code }); };
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    // The deadline is the point of this function: a tool that hangs must not hold the caller, because
    // the caller is an event loop that also has to keep heartbeats and timers running.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish('TIMEOUT', null); }, Math.max(1, deadlineMs));
    child.once('error', () => finish('ERROR', null));
    child.once('exit', code => finish(code === 0 ? 'SUCCESS' : 'FAILED', code));
  });
}

interface ProcessRow { pid: number; ppid: number }

/**
 * One process listing, used only to learn which processes the guardian owns. `pid 0 answering alive`
 * and localized tool output both rule out text parsing games: only the numeric listing is read, and
 * only the numbers are trusted.
 *
 * The Windows command is shaped the way it is because of where its time goes under load. Measured on
 * this machine at idle, 1x and 2x CPU oversubscription (median of four, against a live tree):
 *
 *   per-object pipeline   673 / 2037 / 7956 ms
 *   statement + one write 630 /  981 / 2166 ms
 *
 * The query is not the expensive part - a bare `Get-CimInstance` is roughly 350 ms of it either way -
 * and neither is powershell's ~300 ms startup. What collapses under load is pushing each of ~370 rows
 * through the `ForEach-Object` cmdlet and writing them one at a time, so this builds the rows with a
 * language `foreach` and emits them in a single `-join`. The rows, the two-column text and the parser
 * are unchanged; a cheaper *shape* is not the same as a cheaper answer, and the format is left alone
 * precisely so the parser cannot start disagreeing with the writer.
 *
 * A two-list variant (both columns emitted as separate comma-joined lines) measured no faster than this
 * one at every load level, so it was dropped rather than kept: reading the pairs back would have meant
 * zipping two independently enumerated lists by position, which is an assumption about ordering that
 * this shape does not need, in exchange for nothing.
 */
export async function listProcesses(deadlineMs: number): Promise<ProcessRow[] | null> {
  const windows = process.platform === 'win32';
  const file = windows ? 'powershell' : 'ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', '$p = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId; $s = foreach ($x in $p) { "$($x.ProcessId) $($x.ParentProcessId)" }; $s -join [char]10'] : ['-eo', 'pid=,ppid='];
  return new Promise(resolve => {
    let settled = false;
    const finish = (rows: ProcessRow[] | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(rows); };
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(null); }, Math.max(1, deadlineMs));
    let text = '';
    child.stdout?.on('data', chunk => { text += String(chunk); if (text.length > 4_000_000) { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(null); } });
    child.once('error', () => finish(null));
    child.once('exit', code => {
      if (code !== 0) { finish(null); return; }
      const rows = text.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])).map(parts => ({ pid: Number(parts[0]), ppid: Number(parts[1]) }));
      finish(rows.length ? rows : null);
    });
  });
}

/**
 * Every process reachable from `pid` through the parent chain. It has to be captured *before* the
 * kill: once the root is gone the chain that identifies its children is gone with it.
 */
export async function listDescendants(pid: number | undefined, deadlineMs: number): Promise<{ enumeration: 'LISTED' | 'UNAVAILABLE'; pids: number[] }> {
  if (!Number.isSafeInteger(pid) || !pid || pid! < 1) return { enumeration: 'LISTED', pids: [] };
  const rows = await listProcesses(deadlineMs);
  if (!rows) return { enumeration: 'UNAVAILABLE', pids: [] };
  const pids: number[] = [];
  const seen = new Set<number>([pid!]);
  let frontier = [pid!];
  while (frontier.length) {
    const next = rows.filter(row => frontier.includes(row.ppid)).map(row => row.pid).filter(child => !seen.has(child));
    for (const value of next) { seen.add(value); pids.push(value); }
    frontier = next;
  }
  return { enumeration: 'LISTED', pids };
}

/**
 * Composes the proof from what was actually observed. Order matters: a single survivor makes the tree
 * alive however many processes died, and a single probe that could not conclude makes it unknown - a
 * partial answer is never rounded up to `DEAD`.
 */
export function composeTreeState(root: ProcessState, descendantStates: ProcessState[]): ProcessState {
  const all = [root, ...descendantStates];
  if (all.includes('ALIVE')) return 'ALIVE';
  if (all.includes('UNKNOWN')) return 'UNKNOWN';
  return 'DEAD';
}

/**
 * The rule that turns observations into a judgement, kept separate so it can be stated once and read
 * directly. An unavailable listing is `UNKNOWN` no matter what the root probe said: the root probe
 * answers a question about one process, and the question being asked here is about a tree.
 */
export function treeStateFrom(enumeration: 'LISTED' | 'UNAVAILABLE', root: ProcessState, descendants: ProcessState): ProcessState {
  return enumeration === 'UNAVAILABLE' ? 'UNKNOWN' : composeTreeState(root, [descendants]);
}

/**
 * Splitting the termination budget, and why it is not an even split.
 *
 * Measured on this machine (Windows 11, 8 logical cores, node 24.14) at three levels of CPU
 * oversubscription - idle, 1x and 2x logical cores held by busy processes:
 *
 *   listing   801 ms /  2564 ms /  9181 ms   (median)
 *   taskkill  305 ms /   460 ms /   966 ms   (median, against twelve detached descendants)
 *
 * Two conclusions are read straight off that table. The listing is about ninety percent of the cost
 * and is the only part that collapses under load; the kill is a small, nearly load-independent tail.
 * An even split therefore starves exactly the stage that needs the time, and leaves a stage that
 * never uses it holding half the budget.
 *
 * The ordering is not negotiable either. The listing has to happen *before* the kill, because on
 * Windows a dead parent's pid stays in its children's `ParentProcessId` field forever - Windows does
 * not reparent orphans the way POSIX does. That stale value is also why the listing cannot simply be
 * run afterwards and trusted: once the pid is recycled it would silently attach an unrelated
 * process's children to the dead guardian. Listing first is what makes pid identity sound.
 */
const KILL_RESERVE_MAX_MS = 1500;
/** Below this a listing process cannot even start; a smaller slice would only burn budget. */
const MIN_ENUM_MS = 250;
/** A failed kill is only worth repeating if this much time is still left for the retry to run. */
const MIN_KILL_RETRY_MS = 400;

/**
 * Ends the guardian and the tree it owns, then reports what could be proven about it.
 *
 * Everything here runs under one deadline. The listing is capped by `killReserve` rather than handed a
 * fixed slice, so time it does not use flows to the kill automatically, and no sub-stage floor can
 * push the total past the caller's budget: every wait is computed from the same `deadline`, and the
 * floors only decide whether another attempt is worth starting, never how long it may run.
 *
 * A listing that could not be obtained is still `UNKNOWN` rather than a comfortable `DEAD`: an
 * unproven tree must fail closed, which costs a human review instead of a reused browser profile.
 */
export async function terminateProcessTree(pid: number | undefined, options: { deadlineMs: number }): Promise<TreeTermination> {
  const started = Date.now();
  const budget = Math.max(1, options.deadlineMs);
  const deadline = started + budget;
  if (!Number.isSafeInteger(pid) || !pid || pid! < 1) return { process_tree: 'DEAD', tool: 'SKIPPED', root: 'DEAD', descendants: 'DEAD', sampled: 0, enumeration: 'LISTED', elapsed_ms: 0 };

  // Reserve the kill's share first, so a listing that hangs cannot consume the budget the kill needs
  // to exist at all. Proportional for small budgets, capped for large ones.
  const killReserve = Math.max(1, Math.min(Math.floor(budget / 3), KILL_RESERVE_MAX_MS));
  const enumDeadline = deadline - killReserve;

  let enumeration: 'LISTED' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let pids: number[] = [];
  for (;;) {
    const slice = enumDeadline - Date.now();
    if (slice < MIN_ENUM_MS) break;
    const attemptStarted = Date.now();
    const listing = await listDescendants(pid, slice);
    if (listing.enumeration === 'LISTED') { enumeration = 'LISTED'; pids = listing.pids; break; }
    // Retry only a listing that ran out of time. One that failed immediately - the tool is missing, or
    // it exited non-zero - has already given its answer, and more time will not change it. Without
    // this distinction a tool that cannot start at all would be re-spawned until the budget ran out.
    if (Date.now() - attemptStarted < Math.floor(slice * 0.8)) break;
  }

  // The reserve above is what actually cures a starved kill: measured `taskkill /T /F` against twelve
  // detached descendants peaks at ~1.1 s at 2x load, so 1.5 s is a sufficient share rather than a
  // hopeful one, and it is held back before the listing can spend it. This loop is the backstop. It
  // guarantees an attempt happens even when the listing consumed everything, so "there was no time to
  // try" can never be recorded as `SKIPPED` - something the tool did - and it re-asks only after a
  // timeout, because `FAILED` and `ERROR` are answers that a second ask cannot change. On Windows a
  // timeout consumes its whole slice, so in practice this runs once; the second chance is for callers
  // whose tool returns early.
  let tool: { outcome: ToolOutcome; code: number | null } = { outcome: 'SKIPPED', code: null };
  for (let attempt = 0; ; attempt += 1) {
    const slice = deadline - Date.now();
    if (attempt > 0 && slice < MIN_KILL_RETRY_MS) break;
    tool = process.platform === 'win32'
      ? await runToolWithDeadline('taskkill', ['/PID', String(pid), '/T', '/F'], Math.max(1, slice))
      : await runGroupKill(pid);
    if (tool.outcome !== 'TIMEOUT') break;
  }

  const root = probeProcess(pid);
  const descendants = pids.map(probeProcess);
  return {
    process_tree: treeStateFrom(enumeration, root, composeTreeState('DEAD', descendants)),
    tool: tool.outcome,
    root,
    descendants: composeTreeState('DEAD', descendants),
    sampled: pids.length,
    enumeration,
    elapsed_ms: Date.now() - started,
  };
}

/**
 * POSIX path, UNVERIFIED on this machine (the project runs on Windows 11 and the batch that added
 * this module recorded the gap rather than claiming a Linux/macOS proof). `kill(-pid)` only reaches a
 * process group when the guardian is a group leader, which `runGuardian` does not currently establish
 * on POSIX, so the group kill can fail and leave descendants behind. That is exactly why the caller
 * verifies the tree afterwards instead of trusting this call: a survivor comes back as `ALIVE`.
 */
async function runGroupKill(pid: number): Promise<{ outcome: ToolOutcome; code: number | null }> {
  try { process.kill(-pid, 'SIGKILL'); return { outcome: 'SUCCESS', code: 0 }; }
  catch {
    try { process.kill(pid, 'SIGKILL'); return { outcome: 'SUCCESS', code: 0 }; }
    catch { return { outcome: 'FAILED', code: null }; }
  }
}
