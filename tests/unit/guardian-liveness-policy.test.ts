import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { assertGuardianLivenessConfiguration, guardianLivenessPolicy } from '../../apps/agent/src/guardian';
import { guardianTimingLimits } from '../../packages/contracts/src/index';

/**
 * The budgets decide how long the Agent waits before it concludes that a run is not coming back, so a
 * value outside the accepted range is a safety configuration error rather than a preference. Everything
 * below goes through the production validation: the same function the Agent calls at startup, and the
 * same one a run calls when it builds its watchdog. The last two cases boot the real Agent process, so
 * "fails fast at startup" is a fact about the program rather than about a function that a caller might
 * forget to call.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kff-b012-policy-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
function isolatedRoot(label: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kff-b012-policy-' + label + '-')); roots.push(root);
  return root;
}
const refusal = (body: () => unknown) => { try { body(); return null; } catch (error) { return error as Error & { code?: string }; } };
const { min_ms: minimum, max_ms: maximum, max_total_ms: ceiling, test_min_ms: testMinimum } = guardianTimingLimits;

it('keeps every default budget inside the range the same policy enforces', () => {
  const defaults = assertGuardianLivenessConfiguration({});
  for (const [phase, value] of Object.entries(defaults)) {
    expect(Number.isSafeInteger(value), phase).toBe(true);
    expect(value, phase).toBeGreaterThanOrEqual(minimum);
    expect(value, phase).toBeLessThanOrEqual(maximum);
  }
  expect(Object.values(defaults).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(ceiling);
  // The three bounds are one shape, and the order between them is what makes the ranges meaningful.
  expect(minimum).toBeLessThanOrEqual(maximum);
  expect(maximum).toBeLessThanOrEqual(ceiling);
  expect(testMinimum).toBeLessThan(minimum);
});

/**
 * Both ends of the range, and the fact that there are two ends to respect: a phase may be given the
 * largest single value the range allows only while the sum of every budget stays inside the ceiling the
 * evidence schema records. The binding constraint is the sum, and equality with it is still legal - a
 * configuration one millisecond above it is not.
 */
it('accepts the boundaries of the range and refuses one step beyond each of them', () => {
  expect(guardianLivenessPolicy({ 'awaiting-ready': minimum }, {})['awaiting-ready']).toBe(minimum);
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': minimum - 1 }, {}))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': maximum + 1 }, {}))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  // The largest single value is refused by the sum rule rather than by the per-key range: both are real
  // bounds, and the run has to satisfy both.
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': maximum }, {}))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  const defaults = assertGuardianLivenessConfiguration({});
  const others = Object.entries(defaults).filter(([phase]) => phase !== 'awaiting-ready').reduce((sum, [, value]) => sum + value, 0);
  const exact = ceiling - others;
  expect(exact).toBeGreaterThan(minimum);
  expect(guardianLivenessPolicy({ 'awaiting-ready': exact }, {})['awaiting-ready']).toBe(exact);
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': exact + 1 }, {}))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  // Values that are not whole milliseconds are refused rather than rounded into something the run then
  // waits for: a fractional, a string, an empty string, zero and a negative all describe no valid wait.
  for (const value of [1.5, 1500.5, 'abc', '', ' ', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(refusal(() => guardianLivenessPolicy({ granting: value as unknown as number }, {})), JSON.stringify(value)).not.toBeNull();
  }
  // A numeric string is accepted, because an environment variable can only ever be a string.
  expect(guardianLivenessPolicy({ granting: '2500' as unknown as number }, {}).granting).toBe(2500);
});

it('refuses an illegal budget from the environment and names the variable that carried it', () => {
  const illegal = refusal(() => guardianLivenessPolicy({}, { KFF_GUARDIAN_GRACE_MS: 'abc' }));
  expect(illegal?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  expect(illegal?.message).toContain('KFF_GUARDIAN_GRACE_MS');
  expect(refusal(() => guardianLivenessPolicy({}, { KFF_GUARDIAN_GRACE_MS: String(minimum - 1) }))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  expect(refusal(() => guardianLivenessPolicy({}, { KFF_GUARDIAN_AWAITING_INTENT_MS: String(maximum + 1) }))?.code).toBe('GUARDIAN_LIVENESS_INVALID');
  expect(guardianLivenessPolicy({}, { KFF_GUARDIAN_GRACE_MS: '15000' }).grace).toBe(15000);
  // An explicit override wins over the environment, which is what lets a caller pin a phase budget for
  // one run without touching the deployment's configuration.
  expect(guardianLivenessPolicy({ grace: 200 }, { KFF_GUARDIAN_GRACE_MS: '300' }).grace).toBe(200);
  expect(refusal(() => assertGuardianLivenessConfiguration({ KFF_GUARDIAN_AWAITING_READY_MS: String(minimum - 1) }))?.message).toContain('KFF_GUARDIAN_AWAITING_READY_MS');
});

/**
 * The test override exists so the regressions can use budgets far below anything a production run may
 * accept, and it is sealed the same way the fault injection is: test mode *and* a runtime directory
 * inside `<KFF_ROOT>/.kff/agent-process-tests/`. Either condition alone is not enough, and the check is
 * a path comparison rather than a substring test, so a sibling directory cannot satisfy it.
 */
it('allows a sub-millisecond budget only inside the sealed test root', () => {
  const root = isolatedRoot('sealed');
  const inside = path.join(root, '.kff', 'agent-process-tests', 'phase');
  const sibling = path.join(root, '.kff', 'agent-process-tests-prod', 'phase');
  const sealed = { NODE_ENV: 'test', KFF_ROOT: root };
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': testMinimum }, {}))).not.toBeNull();
  expect(guardianLivenessPolicy({ 'awaiting-ready': testMinimum }, sealed, { runtime: inside })['awaiting-ready']).toBe(testMinimum);
  // Test mode with a runtime outside the sealed root, and the sealed root without test mode, are both
  // refused: the seal is the pair, not either half.
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': testMinimum }, sealed, { runtime: sibling }))).not.toBeNull();
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': testMinimum }, sealed, { runtime: root }))).not.toBeNull();
  expect(refusal(() => guardianLivenessPolicy({ 'awaiting-ready': testMinimum }, { NODE_ENV: 'production', KFF_ROOT: root }, { runtime: inside }))).not.toBeNull();
  // And the production range still applies to every other value inside the sealed root: the seal lowers
  // the floor, it does not remove it.
  expect(refusal(() => guardianLivenessPolicy({ granting: testMinimum - 1 }, sealed, { runtime: inside }))).not.toBeNull();
});

const agentSource = fileURLToPath(new URL('../../apps/agent/src/main.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
/** A complete pairing file, so the only thing that can refuse this Agent is the budget it was given. */
function bootAgent(overrides: Record<string, string>) {
  const root = isolatedRoot('boot');
  const home = path.join(root, 'home'); mkdirSync(path.join(home, '.kff'), { recursive: true });
  writeFileSync(path.join(home, '.kff', 'agent-config.json'), JSON.stringify({
    agent_id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222',
    brand_id: '33333333-3333-4333-8333-333333333333', token: 'f'.repeat(64), controller_origin: 'http://127.0.0.1:9',
  }), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', agentSource], {
    cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KFF_ROOT: home, NODE_ENV: 'production', ...overrides },
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  return { home, child, output: () => output, journalDir: path.join(home, '.kff', 'agent') };
}
function waitForExit(child: ChildProcess, ms: number) {
  return new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, ms); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
}

/**
 * A budget that is illegal has to stop the Agent before it does anything else, because the value decides
 * how long a real execution may run unattended. The observable is the whole boot: a non-zero exit, the
 * refusal named in the log, and no execution directory at all - which is what proves the refusal came
 * before the lock was taken, and so before a second Agent could be told the project is busy.
 */
it('refuses to start the Agent at all when a production budget is illegal', async () => {
  const booted = bootAgent({ KFF_GUARDIAN_GRACE_MS: 'abc' });
  try {
    const code = await waitForExit(booted.child, 90000);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(booted.output()).toContain('GUARDIAN_LIVENESS_INVALID');
    expect(booted.output()).toContain('KFF_GUARDIAN_GRACE_MS');
    expect(booted.output()).not.toContain('KFF Agent started');
    expect(() => readFileSync(path.join(booted.journalDir, 'process.lock'), 'utf8')).toThrow();
  } finally { booted.child.kill('SIGKILL'); }
}, 120000);

/** The control for the case above: with legal budgets the same file boots, so the refusal is the budget. */
it('starts the Agent on the same pairing file once the budgets are legal', async () => {
  const booted = bootAgent({});
  try {
    await expect.poll(() => booted.output().includes('KFF Agent started with persistent journal and one execution slot'), { timeout: 60000, interval: 200 }).toBe(true);
    // Past the assertion, the Agent took its lock: the run reached the point the illegal case never did.
    expect(booted.child.exitCode).toBeNull();
    expect(readFileSync(path.join(booted.journalDir, 'process.lock'), 'utf8')).toBe(String(booted.child.pid));
    expect(booted.output()).not.toContain('GUARDIAN_LIVENESS_INVALID');
  } finally { booted.child.kill('SIGKILL'); }
  await waitForExit(booted.child, 20000);
}, 120000);
