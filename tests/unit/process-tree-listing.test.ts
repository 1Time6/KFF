import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { listProcesses } from '../../apps/agent/src/process-tree';

/**
 * The listing is the input to every later death proof, so its failure modes are pinned here with the
 * same shape the operating system boundary presents: a child process whose stdout may deliver rows
 * after `exit`, and whose close may never arrive before the deadline. The platform is not simulated -
 * the module's own spawn boundary is the seam, exactly like the guardian's termination dependency.
 */
type ScriptedChild = EventEmitter & { stdout: EventEmitter; kill(signal?: string): boolean; signals: string[] };

function scriptedSpawn(script: (child: ScriptedChild) => void) {
  return () => {
    const child = new EventEmitter() as ScriptedChild;
    child.stdout = new EventEmitter();
    child.signals = [];
    child.kill = (signal?: string) => { child.signals.push(signal ?? 'SIGTERM'); return true; };
    setImmediate(() => script(child));
    return child as unknown as ChildProcess;
  };
}

it('reads a complete numeric listing', async () => {
  const rows = await listProcesses(1000, scriptedSpawn(child => {
    child.stdout.emit('data', Buffer.from('100 1\n200 100\n'));
    child.emit('exit', 0);
    child.stdout.emit('end');
    child.emit('close', 0);
  }));
  expect(rows).toEqual([{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }]);
});

it('refuses a listing whose process exited non-zero', async () => {
  const rows = await listProcesses(1000, scriptedSpawn(child => {
    child.stdout.emit('data', Buffer.from('100 1\n'));
    child.emit('exit', 1);
    child.stdout.emit('end');
    child.emit('close', 1);
  }));
  expect(rows).toBeNull();
});

it('refuses a listing with a non-empty row it cannot parse instead of dropping that row', async () => {
  const rows = await listProcesses(1000, scriptedSpawn(child => {
    child.stdout.emit('data', Buffer.from('100 1\n200\n'));
    child.emit('exit', 0);
    child.stdout.emit('end');
    child.emit('close', 0);
  }));
  expect(rows).toBeNull();
});

it('waits for stdout to close so a row delivered after exit is not lost', async () => {
  const events: string[] = [];
  const rows = await listProcesses(2000, scriptedSpawn(child => {
    events.push('data:first');
    child.stdout.emit('data', Buffer.from('100 1\n'));
    events.push('exit');
    child.emit('exit', 0);
    setTimeout(() => {
      events.push('data:late');
      child.stdout.emit('data', Buffer.from('200 100\n'));
      child.stdout.emit('end');
      child.emit('close', 0);
    }, 20);
  }));
  expect(rows).toEqual([{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }]);
  expect(events).toEqual(['data:first', 'exit', 'data:late']);
});

/**
 * The packaged STREAM-04 fixture uses a non-detached grandchild, which Windows terminates together
 * with its parent's console; the late row therefore never exists on this platform (measured). A
 * detached descendant does survive and keeps the inherited stdout pipe open, producing the same
 * data -> exit -> late data -> close ordering the Linux fixture produces. This is that race, run
 * against real Windows processes instead of a simulated stream.
 */
it('keeps a late row written by a real detached descendant after the listing process exits', async () => {
  const events: string[] = [];
  const inner = [
    "const {spawn}=require('node:child_process');",
    "process.stdout.write('100 1\\n');",
    "const c=spawn(process.execPath,['-e',\"setTimeout(()=>{process.stdout.write('200 100\\\\n')},180)\"],{stdio:['ignore',1,'ignore'],detached:true,windowsHide:true});",
    'c.unref();',
    'process.exit(0);',
  ].join('');
  const rows = await listProcesses(3000, () => {
    const child = spawn(process.execPath, ['-e', inner], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.stdout?.on('data', data => events.push('data:' + String(data).trim()));
    child.once('exit', code => events.push('exit:' + code));
    child.once('close', code => events.push('close:' + code));
    return child;
  });
  expect(rows).toEqual([{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }]);
  expect(events).toEqual(['data:100 1', 'exit:0', 'data:200 100', 'close:0']);
}, 15000);

it('treats an empty or failed listing as unavailable, never as an empty process table', async () => {
  const empty = await listProcesses(1000, scriptedSpawn(child => {
    child.stdout.emit('data', Buffer.from(''));
    child.emit('exit', 0);
    child.stdout.emit('end');
    child.emit('close', 0);
  }));
  expect(empty).toBeNull();
  const failed = await listProcesses(1000, scriptedSpawn(child => { child.emit('error', new Error('missing tool')); }));
  expect(failed).toBeNull();
});

it('ends the listing at its deadline and reports no rows', async () => {
  let child: ScriptedChild | undefined;
  const rows = await listProcesses(50, scriptedSpawn(value => { child = value; }));
  expect(rows).toBeNull();
  expect(child?.signals).toContain('SIGKILL');
});
