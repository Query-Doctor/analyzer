import { log } from "../log.ts";

const TICK_MS = 1_000;
const DEFAULT_THRESHOLD_MS = 5_000;

/**
 * Warns when the event loop stops turning.
 *
 * The relay's pong is answered by the transport, on this same loop, and the
 * server reaps any client that misses one 30-second heartbeat. So a stall here
 * is indistinguishable — from the server's side — from a process that has died,
 * and it is the difference between a connection that lasts and one that is
 * terminated every minute. Nothing else in the analyzer's logs shows it: the
 * connection simply reports itself broken, with no hint that this process was
 * the one that went quiet.
 *
 * Cheap by construction: one timer, one subtraction per second, and it never
 * holds the process open.
 */
export function watchEventLoopLag(
  thresholdMs: number = DEFAULT_THRESHOLD_MS,
): () => void {
  let previousTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // Anything beyond the interval itself is time the loop owed this timer and
    // could not pay, which is time it could not have answered a ping in either.
    const lag = now - previousTick - TICK_MS;
    previousTick = now;
    if (lag >= thresholdMs) {
      log.warn(
        `Event loop stalled for ${(lag / 1000).toFixed(1)}s — the relay could not answer a heartbeat while it was blocked`,
        "event-loop",
      );
    }
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
