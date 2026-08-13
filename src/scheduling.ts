// Small timing primitives shared by the activation wiring and the tree panels.
//
// Both exist for the same measured reason: ClaudeGate's coarse triggers fire far
// more often than the work behind them is worth doing. Window focus fires on
// every alt-tab; a session change fires twice per accept (once from persist(),
// once from the fs.watch reload it causes). Left unthrottled, that drove a
// thousands-of-syscalls worktree scan per focus and a storm of full-tree
// refreshes that raced inside VS Code's async tree.

/**
 * Rate-limit a coarse trigger: the returned function reports whether the caller
 * may run *now*, stamping the clock when it says yes.
 *
 * The first call always runs — a throttle should never delay the very first
 * sweep after activation.
 */
export function createThrottle(
  intervalMs: number,
  now: () => number = Date.now
): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    return true;
  };
}

export interface Coalescer {
  /** Request a run. A burst within `delayMs` collapses into a single run. */
  schedule(): void;
  /** Cancel any pending run (call from dispose paths). */
  dispose(): void;
}

/**
 * Collapse a burst of triggers into one deferred run.
 *
 * Unlike a debounce this does NOT extend the deadline on every call: the first
 * schedule() starts the timer and later ones ride it, so a continuous stream of
 * events still runs at a steady cadence instead of being starved forever.
 *
 * `fn` is invoked inside a try/catch. A refresh callback that throws must not
 * leave the timer handle set, or the panel would never refresh again.
 */
export function createCoalescer(delayMs: number, fn: () => void): Coalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(): void {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          fn();
        } catch {
          /* a failed refresh must not wedge every future one */
        }
      }, delayMs);
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
