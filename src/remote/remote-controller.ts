import type { WebSocket } from "ws";
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

  constructor(
    private readonly remote: Remote,
  ) {
    this.hookUpWebsockets(remote);
  }

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
    if (!this.syncResponse || this.syncStatus !== SyncStatus.COMPLETED) {
      return { status: this.syncStatus };
    }
    const { schema, meta } = this.syncResponse;
    const { queries, diffs, disabledIndexes, pgStatStatementsNotInstalled } =
      await this.remote.getStatus();

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
    };
  }

  private pgStatStatementsNotInstalledError() {
    return {
      type: "error",
      error: "extension_not_installed",
      extensionName: "pg_stat_statements",
    } as const;
  }

  async onFullSync(rawBody: string): Promise<HandlerResult> {
    const body = RemoteSyncRequest.safeDecode(rawBody);
    if (!body.success) {
      return { status: 400, body: body.error };
    }

    const { db } = body.data;
    try {
      this.syncStatus = SyncStatus.IN_PROGRESS;
      this.syncResponse = await this.remote.syncFrom(db, {
        type: "pullFromSource",
      });
      this.syncStatus = SyncStatus.COMPLETED;
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
        },
      };
    } catch (error) {
      this.syncStatus = SyncStatus.FAILED;
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

  private makeLoggingHandler(process: "pg_restore" | "pg_dump") {
    return (logLine: string) => {
      console.log(logLine);
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
    if (this.socket?.readyState === 1 /* OPEN */) {
      this.socket.send(JSON.stringify(data));
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
