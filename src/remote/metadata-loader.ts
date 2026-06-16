import type { EventEmitter } from "node:events";

/**
 * Events shared by every {@link MetadataLoader}. Loader-specific payload events
 * (e.g. the query loader's `poll`, the schema loader's `diff`) are layered on
 * top via the `Events` parameter.
 */
export type MetadataLoaderEvents = {
  /** A single poll failed. The loader keeps running until `maxErrors`. */
  pollError: [unknown];
  /** The loader stopped polling for good (too many consecutive errors). */
  exit: [];
};

/**
 * A source of remote metadata that we keep current by polling on a timer.
 * Both {@link QueryLoader} and {@link SchemaLoader} implement this so `Remote`
 * can drive them through one lifecycle regardless of what they track.
 */
export interface MetadataLoader<
  Events extends MetadataLoaderEvents & Record<keyof Events, unknown[]> =
    MetadataLoaderEvents,
> extends EventEmitter<Events> {
  /** Begin polling on the configured interval. */
  start(): void;
  /**
   * Stop polling. In-flight requests are allowed to complete; no further polls
   * are scheduled.
   */
  stop(): void;
}
