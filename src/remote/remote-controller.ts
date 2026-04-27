import { WebSocket } from "ws";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";
import { Remote } from "./remote.ts";
import * as errors from "../sync/errors.ts";
import type { OptimizedQuery } from "../sql/recent-query.ts";
import {
  CreateIndexDto,
  ToggleIndexDto,
} from "./remote-controller.dto.ts";
import { ZodError } from "zod";
import { CombinedExport, ExportedStats, Statistics } from "@query-doctor/core";
import { type Connectable } from "../sync/connectable.ts";
import { connectToSource } from "../sql/postgresjs.ts";

async function resolveDockerHost(db: Connectable): Promise<Connectable> {
  if (!db.isLocalhost()) {
    return db;
  }
  const dockerDb = db.escapeDocker();
  if (dockerDb.url.hostname === db.url.hostname) {
    return db;
  }
  const pg = connectToSource(dockerDb);
  try {
    await pg.exec("SELECT 1");
    log.info(`Resolved localhost to ${dockerDb.url.hostname} for docker escape`, "remote-controller");
    return dockerDb;
  } catch {
    log.info(`${dockerDb.url.hostname} unreachable, falling back to ${db.url.hostname}`, "remote-controller");
    return db;
  } finally {
    // @ts-expect-error | close is added in wrapPgPool
    await pg.close();
  }
}

const SyncStatus = {
  NOT_STARTED: "notStarted",
  IN_PROGRESS: "inProgress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

type SyncStatus = typeof SyncStatus[keyof typeof SyncStatus];

type HandlerResult = {
  status: number;
  // TODO: type body per route (Site#2402)
  body: unknown;
};

export class RemoteController {
  /**
   * Only a single socket can be active at the same time.
   * Multi-tab support not currently available
   */
  private socket?: WebSocket;
  private syncResponse?: Awaited<ReturnType<Remote["syncFrom"]>>;
  private syncStatus: SyncStatus = SyncStatus.NOT_STARTED;
  private lastSourceDb?: Connectable;

  constructor(
    private readonly remote: Remote,
  ) {
    this.hookUpWebsockets(remote);
  }

  sendSyncLog = this.makeLoggingHandler("sync").bind(this)

  private hookUpWebsockets(remote: Remote) {
    const onQueryProcessed = this.eventOnQueryProcessed.bind(this);
    const onError = this.eventError.bind(this);
    remote.optimizer.on("noImprovements", onQueryProcessed);
    remote.optimizer.on("improvementsAvailable", onQueryProcessed);
    remote.optimizer.on("error", onError);
    remote.optimizer.on("timeout", onQueryProcessed);
    remote.optimizer.on("zeroCostPlan", onQueryProcessed);
    remote.on("dumpLog", this.makeLoggingHandler("pg_dump").bind(this));
    remote.on("restoreLog", this.makeLoggingHandler("pg_restore").bind(this));
  }

  // TODO: type body param (Site#2402)
  async toggleIndex(body: unknown): Promise<HandlerResult> {
    try {
      const index = ToggleIndexDto.parse(body);
      const isDisabled = this.remote.optimizer.toggleIndex(index.indexName);
      return { status: 200, body: { isDisabled } };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          status: 400,
          body: {
            type: "error",
            error: "invalid_body",
            message: error.message,
          },
        };
      }
      return {
        status: 500,
        body: {
          type: "error",
          error: env.HOSTED ? "Internal Server Error" : error,
          message: "Failed to sync database",
        },
      };
    }
  }

  // TODO: type return (Site#2402)
  async getStatus(): Promise<unknown> {
    if (!this.syncResponse) {
      return { status: this.syncStatus };
    }
    const { schema: initialSchema, meta } = this.syncResponse;
    const { queries, diffs, disabledIndexes, pgStatStatementsNotInstalled } =
      await this.remote.getStatus();

    // After the poll above, SchemaLoader has the latest schema from the
    // source DB. Use it instead of the potentially stale initial sync
    // schema, so newly created tables are reflected immediately.
    const latestSchema = this.remote.getLatestSchema();
    const schema = latestSchema
      ? { type: "ok" as const, value: latestSchema }
      : initialSchema;

    let deltas: DeltasResult;
    if (diffs.status === "fulfilled") {
      deltas = { type: "ok", value: diffs.value };
    } else {
      deltas = { type: "error", value: String(diffs.reason) };
    }
    return {
      status: this.syncStatus,
      meta,
      schema,
      queries: pgStatStatementsNotInstalled
        ? this.pgStatStatementsNotInstalledError()
        : { type: "ok", value: queries },
      disabledIndexes: { type: "ok", value: disabledIndexes },
      deltas,
      statisticsMode: this.remote.optimizer.statisticsMode,
      computedStats: this.remote.optimizer.computedStats,
    };
  }

  private pgStatStatementsNotInstalledError() {
    return {
      type: "error",
      error: "extension_not_installed",
      extensionName: "pg_stat_statements",
    } as const;
  }

  async onFullSync(db: Connectable): Promise<HandlerResult> {
    let resolvedDb: Connectable;
    try {
      this.sendSyncLog("Reaching out to database...");
      resolvedDb = await resolveDockerHost(db);
      this.lastSourceDb = resolvedDb;
      this.sendSyncLog(`Connected to ${resolvedDb.toString()}`);
    } catch (error) {
      this.sendSyncLog(`Could not resolve the connection string to a working database`);
      throw error;
    }
    try {
      this.sendSyncLog("Starting sync");
      this.syncStatus = SyncStatus.IN_PROGRESS;
      this.syncResponse = await this.remote.syncFrom(resolvedDb, {
        type: "pullFromSource",
      }, {
        events: {
          onDatabaseInfo: (info) => {
            this.sendSyncLog(info)
          },
          onGetQueries: (count) => {
            this.sendSyncLog(`Found ${count} queries in the database.`)
          }
        }
      });
      this.syncStatus = SyncStatus.COMPLETED;
      this.sendSyncLog("Successfully synced!");
      const { schema, meta } = this.syncResponse;
      const { queries, pgStatStatementsNotInstalled } = await this.remote
        .getStatus();

      return {
        status: 200,
        body: {
          meta,
          schema,
          queries: pgStatStatementsNotInstalled
            ? this.pgStatStatementsNotInstalledError()
            : { type: "ok", value: queries },
          statisticsMode: this.remote.optimizer.statisticsMode,
          computedStats: this.remote.optimizer.computedStats,
        },
      };
    } catch (error) {
      this.syncStatus = SyncStatus.FAILED;
      this.sendSyncLog("Sync failed");
      console.error(error);
      return {
        status: 500,
        body: {
          type: "error",
          error: env.HOSTED ? "Internal Server Error" : error,
          message: "Failed to sync database",
        },
      };
    }
  }

  async redump(): Promise<HandlerResult> {
    if (!this.lastSourceDb) {
      return {
        status: 400,
        body: { type: "error", error: "no_source_db", message: "No source database has been synced yet" },
      };
    }
    return this.onFullSync(this.lastSourceDb);
  }

  async onImportStats(body: unknown): Promise<HandlerResult> {
    let stats: ExportedStats[];
    try {
      const combined = CombinedExport.safeParse(body);
      stats = combined.success
        ? combined.data.stats
        : ExportedStats.array().parse(body);
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          status: 400,
          body: { type: "error", error: "invalid_body", message: error.message },
        };
      }
      return {
        status: 400,
        body: { type: "error", error: "invalid_body", message: "body must be an array of ExportedStats or a CombinedExport object" },
      };
    }

    try {
      await this.remote.applyStatistics(
        Statistics.statsModeFromExport(stats),
      );
      if (this.syncResponse) {
        this.syncResponse.meta.inferredStatsStrategy = "imported";
      }
      return { status: 200, body: { success: true } };
    } catch (error) {
      console.error(error);
      return {
        status: 500,
        body: {
          type: "error",
          error: env.HOSTED ? "Internal Server Error" : error,
          message: "Failed to import stats",
        },
      };
    }
  }

  async onReset(rawBody: string): Promise<HandlerResult> {
    const body = RemoteSyncRequest.safeDecode(rawBody);
    if (!body.success) {
      return { status: 400, body: body.error };
    }

    try {
      await this.remote.resetPgStatStatements(body.data.db);
      return { status: 200, body: { success: true } };
    } catch (error) {
      console.error(error);
      if (error instanceof errors.PostgresError) {
        return { status: error.statusCode, body: error.toJSON() };
      }
      if (error instanceof errors.ExtensionNotInstalledError) {
        return { status: error.statusCode, body: error.toJSON() };
      }
      return {
        status: 500,
        body: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  async createIndex(body: unknown): Promise<HandlerResult> {
    try {
      const parsed = CreateIndexDto.parse(body);
      await this.remote.optimizer.createIndex(parsed.table, parsed.columns);
      return { status: 200, body: { success: true } };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          status: 400,
          body: {
            type: "error",
            error: "invalid_body",
            message: error.message,
          },
        };
      }
      console.error("Failed to create index:", error);
      return {
        status: 500,
        body: {
          error:
            error instanceof Error ? error.message : "Failed to create index",
        },
      };
    }
  }

  onWebsocketConnection(socket: WebSocket): void {
    this.socket = socket;
    log.debug("Websocket connection established", "remote-controller");

    socket.on("close", () => {
      log.debug("Websocket connection closed", "remote-controller");
    });
  }

  private makeLoggingHandler(process: "pg_restore" | "pg_dump" | (string & {})) {
    return (logLine: string) => {
      this.sendToSocket({
        type: "log",
        process,
        log: logLine,
      });
    };
  }

  private eventOnQueryProcessed(query: OptimizedQuery) {
    this.sendToSocket({
      type: "queryProcessed",
      query,
    });
  }

  private eventError(error: Error, query: OptimizedQuery) {
    console.error(error);
    this.eventOnQueryProcessed(query);
    this.sendToSocket({
      type: "error",
      query,
      error: error.message,
    });
  }

  private sendToSocket(data: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    } else if (env.DEBUG) {
      console.log("Failed to send data to websocket because it has state", this.socket?.readyState)
    }
  }
}

type DeltasResult = {
  type: "ok";
  // the type of this is not super important
  // currently the frontend only cares whether
  // or not this array is empty
  value: unknown[];
} | {
  type: "error";
  value: string;
};
