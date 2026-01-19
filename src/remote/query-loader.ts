import { EventEmitter } from "node:events";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { RecentQuery } from "../sql/recent-query.ts";

export type QueryLoaderEvents = {
  poll: [RecentQuery[]];
  pollError: [unknown];
  exit: [];
};

export class QueryLoader extends EventEmitter<QueryLoaderEvents> {
  private consecutiveErrors = 0;
  private stopped = false;
  private readonly interval: number;
  private readonly maxErrors: number;

  constructor(
    private readonly sourceManager: ConnectionManager,
    private readonly connectable: Connectable,
    options?: { maxErrors?: number; interval?: number },
  ) {
    super();
    this.maxErrors = options?.maxErrors ?? 3;
    this.interval = options?.interval ?? 10_000;
  }

  /**
   * Poll pg_stat_statements a single time
   * @returns whether the query loader exited. This information is also emitted
   */
  async poll(): Promise<boolean> {
    try {
      await this.runPoll();
      this.consecutiveErrors = 0;
    } catch (error) {
      if (error instanceof Error) {
        this.emit("pollError", error);
      }
      this.consecutiveErrors++;
    }
    if (this.consecutiveErrors > this.maxErrors) {
      this.emit("exit");
      return false;
    }
    return true;
  }

  start() {
    this.scheduleNextPoll();
  }

  /**
   * Schedules the loader to stop. Any in-flight requests
   * will attempt to complete
   */
  stop() {
    this.stopped = true;
  }

  private scheduleNextPoll() {
    if (this.stopped) {
      return;
    }

    setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.poll().then((ok) => {
        if (ok) {
          this.scheduleNextPoll();
        }
      }, (error) => {
        console.error(error);
        // we don't expect an error here. Better signal our exit
        this.emit("exit");
      });
    }, this.interval);
  }

  private async runPoll() {
    const connector = this.sourceManager.getConnectorFor(this.connectable);
    const queries = await connector.getRecentQueries();
    this.emit("poll", queries);
  }
}
