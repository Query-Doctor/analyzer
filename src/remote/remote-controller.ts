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

  async execute(
    request: Request,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === "/postgres") {
      const isWebsocket = request.headers.get("upgrade") === "websocket";
      if (isWebsocket) {
        return this.onWebsocketRequest(request);
      } else if (request.method === "POST") {
        return await this.onFullSync(request);
      } else if (request.method === "GET") {
        return await this.getStatus();
      }
      return methodNotAllowed();
    }

    if (url.pathname === "/postgres/indexes/toggle") {
      if (request.method === "POST") {
        return await this.toggleIndex(request);
      }
      return methodNotAllowed();
    }

    if (url.pathname === "/postgres/reset") {
      if (request.method === "POST") {
        return await this.onReset(request);
      }
      return methodNotAllowed();
    }

    if (url.pathname === "/postgres/indexes") {
      if (request.method === "POST") {
        return await this.createIndex(request);
      }
      return methodNotAllowed();
    }

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

  private async toggleIndex(request: Request): Promise<Response> {
    try {
      const data = await request.json();
      const index = ToggleIndexDto.decode(data);
      const isDisabled = this.remote.optimizer.toggleIndex(index.indexName);
      return Response.json({ isDisabled });
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json({
          type: "error",
          error: "invalid_body",
          message: error.message,
        }, {
          status: 400,
        });
      }
      return Response.json({
        type: "error",
        error: env.HOSTED ? "Internal Server Error" : error,
        message: "Failed to sync database",
      }, {
        status: 500,
      });
    }
  }

  private async getStatus(): Promise<Response> {
    if (!this.syncResponse || this.syncStatus !== SyncStatus.COMPLETED) {
      return Response.json({ status: this.syncStatus });
    }
    const { schema, meta } = this.syncResponse;
    const { queries, diffs, disabledIndexes } = await this.remote.getStatus();
    let deltas: DeltasResult;
    if (diffs.status === "fulfilled") {
      deltas = { type: "ok", value: diffs.value };
    } else {
      deltas = { type: "error", value: String(diffs.reason) };
    }
    return Response.json({
      status: this.syncStatus,
      meta,
      schema,
      queries: { type: "ok", value: queries },
      disabledIndexes: { type: "ok", value: disabledIndexes },
      deltas,
    });
  }

  private async onFullSync(request: Request): Promise<Response> {
    const body = RemoteSyncRequest.safeDecode(await request.text());
    if (!body.success) {
      return new Response(JSON.stringify(body.error), { status: 400 });
    }

    const { db } = body.data;
    try {
      this.syncStatus = SyncStatus.IN_PROGRESS;
      this.syncResponse = await this.remote.syncFrom(db, {
        type: "pullFromSource",
      });
      this.syncStatus = SyncStatus.COMPLETED;
      const { schema, meta } = this.syncResponse;
      const queries = this.remote.optimizer.getQueries();

      return Response.json({
        meta,
        schema,
        queries: { type: "ok", value: queries },
      });
    } catch (error) {
      this.syncStatus = SyncStatus.FAILED;
      console.error(error);
      return Response.json({
        type: "error",
        error: env.HOSTED ? "Internal Server Error" : error,
        message: "Failed to sync database",
      }, {
        status: 500,
      });
    }
  }

  private async onReset(request: Request): Promise<Response> {
    const body = RemoteSyncRequest.safeDecode(await request.text());
    if (!body.success) {
      return new Response(JSON.stringify(body.error), { status: 400 });
    }

    try {
      await this.remote.resetPgStatStatements(body.data.db);
      return Response.json({ success: true });
    } catch (error) {
      console.error(error);
      if (error instanceof errors.PostgresError) {
        return error.toResponse();
      }
      if (error instanceof errors.ExtensionNotInstalledError) {
        return error.toResponse();
      }
      return Response.json({
        error: error instanceof Error ? error.message : "Unknown error",
      }, { status: 500 });
    }
  }

  private async createIndex(request: Request): Promise<Response> {
    try {
      const data = await request.json();
      const body = CreateIndexDto.parse(data);
      await this.remote.optimizer.createIndex(body.table, body.columns);
      return Response.json({ success: true });
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json({
          type: "error",
          error: "invalid_body",
          message: error.message,
        }, { status: 400 });
      }
      console.error("Failed to create index:", error);
      return Response.json({
        error: error instanceof Error ? error.message : "Failed to create index",
      }, { status: 500 });
    }
  }

  private onWebsocketRequest(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);
    this.socket = socket;
    log.debug("Websocket connection established", "remote-controller");

    socket.addEventListener("close", () => {
      log.debug("Websocket connection closed", "remote-controller");
    }, { once: true });

    return response;
  }

  private makeLoggingHandler(process: "pg_restore" | "pg_dump") {
    return (log: string) => {
      console.log(log);
      this.socket?.send(JSON.stringify({
        type: "log",
        process,
        log,
      }));
    };
  }

  private eventOnQueryProcessed(query: OptimizedQuery) {
    this.socket?.send(JSON.stringify({
      type: "queryProcessed",
      query,
    }));
  }

  private eventError(error: Error, query: OptimizedQuery) {
    console.error(error);
    this.eventOnQueryProcessed(query);
    this.socket?.send(
      JSON.stringify({
        type: "error",
        query,
        error: error.message,
      }),
    );
  }
}

function methodNotAllowed(): Response {
  return Response.json("Method not allowed", { status: 405 });
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
