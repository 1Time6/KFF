/**
 * Local application-side login throttling.
 *
 * The previous implementation read a bucket before the authentication `await` and then wrote
 * `bucket.count + 1` from that stale copy. Concurrent failures for one address therefore all wrote
 * the same value, so eight simultaneous attempts could be recorded as one and the threshold was
 * never reached. The bucket is now always re-read when the outcome is known, and an attempt is
 * reserved before the credential check so admission counts attempts rather than only final
 * outcomes.
 *
 * This is the local, single-process guard; it is deliberately not a distributed limiter. The
 * Supabase path keeps its own protection, and the origin, loopback, password-hash and session
 * revocation rules are unchanged.
 */
export const LOGIN_FAILURE_LIMIT = 8;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60000;
/** Bound the map so it cannot grow without limit in a long-lived process. */
export const LOGIN_THROTTLE_CAPACITY = 10000;

interface Bucket { count: number; expires: number; inFlight: number }
export interface LoginThrottleOptions { limit?: number; windowMs?: number; capacity?: number; now?: () => number }

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  constructor(options: LoginThrottleOptions = {}) {
    this.limit = options.limit ?? LOGIN_FAILURE_LIMIT;
    this.windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_MS;
    this.capacity = options.capacity ?? LOGIN_THROTTLE_CAPACITY;
    this.now = options.now ?? Date.now;
  }
  /** The bucket for this key, dropped once its window has passed. */
  private read(key: string): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) return undefined;
    if (bucket.expires <= this.now()) { this.buckets.delete(key); return undefined; }
    return bucket;
  }
  private write(key: string, bucket: Bucket) {
    // Refresh insertion order so the oldest entry is evicted first.
    this.buckets.delete(key);
    while (this.buckets.size >= this.capacity) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(key, bucket);
  }
  /**
   * Reserve one attempt. Returns null when the caller may proceed, or the number of milliseconds
   * to wait when the window is already exhausted. Reserved attempts count towards the limit, so
   * requests that are still in flight cannot all slip past the threshold together.
   */
  reserve(key: string): { allowed: true } | { allowed: false; retry_after_ms: number } {
    const bucket = this.read(key);
    if (!bucket) { this.write(key, { count: 0, expires: this.now() + this.windowMs, inFlight: 1 }); return { allowed: true }; }
    const committed = bucket.count + bucket.inFlight;
    if (committed >= this.limit) return { allowed: false, retry_after_ms: Math.max(1, bucket.expires - this.now()) };
    this.write(key, { ...bucket, inFlight: bucket.inFlight + 1 });
    return { allowed: true };
  }
  /**
   * Record a failed attempt for a reservation. The bucket is re-read here rather than reused from
   * the reserve call, so failures that resolve while others are in flight are all counted.
   */
  fail(key: string) {
    const bucket = this.read(key);
    if (!bucket) { this.write(key, { count: 1, expires: this.now() + this.windowMs, inFlight: 0 }); return 1; }
    const count = bucket.count + 1;
    this.write(key, { count, expires: bucket.expires, inFlight: Math.max(0, bucket.inFlight - 1) });
    return count;
  }
  /**
   * Release a reservation after a successful credential check. A success clears the address only
   * when nothing else is pending and no failure is committed in this window: clearing committed
   * failures here would let a later success erase the count the threshold depends on.
   */
  succeed(key: string) {
    const bucket = this.read(key);
    if (!bucket) return;
    if (bucket.inFlight > 1) { this.write(key, { ...bucket, inFlight: bucket.inFlight - 1 }); return; }
    if (bucket.count > 0) { this.write(key, { ...bucket, inFlight: 0 }); return; }
    this.buckets.delete(key);
  }
  /** Counters, for diagnostics and tests. */
  inspect(key: string) {
    const bucket = this.read(key);
    return bucket ? { count: bucket.count, inFlight: bucket.inFlight, expires: bucket.expires } : undefined;
  }
  get size() { return this.buckets.size; }
}
