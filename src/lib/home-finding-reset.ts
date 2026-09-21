/**
 * A tiny cross-screen signal so a screen being popped back to Home (e.g.
 * Results, on back button or swipe-back) can ask Home to clear its own
 * Finding-state chrome BEFORE the pop reveals Home underneath — rather than
 * waiting for Home's own focus event, which only fires after the pop
 * transition has already started revealing Home's stale state.
 *
 * Home registers its reset function while mounted; callers don't need to
 * know anything about Home's internal state shape, just that calling this
 * is safe and idempotent.
 */
let resetHandler: (() => void) | null = null;

export function registerHomeFindingReset(handler: (() => void) | null): void {
  resetHandler = handler;
}

export function resetHomeFindingState(): void {
  resetHandler?.();
}
