import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { RpcStub } from "capnweb";
import type { ConnectionMode, UnauthenticatedServerApi, ClientApi, IndexDefinition, ServerApi } from "@query-doctor/core";
import type { ExportedStats } from "@query-doctor/core";
import { PgIdentifier, Statistics } from "@query-doctor/core";
import { log } from "../log.ts";
import type { Remote } from "./remote.ts";
import type { OptimizedQuery, RecentQuery } from "../sql/recent-query.ts";

export function hookUpApiReporter(api: RpcStub<ServerApi>, remote: Remote): () => void {
  const onExtensionPresenceChanged = (presence: Parameters<typeof api.setExtensionPresence>[0]) => {
    api.setExtensionPresence(presence).catch((err) => {
      log.error(`Failed to report extension presence: ${err}`, "api-client");
    });
  };
  const onDumpLog = (line: string) => {
    api.log(line, "pg_dump").catch((err) => {
      log.error(`Failed to send dump log: ${err}`, "api-client");
    });
  };
  const onRestoreLog = (line: string) => {
    api.log(line, "pg_restore").catch((err) => {
      log.error(`Failed to send restore log: ${err}`, "api-client");
    });
  };
  const onSchemaSynced = (schema: Parameters<typeof api.pushSchema>[0]) => {
    api.pushSchema(JSON.parse(JSON.stringify(schema))).catch((err) => {
      log.error(`Failed to push schema: ${err}`, "api-client");
    });
  };
  const onStatsApplied = (stats: Parameters<typeof api.pushStats>[0]) => {
    api.pushStats(stats).catch((err) => {
      log.error(`Failed to push stats: ${err}`, "api-client");
    });
  };
  // pg_stat_statements retains everything the database ever executed — COPY
  // from dumps/seeds, DDL from migrations, VACUUM. None of it is an app query:
  // shipping it pollutes the project's query catalog and fires unfixable
  // "no CI coverage" alerts (Query-Doctor/Site#3578). Only DML is pushed.
  // `undefined` (analysis skipped or failed) is pushed too — fail open rather
  // than silently losing real queries. Known gap: core classifies MergeStmt as
  // "other", so MERGE statements are dropped until its map learns them.
  const isAppQuery = (query: RecentQuery) => query.statementType !== "other";

  const onQueriesPolled = (queries: RecentQuery[]) => {
    const appQueries = queries.filter(isAppQuery);
    if (appQueries.length === 0) return;
    api.pushQuery(JSON.parse(JSON.stringify(appQueries))).catch((err) => {
      log.error(`Failed to push polled queries: ${err}`, "api-client");
    });
  };
  const pushOptimizedQuery = (query: OptimizedQuery) => {
    if (!isAppQuery(query)) return;
    const q = [query.toJSON()]
    api.pushQuery(q).catch((err) => {
      log.error(`Failed to push optimized query: ${err}`, "api-client");
    });
  };

  const onQueryError = (error: Error) => {
    log.error(`Query error: ${error.message}`, "api-client");
  };

  remote.on("extensionPresenceChanged", onExtensionPresenceChanged);
  remote.on("dumpLog", onDumpLog);
  remote.on("restoreLog", onRestoreLog);
  remote.on("schemaSynced", onSchemaSynced);
  remote.on("statsApplied", onStatsApplied);
  remote.on("queriesPolled", onQueriesPolled);
  remote.on("queryError", onQueryError);
  remote.optimizer.on("noImprovements", pushOptimizedQuery);
  remote.optimizer.on("improvementsAvailable", pushOptimizedQuery);
  remote.optimizer.on("zeroCostPlan", pushOptimizedQuery);
  remote.optimizer.on("timeout", pushOptimizedQuery);

  return () => {
    remote.off("extensionPresenceChanged", onExtensionPresenceChanged);
    remote.off("dumpLog", onDumpLog);
    remote.off("restoreLog", onRestoreLog);
    remote.off("schemaSynced", onSchemaSynced);
    remote.off("statsApplied", onStatsApplied);
    remote.off("queriesPolled", onQueriesPolled);
    remote.off("queryError", onQueryError);
    remote.optimizer.off("noImprovements", pushOptimizedQuery);
    remote.optimizer.off("improvementsAvailable", pushOptimizedQuery);
    remote.optimizer.off("zeroCostPlan", pushOptimizedQuery);
    remote.optimizer.off("timeout", pushOptimizedQuery);
  };
}

export interface ApiConnection {
  api: RpcStub<ServerApi>;
  dispose: () => void;
}

export class ApiClient extends RpcTarget implements ClientApi {
  static #name = "ApiClient"
  static #PING_INTERVAL_MS = 30_000;
  static #PING_MAX_BACKOFF_MS = 10_000;

  private constructor(private readonly remote: Remote) {
    super();
  }


  static async connect(endpoint: string, token: string, mode: ConnectionMode, remote: Remote, onBroken: (err: unknown) => void): Promise<ApiConnection> {
    const wsEndpoint = `${endpoint}/relay`.replace(/^http/, "ws");
    const unauthenticated = newWebSocketRpcSession<UnauthenticatedServerApi>(wsEndpoint);
    const api = await unauthenticated.authenticate(token, new this(remote), mode) as unknown as RpcStub<ServerApi>;
    let broken = false;
    const triggerBroken = (err: unknown) => {
      if (broken) return;
      broken = true;
      stopPing();
      onBroken(err);
    };
    const stopPing = this.schedulePingTimer(api, triggerBroken);
    api.onRpcBroken(triggerBroken);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stopPing();
      try { api[Symbol.dispose](); } catch { /* already gone */ }
      try { (unauthenticated as unknown as Disposable)[Symbol.dispose]?.(); } catch { /* already gone */ }
    };
    return { api, dispose };
  }

  static connectWithReconnect(endpoint: string, token: string, mode: ConnectionMode, remote: Remote): void {
    let cleanup: (() => void) | undefined;
    const attempt = async (failCount: number) => {
      try {
        const { api, dispose } = await this.connect(endpoint, token, mode, remote, (err) => {
          const delay = Math.min(failCount * 1000, this.#PING_MAX_BACKOFF_MS);
          log.error(`Connection broken: ${err}, reconnecting in ${delay}ms`, this.#name);
          cleanup?.();
          cleanup = undefined;
          dispose();
          setTimeout(() => attempt(failCount + 1), delay);
        });
        log.info(`Connected to the api`, this.#name);
        cleanup = hookUpApiReporter(api, remote);
      } catch (err) {
        if (err instanceof Error && err.message === "Unauthorized") {
          log.error(`Invalid TOKEN, cannot connect to the api`, this.#name);
          return;
        }
        const delay = Math.min(failCount * 1000, this.#PING_MAX_BACKOFF_MS);
        log.error(`Failed to connect: ${err}, reconnecting in ${delay}ms`, this.#name);
        setTimeout(() => attempt(failCount + 1), delay);
      }
    };
    attempt(0);
  }

  static schedulePingTimer(api: RpcStub<ServerApi>, onFailed: (err: unknown) => void): () => void {
    const timer = setInterval(() => {
      api.ping().catch(err => {
        log.error(`Could not ping the API server\n${err}`, this.#name)
        clearInterval(timer);
        onFailed(err);
      });
    }, this.#PING_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  async repull(): Promise<void> {
    await this.remote.resync();
  }

  async refreshQueries(): Promise<void> {
    await this.remote.pollQueriesOnce();
  }

  async updateStatistics(stats: ExportedStats[]): Promise<void> {
    await this.remote.applyStatistics(Statistics.statsModeFromExport(stats));
  }

  async resetStats(): Promise<void> {
    await this.remote.applyStatistics(Statistics.defaultStatsMode);
  }

  async hideIndex(indexName: string): Promise<void> {
    this.remote.optimizer.toggleIndex(PgIdentifier.fromString(indexName));
  }

  async addIndex(index: IndexDefinition): Promise<void> {
    await this.remote.optimizer.createIndex(
      index.tableName,
      index.columns.map((c) => ({
        name: c.name,
        order: (c.order?.toLowerCase() ?? "asc") as "asc" | "desc",
      })),
    );
  }

  async runQuery(_query: string): Promise<void> {
    log.warn("runQuery is not implemented", ApiClient.name);
  }
}
