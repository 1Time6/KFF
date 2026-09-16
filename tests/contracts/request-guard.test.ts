import { it, expect } from 'vitest';
import { acceptResponse, createRequestGuard } from '../../apps/web/components/request-guard';

// The audit case: the first request is slower than the second. The late result must not win.
it('ignores a slow response once a newer request has been issued', async () => {
  const guard = createRequestGuard();
  const slow = guard.begin();
  expect(slow).not.toBeNull();
  // The first request is still running, so a second poll must not be issued on top of it.
  expect(guard.begin()).toBeNull();
  // Once it settles, the next poll is allowed and becomes the current generation.
  expect(guard.settle(slow!)).toBe(true);
  const fast = guard.begin();
  expect(guard.settle(fast!)).toBe(true);
  // A response from the earlier ticket arriving now must be refused.
  expect(acceptResponse(slow, fast!.generation, false)).toBe(false);
});

// Switching subject (another run) retires whatever is in flight, so the old subject's late reply
// cannot overwrite the new one, and nothing is written back after the view closes.
it('refuses every late response after the subject changed', () => {
  const guard = createRequestGuard();
  const first = guard.begin();
  // The operator switches to another run: the in-flight request for the first one is retired.
  guard.cancel();
  expect(guard.settle(first!)).toBe(false);
  expect(acceptResponse(first, first!.generation, guard.cancelled)).toBe(false);
  // A cancelled guard issues nothing further, which is what "closed the detail" has to mean.
  expect(guard.begin()).toBeNull();
});

// A failed poll must not wedge the guard: the next tick has to be allowed to try again.
it('allows the next poll after a failure', () => {
  const guard = createRequestGuard();
  const ticket = guard.begin();
  guard.fail();
  expect(guard.inFlight).toBe(false);
  expect(guard.begin()).not.toBeNull();
  // The failed ticket still cannot be applied: it never carried a result.
  expect(acceptResponse(ticket, ticket!.generation, false)).toBe(true);
  expect(acceptResponse(null, 1, false)).toBe(false);
});

// Only the newest generation is applicable, whatever order the responses arrive in.
it('applies only the newest generation', () => {
  const guard = createRequestGuard();
  const first = guard.begin()!;
  expect(guard.settle(first)).toBe(true);
  const second = guard.begin()!;
  expect(guard.settle(second)).toBe(true);
  const third = guard.begin()!;
  expect(acceptResponse(third, third.generation, false)).toBe(true);
  expect(acceptResponse(second, third.generation, false)).toBe(false);
  expect(acceptResponse(first, third.generation, false)).toBe(false);
  expect(guard.settle(third)).toBe(true);
});

// A guard that was cancelled never accepts anything, even from its own newest generation.
it('never accepts a response after cancellation', () => {
  const guard = createRequestGuard();
  const ticket = guard.begin()!;
  guard.cancel();
  expect(acceptResponse(ticket, ticket.generation, guard.cancelled)).toBe(false);
  expect(guard.settle(ticket)).toBe(false);
});
