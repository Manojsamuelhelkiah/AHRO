/**
 * Wrap a poller's tick so concurrent callers share one in-flight run.
 *
 * On an autoscale deployment the process may be frozen the moment the last
 * HTTP response completes. If a heartbeat request merely *skipped* when a
 * detached startup tick was still running, it would respond early and the
 * still-running poll could be frozen mid-flight — the exact failure the
 * heartbeat exists to prevent. So instead of skipping, a caller that finds
 * a tick already in flight AWAITS that tick before returning.
 *
 * The wrapped `run` must never reject (each poller catches its own errors
 * and records them in telemetry); if it somehow does, the rejection is
 * surfaced to every waiter.
 *
 * Returns true when this caller started the tick, false when it awaited a
 * tick started by someone else — either way, a completed tick has happened
 * by the time the promise resolves.
 */
export function makeSharedTick(run: () => Promise<void>): () => Promise<boolean> {
  let inFlight: Promise<void> | null = null;
  return async () => {
    if (inFlight) {
      await inFlight;
      return false;
    }
    inFlight = run().finally(() => {
      inFlight = null;
    });
    await inFlight;
    return true;
  };
}
