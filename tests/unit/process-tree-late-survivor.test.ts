import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { expect, it, vi } from 'vitest';

type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const control = vi.hoisted(() => ({ spawnImpl: undefined as unknown }));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: SpawnOptions) => {
      const impl = control.spawnImpl as SpawnLike | undefined;
      return impl ? impl(file, args, options) : actual.spawn(file, args, options);
    },
  };
});

import { terminateProcessTree } from '../../apps/agent/src/process-tree';

type FakeChild = EventEmitter & { stdout: EventEmitter; kill(signal?: string): boolean };
type Mode = 'success-clean' | 'late-survivor' | 'visible-late-survivor' | 'verify-unavailable';

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.kill = () => true;
  return child;
}

/**
 * The operating system boundary, shaped like the packaged termination counterexample: the pre-kill
 * listing sees 100 and its child 200; taskkill ends both; a 300 born after the listing survives a
 * partially failed tool and is not in the snapshot. The real pid values are fixture values - the
 * process.kill probe is stubbed and falls back to the real implementation for everything else.
 */
function simulatedTree(mode: Mode) {
  const states = new Map<number, 'ALIVE' | 'DEAD'>([[100, 'ALIVE'], [200, 'ALIVE']]);
  const probes: number[] = [];
  let listings = 0;
  const spawnImpl: SpawnLike = file => {
    const child = fakeChild();
    setImmediate(() => {
      if (file === 'powershell') {
        listings += 1;
        const unavailable = mode === 'verify-unavailable' && listings > 1;
        const text = mode === 'visible-late-survivor' && listings > 1 ? '300 200\n' : '100 1\n200 100\n';
        if (unavailable) { child.emit('exit', 1); return; }
        child.stdout.emit('data', Buffer.from(text));
        child.emit('exit', 0);
        child.stdout.emit('end');
        child.emit('close', 0);
        return;
      }
      if (file === 'taskkill') {
        states.set(100, 'DEAD');
        states.set(200, 'DEAD');
        if (mode === 'late-survivor' || mode === 'visible-late-survivor') {
          states.set(300, 'ALIVE');
          // A partial failure: the tool did not reach the process it never listed.
          child.emit('exit', mode === 'late-survivor' ? 1 : 0);
          return;
        }
        child.emit('exit', 0);
        return;
      }
      throw new Error('unexpected executable: ' + file);
    });
    return child as unknown as ChildProcess;
  };
  return { states, probes, spawnImpl };
}

function withSimulation<T>(fixture: ReturnType<typeof simulatedTree>, body: () => Promise<T>): Promise<T> {
  control.spawnImpl = fixture.spawnImpl;
  const realKill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    const state = fixture.states.get(pid);
    if (state === undefined) return realKill(pid, signal);
    fixture.probes.push(pid);
    if (state === 'ALIVE') return true;
    throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
  });
  return body().finally(() => {
    spy.mockRestore();
    control.spawnImpl = undefined;
  });
}

it('still certifies a dead tree when the tool succeeded and the re-listing is clean', async () => {
  const fixture = simulatedTree('success-clean');
  await withSimulation(fixture, async () => {
    const result = await terminateProcessTree(100, { deadlineMs: 3000 });
    expect(result).toMatchObject({ process_tree: 'DEAD', tool: 'SUCCESS', root: 'DEAD', descendants: 'DEAD', sampled: 1, enumeration: 'LISTED' });
  });
});

it('refuses DEAD when a partially failed tool may have missed a process that was born after the snapshot', async () => {
  const fixture = simulatedTree('late-survivor');
  await withSimulation(fixture, async () => {
    const result = await terminateProcessTree(100, { deadlineMs: 3000 });
    expect(fixture.states.get(300)).toBe('ALIVE');
    // The snapshot only ever contained 100 and 200, which is exactly why its probe cannot speak for
    // the survivor. A failed tool plus an incomplete observation is UNKNOWN, not DEAD.
    expect(result).toMatchObject({ process_tree: 'UNKNOWN', tool: 'FAILED', root: 'DEAD', descendants: 'UNKNOWN', sampled: 1, enumeration: 'LISTED' });
    expect(fixture.probes).toContain(100);
    expect(fixture.probes).toContain(200);
    expect(fixture.probes).not.toContain(300);
  });
});

it('reports ALIVE when the bounded re-listing finds a process the snapshot did not contain', async () => {
  const fixture = simulatedTree('visible-late-survivor');
  await withSimulation(fixture, async () => {
    const result = await terminateProcessTree(100, { deadlineMs: 3000 });
    expect(result).toMatchObject({ process_tree: 'ALIVE', tool: 'SUCCESS', root: 'DEAD', descendants: 'ALIVE', sampled: 1, enumeration: 'LISTED' });
  });
});

it('keeps the tree unproven when the post-kill re-listing cannot be obtained', async () => {
  const fixture = simulatedTree('verify-unavailable');
  await withSimulation(fixture, async () => {
    const result = await terminateProcessTree(100, { deadlineMs: 3000 });
    expect(result).toMatchObject({ process_tree: 'UNKNOWN', tool: 'SUCCESS', root: 'DEAD', descendants: 'UNKNOWN', sampled: 1, enumeration: 'LISTED' });
  });
});
