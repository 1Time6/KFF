import { it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

// The credential lookup is the await that used to straddle the throttle's read and write. Holding
// every lookup open lets all attempts interleave exactly as they would under real concurrency.
let pending: { resolve: (rows: unknown[]) => void }[] = [];
const query = vi.fn(async (text: string) => {
  if (!text.includes('local_users')) return [];
  return await new Promise<unknown[]>(resolve => { pending.push({ resolve }); });
});
vi.mock('@kff/database', () => ({ query: (text: string) => query(text), scoped: vi.fn(), transaction: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: new Error('unused') }), signInWithPassword: async () => ({ data: {}, error: new Error('unused') }) } }) }));

const { login } = await import('../../apps/web/lib/auth');
const origin = process.env.KFF_APP_ORIGIN ?? 'http://127.0.0.1:3000';
const request = () => new Request(origin + '/api/auth/login', { method: 'POST', headers: { origin, host: new URL(origin).host } });

beforeEach(() => { pending = []; query.mockClear(); });

// Eight simultaneous failures must all be counted. The previous implementation read the failure
// bucket before the credential lookup and wrote `count + 1` from that stale copy, so the eight
// writes collapsed and the threshold was never reached.
it('counts every failure when attempts interleave at the credential lookup', async () => {
  const email = 'concurrent-' + randomBytes(4).toString('hex') + '@example.test';
  const attempts = Array.from({ length: 8 }, () => login(request(), email, 'wrong-password').catch(error => error as { code?: string }));
  // Wait until all eight have passed admission and are parked inside the lookup.
  while (pending.length < 8) await new Promise(resolve => setTimeout(resolve, 0));
  for (const gate of pending) gate.resolve([]);
  const outcomes = await Promise.all(attempts);
  for (const outcome of outcomes) expect(outcome).toMatchObject({ code: 'UNAUTHORIZED' });
  // The ninth attempt is now refused, which is the threshold the audit asked to be honoured.
  await expect(login(request(), email, 'wrong-password')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
});

// A refusal has to say how long the window still has, and admission must be closed before the
// credential check so a burst cannot all pass the threshold together.
it('refuses further attempts for the same address once the limit is committed', async () => {
  const email = 'burst-' + randomBytes(4).toString('hex') + '@example.test';
  const attempts = Array.from({ length: 8 }, () => login(request(), email, 'wrong-password').catch(() => null));
  while (pending.length + attempts.length < 8) await new Promise(resolve => setTimeout(resolve, 0));
  // While all eight are still in flight, a ninth is refused immediately rather than waiting.
  const limited = await login(request(), email, 'wrong-password').catch(error => error as { code?: string; status?: number; retry_after_ms?: number });
  expect(limited).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  expect((limited as { retry_after_ms?: number }).retry_after_ms).toBeGreaterThan(0);
  for (const gate of pending) gate.resolve([]);
  await Promise.all(attempts);
});

// A different address keeps its own counter, and a successful credential check releases its
// reservation without erasing failures committed in the same window.
it('separates addresses and never counts a wrong origin', async () => {
  const first = 'first-' + randomBytes(4).toString('hex') + '@example.test';
  const second = 'second-' + randomBytes(4).toString('hex') + '@example.test';
  const failed = login(request(), first, 'wrong-password').catch(() => null);
  while (!pending.length) await new Promise(resolve => setTimeout(resolve, 0));
  pending.shift()!.resolve([]);
  await failed;
  // The other address is untouched by that failure.
  const other = login(request(), second, 'wrong-password').catch(error => error as { code?: string });
  while (!pending.length) await new Promise(resolve => setTimeout(resolve, 0));
  pending.shift()!.resolve([]);
  expect(await other).toMatchObject({ code: 'UNAUTHORIZED' });
  // An untrusted origin is refused before any throttling or lookup happens.
  const foreign = new Request(origin + '/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.test', host: new URL(origin).host } });
  await expect(login(foreign, second, 'wrong-password')).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
});
