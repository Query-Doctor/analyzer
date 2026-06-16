import { EventEmitter } from "node:events";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { SchemaDiffer } from "../sync/schema_differ.ts";
import { dumpSchema, FullSchema } from "@query-doctor/core";
import { type Op } from "jsondiffpatch/formatters/jsonpatch";
import type { MetadataLoader, MetadataLoaderEvents } from "./metadata-loader.ts";

export type SchemaLoaderEvents = MetadataLoaderEvents & {
  diff: [diffs: Op[], schema: FullSchema];
};

export class SchemaLoader extends EventEmitter<SchemaLoaderEvents>
  implements MetadataLoader<SchemaLoaderEvents> {
  private consecutiveErrors = 0;
  private stopped = false;
  private readonly interval: number;
  private readonly maxErrors: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sourceManager: ConnectionManager,
    private readonly connectable: Connectable,
    options?: { maxErrors?: number; interval?: number },
  ) {
    super();
    this.maxErrors = options?.maxErrors ?? 3;
    this.interval = options?.interval ?? 60_000;
  }

  private readonly differ = new SchemaDiffer();
  private latestSchema?: FullSchema;

  getLatestSchema(): FullSchema | undefined {
    return this.latestSchema;
  }

  async poll() {
    const connector = this.sourceManager.getOrCreateConnection(this.connectable);
    const schema = await dumpSchema(connector);
    const diffs = this.update(schema) ?? [];
    return { diffs };
  }

  update(schema: FullSchema) {
    this.latestSchema = schema;
    return this.differ.put(this.connectable, schema);
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
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Dump the schema once, diff it against the last seen schema, and emit any
   * deltas. Mirrors {@link QueryLoader.poll} so the schema is tracked on the
   * same lifecycle as queries.
   * @returns whether the loader should keep polling. Also emitted via `exit`.
   */
  private async pollOnce(): Promise<boolean> {
    try {
      const { diffs } = await this.poll();
      this.consecutiveErrors = 0;
      if (diffs.length > 0 && this.latestSchema) {
        this.emit("diff", diffs, this.latestSchema);
      }
    } catch (error) {
      this.consecutiveErrors++;
      this.emit("pollError", error);
    }
    if (this.consecutiveErrors > this.maxErrors) {
      this.emit("exit");
      return false;
    }
    return true;
  }

  private scheduleNextPoll() {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) {
        return;
      }
      this.pollOnce().then((ok) => {
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
}
