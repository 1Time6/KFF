/**
 * Ordering guard for polling requests.
 *
 * Two races have to be closed, and they are different problems:
 *  - a slow response arriving after a newer one must not overwrite it;
 *  - a request that is still running when the next poll fires should not be re-issued, or a slow
 *    endpoint accumulates requests.
 * The existing collection workbench used an `active` flag plus an `inFlight` boolean. Cleanup only
 * stops future work: a request already sent still resolves, and `active` cannot tell "this poll is
 * current" from "a newer poll already landed". This guard carries a generation, so a response is
 * accepted only when it belongs to the newest issued request, and cancel() retires everything that
 * is in flight when the watched subject changes or the component unmounts.
 *
 * The server keeps its own version and snapshot checks; this only stops the page from displaying a
 * result it no longer asked for.
 */
export function createRequestGuard() {
  let generation = 0;
  let inFlight = false;
  let cancelled = false;
  return {
    /**
     * Start a request. Returns null when one is already running (the caller should skip this poll)
     * or when the guard has been cancelled. The returned ticket must be passed to `settle`.
     */
    begin(): { generation: number } | null {
      if (cancelled || inFlight) return null;
      inFlight = true;
      return { generation: ++generation };
    },
    /**
     * Claim the result of a request started by `begin`. True only when this ticket is still the
     * newest issued request and the guard was not cancelled meanwhile, so a late response from a
     * previous subject can never be applied.
     */
    settle(ticket: { generation: number }): boolean {
      inFlight = false;
      return !cancelled && ticket.generation === generation;
    },
    /** Report a failed request so the next poll may run. A failure carries no result to apply. */
    fail(): void { inFlight = false; },
    /** Retire everything in flight: the watched subject changed or the component is going away. */
    cancel(): void { cancelled = true; inFlight = false; },
    get cancelled() { return cancelled; },
    get inFlight() { return inFlight; },
  };
}

/**
 * Whether a polling request should be issued, and whether its result may be applied. Kept separate
 * from the guard so the decision is testable without timers or a React tree.
 */
export function acceptResponse(ticket: { generation: number } | null, currentGeneration: number, cancelled: boolean): boolean {
  if (!ticket || cancelled) return false;
  return ticket.generation === currentGeneration;
}
