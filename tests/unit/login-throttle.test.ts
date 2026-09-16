import { it, expect } from 'vitest';
import { LOGIN_FAILURE_LIMIT, LOGIN_THROTTLE_CAPACITY, LoginThrottle } from '../../apps/web/lib/login-throttle';

// The failure the old code had: every failure read the bucket before the credential `await` and
// wrote `count + 1` from that stale copy, so concurrent failures collapsed into one.
it('counts every concurrent failure instead of collapsing them', async () => {
  const throttle = new LoginThrottle();
  const email = 'operator@example.test';
  // Eight attempts all read their bucket before any of them finishes, which is the interleaving
  // the old implementation got wrong. Each failure is committed only after the others have read.
  const gates: (() => void)[] = [];
  const attempts = Array.from({ length: LOGIN_FAILURE_LIMIT }, () => new Promise<void>(resolve => {
    gates.push(() => { throttle.fail(email); resolve(); });
  }));
  // Every attempt passed admission first, exactly like a burst of simultaneous requests.
  for (let index = 0; index < LOGIN_FAILURE_LIMIT; index++) expect(throttle.reserve(email)).toEqual({ allowed: true });
  for (const release of gates) release();
  await Promise.all(attempts);
  expect(throttle.inspect(email)?.count).toBe(LOGIN_FAILURE_LIMIT);
});

// Admitting requests is what the threshold has to bound, so an in-flight attempt is counted before
// it resolves; otherwise a burst larger than the limit all passes admission together.
// The pre-fix shape, kept here as the failing side of the comparison: each request captured the
// bucket before the credential await and wrote `count + 1` from that stale copy.
const previousRule = (() => {
  const buckets = new Map<string, { count: number; expires: number }>();
  return {
    read: (key: string) => buckets.get(key),
    admit: (key: string) => { const bucket = buckets.get(key); return !bucket || bucket.expires < Date.now() || bucket.count < LOGIN_FAILURE_LIMIT; },
    failFrom: (key: string, bucket: { count: number; expires: number } | undefined) => {
      buckets.set(key, { count: bucket && bucket.expires > Date.now() ? bucket.count + 1 : 1, expires: Date.now() + 900000 });
    },
    count: (key: string) => buckets.get(key)?.count ?? 0,
  };
})();

it('loses concurrent failures under the pre-fix read-then-write rule', () => {
  const email = 'stale@example.test';
  // One capture of the bucket, shared by all eight requests, exactly as the old closure did.
  const captured = previousRule.read(email);
  for (let index = 0; index < LOGIN_FAILURE_LIMIT; index++) previousRule.failFrom(email, captured);
  // Eight failures are recorded as one, so the threshold is never reached.
  expect(previousRule.count(email)).toBe(1);
  expect(previousRule.admit(email)).toBe(true);
  // The current rule records all eight and closes admission.
  const throttle = new LoginThrottle();
  for (let index = 0; index < LOGIN_FAILURE_LIMIT; index++) { throttle.reserve(email); throttle.fail(email); }
  expect(throttle.inspect(email)?.count).toBe(LOGIN_FAILURE_LIMIT);
  expect(throttle.reserve(email).allowed).toBe(false);
});

it('bounds admission by counting attempts that are still in flight', () => {
  const throttle = new LoginThrottle({ limit: 3, windowMs: 60000 });
  expect(throttle.reserve('a@example.test')).toEqual({ allowed: true });
  expect(throttle.reserve('a@example.test')).toEqual({ allowed: true });
  expect(throttle.reserve('a@example.test')).toEqual({ allowed: true });
  // The fourth simultaneous attempt is refused before any credential check runs.
  const refused = throttle.reserve('a@example.test');
  expect(refused.allowed).toBe(false);
  if (!refused.allowed) expect(refused.retry_after_ms).toBeGreaterThan(0);
  // Resolving two of them as failures moves them from reserved to committed and keeps the count.
  throttle.fail('a@example.test'); throttle.fail('a@example.test');
  expect(throttle.inspect('a@example.test')).toMatchObject({ count: 2, inFlight: 1 });
  // Two committed failures plus the attempt still in flight already reach the limit of three, so
  // admission stays closed for the rest of the window instead of reopening on every resolution.
  expect(throttle.reserve('a@example.test').allowed).toBe(false);
  // A success releases the remaining reservation, but the committed failures still bound admission.
  throttle.succeed('a@example.test');
  expect(throttle.inspect('a@example.test')).toMatchObject({ count: 2, inFlight: 0 });
  expect(throttle.reserve('a@example.test')).toEqual({ allowed: true });
  throttle.fail('a@example.test');
  expect(throttle.reserve('a@example.test').allowed).toBe(false);
});

it('keeps counters per address and clears only what a success may clear', () => {
  const throttle = new LoginThrottle({ limit: 2, windowMs: 60000 });
  throttle.reserve('a@example.test'); throttle.fail('a@example.test');
  throttle.reserve('b@example.test'); throttle.fail('b@example.test');
  expect(throttle.inspect('a@example.test')?.count).toBe(1);
  expect(throttle.inspect('b@example.test')?.count).toBe(1);
  // A success after a failure in the same window releases the reservation but does not erase the
  // committed failure, so a repeated attacker cannot clear the counter by guessing right once.
  throttle.reserve('a@example.test'); throttle.succeed('a@example.test');
  expect(throttle.inspect('a@example.test')).toMatchObject({ count: 1, inFlight: 0 });
  throttle.fail('a@example.test');
  expect(throttle.reserve('a@example.test').allowed).toBe(false);
  // An address with nothing recorded is dropped entirely on success.
  throttle.reserve('c@example.test'); throttle.succeed('c@example.test');
  expect(throttle.inspect('c@example.test')).toBeUndefined();
  // The other address keeps its own counter.
  expect(throttle.inspect('b@example.test')?.count).toBe(1);
});

it('expires a window and drops stale buckets', () => {
  let clock = 1_000_000;
  const throttle = new LoginThrottle({ limit: 2, windowMs: 60000, now: () => clock });
  throttle.reserve('a@example.test'); throttle.fail('a@example.test');
  throttle.reserve('a@example.test'); throttle.fail('a@example.test');
  expect(throttle.reserve('a@example.test').allowed).toBe(false);
  // Inside the window it stays blocked.
  clock += 59999;
  expect(throttle.reserve('a@example.test').allowed).toBe(false);
  // After the window the address is allowed again with a fresh counter.
  clock += 2;
  expect(throttle.reserve('a@example.test')).toEqual({ allowed: true });
  expect(throttle.inspect('a@example.test')?.count).toBe(0);
});

// A long-lived process must not accumulate one entry per address forever.
it('stays bounded under many distinct addresses', () => {
  const throttle = new LoginThrottle({ capacity: 64, windowMs: 60000 });
  for (let index = 0; index < 500; index++) {
    const key = 'user' + index + '@example.test';
    throttle.reserve(key); throttle.fail(key);
  }
  expect(throttle.size).toBeLessThanOrEqual(64);
  // The most recent address is still tracked; the oldest were evicted rather than the newest lost.
  expect(throttle.inspect('user499@example.test')?.count).toBe(1);
  expect(LOGIN_THROTTLE_CAPACITY).toBeGreaterThan(64);
});
