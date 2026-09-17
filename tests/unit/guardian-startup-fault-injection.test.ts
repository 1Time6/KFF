import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { guardianStartupFaultInjectionEnabled, runGuardian } from '../../apps/agent/src/guardian';
import { readClosureEvidence, startupFailedProtocolVersion } from '../../apps/agent/src/guardian-protocol';
import { fixtureCommand } from '../helpers/commands';
import type { AgentCommand } from '../../packages/contracts/src/index';

const testsRoot = path.resolve(os.tmpdir(), 'kff-root', '.kff', 'agent-process-tests');
const sealed = (runtime: string, environment: Record<string, string | undefined>) => guardianStartupFaultInjectionEnabled(runtime, environment);
const on = { NODE_ENV: 'test', KFF_TEST_GUARDIAN_DIES_BEFORE_READY: 'true', KFF_ROOT: path.resolve(os.tmpdir(), 'kff-root') };

it('enables the switch only when all three conditions hold at once', () => {
  expect(sealed(path.join(testsRoot, 'agent-1'), on)).toBe(true);
  // Normalised the same way the production call site normalises the runtime directory.
  expect(sealed(path.join(testsRoot, 'sub', '..', 'agent-1'), on)).toBe(true);
});

it('refuses the switch for every single condition that disagrees', () => {
  const runtime = path.join(testsRoot, 'agent-1');
  expect(sealed(runtime, { ...on, NODE_ENV: 'production' })).toBe(false);
  expect(sealed(runtime, { ...on, NODE_ENV: undefined })).toBe(false);
  expect(sealed(runtime, { ...on, NODE_ENV: 'Test' })).toBe(false);
  expect(sealed(runtime, { ...on, KFF_TEST_GUARDIAN_DIES_BEFORE_READY: 'TRUE' })).toBe(false);
  expect(sealed(runtime, { ...on, KFF_TEST_GUARDIAN_DIES_BEFORE_READY: '1' })).toBe(false);
  expect(sealed(runtime, { ...on, KFF_TEST_GUARDIAN_DIES_BEFORE_READY: undefined })).toBe(false);
});

it('keeps every path outside the tests root sealed, including the sibling directory a substring test would accept', () => {
  expect(sealed(path.join(testsRoot, '..', 'agent-process-tests-production', 'agent-1'), on)).toBe(false);
  expect(sealed(path.join(testsRoot, '..', 'agent-process-tests-production'), on)).toBe(false);
  expect(sealed(testsRoot, on)).toBe(false); // The root itself is not "inside" the root.
  expect(sealed(path.join(testsRoot, '..'), on)).toBe(false);
  expect(sealed(path.join(testsRoot, '..', '..', 'elsewhere'), on)).toBe(false);
  expect(sealed(path.join(testsRoot, 'sub', '..', '..', '..', 'outside'), on)).toBe(false);
  expect(sealed(path.resolve(os.tmpdir(), 'kff-root-copy', '.kff', 'agent-process-tests', 'agent-1'), on)).toBe(false);
  expect(sealed(path.resolve(os.tmpdir(), 'somewhere-else', '.kff', 'agent-process-tests', 'agent-1'), on)).toBe(false);
  // Without KFF_ROOT the root falls back to the working directory, which is not this temp tree.
  expect(sealed(path.join(testsRoot, 'agent-1'), { NODE_ENV: 'test', KFF_TEST_GUARDIAN_DIES_BEFORE_READY: 'true' })).toBe(false);
});

// The pure checks above pin the predicate. These two drive the switch through `runGuardian` against a
// real child, so the boundary is shown to be load-bearing rather than merely parsed.
const roots: string[] = [];
function processRoot(name: 'agent-process-tests' | 'agent-process-tests-production') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b01-injection-'));
  roots.push(root);
  const runtime = path.join(root, '.kff', name, 'agent-1');
  mkdirSync(runtime, { recursive: true });
  return { root, runtime };
}
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b01-injection-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
async function withEnvironment<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await body(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
/** The stored hash disagrees with the snapshot, so a child that is allowed to reach `start` still ends in a real, normal closure. */
const closureCommand = (): AgentCommand => ({ ...fixtureCommand(), snapshot_hash: 'a'.repeat(64) });
const identity = (command: AgentCommand, nonce: string) => ({ command_id: command.id, action_id: command.action_id, guardian_nonce: nonce });

it('really kills a child that sits inside the tests root, so the startup-failure path is entered end to end', async () => {
  const { root, runtime } = processRoot('agent-process-tests');
  const command = closureCommand(); const nonce = randomBytes(32).toString('hex');
  let pid: number | undefined;
  await withEnvironment({ NODE_ENV: 'test', KFF_TEST_GUARDIAN_DIES_BEFORE_READY: 'true', KFF_ROOT: root }, async () => {
    await expect(runGuardian(command, runtime, nonce, { beforeSubmit: async () => {}, signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; } }))
      .rejects.toMatchObject({ code: 'GUARDIAN_STARTUP_FAILED' });
  });
  // `start` is what reaches the executor, so never having been sent is the evidence the record rests on.
  expect(pid).toBeUndefined();
  expect(readClosureEvidence(runtime, identity(command, nonce))).toMatchObject({ protocol_version: startupFailedProtocolVersion, context_opened: false, result: { outcome: 'CANCELED', error_code: 'GUARDIAN_STARTUP_FAILED' } });
}, 60000);

it('leaves the sibling directory sealed under the very same root: the child starts and proves a closed context', async () => {
  const { root, runtime } = processRoot('agent-process-tests-production');
  const command = closureCommand(); const nonce = randomBytes(32).toString('hex');
  let pid: number | undefined;
  const closure = await withEnvironment({ NODE_ENV: 'test', KFF_TEST_GUARDIAN_DIES_BEFORE_READY: 'true', KFF_ROOT: root }, () =>
    runGuardian(command, runtime, nonce, { beforeSubmit: async () => {}, signal: new AbortController().signal, onSpawn: spawned => { pid = spawned; } }));
  expect(pid).toBeGreaterThan(0);
  expect(closure.protocol_version).toBe('kff.guardian-closure.v1');
  expect(readClosureEvidence(runtime, identity(command, nonce))).toEqual(closure);
}, 60000);
