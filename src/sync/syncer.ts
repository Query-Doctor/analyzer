import {
  DependencyAnalyzer,
  type DependencyAnalyzerOptions,
  DependencyResolutionNotice,
} from "./dependency-tree.ts";
import { RecentQueriesResult } from "./pg-connector.ts";
import { PostgresSchemaLink } from "./schema-link.ts";
import { withSpan } from "../otel.ts";
import { Connectable } from "./connectable.ts";
import { ExportedStats, PostgresVersion, Statistics } from "@query-doctor/core";
import { SchemaDiffer } from "./schema_differ.ts";
import { ExtensionNotInstalledError } from "./errors.ts";
import { ConnectionManager } from "./connection-manager.ts";

type SyncOptions = DependencyAnalyzerOptions;

export type PostgresConnectionError = {
  kind: "error";
  type: "postgres_connection_error";
  error: Error;
};

type PostgresSuperuserError = {
  kind: "connected_as_superuser";
  username: string;
};

export type SyncNotice = DependencyResolutionNotice | PostgresSuperuserError;

export type SyncResult = {
  versionNum: string;
  version: string;
  setup: string;
  sampledRecords: Record<string, number>;
  notices: SyncNotice[];
  queries: RecentQueriesResult;
  stats: ExportedStats[];
};

export class PostgresSyncer {
  private readonly differ = new SchemaDiffer();

  constructor(
    private readonly manager: ConnectionManager,
  ) {}

  /**
   * @throws {ExtensionNotInstalledError}
   * @throws {PostgresError}
   */
  async syncDDL(
    connectable: Connectable,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const sql = this.manager.getOrCreateConnection(connectable);
    const connector = this.manager.getConnectorFor(sql);
    const link = new PostgresSchemaLink(connectable, "pglite");
    const analyzer = new DependencyAnalyzer(connector, options);
    const [
      stats,
      databaseInfo,
      recentQueriesResult,
      schema,
      { dependencies, serialized: serializedResult },
    ] = await Promise.all([
      withSpan("stats", () => {
        return Statistics.dumpStats(sql, PostgresVersion.parse("17"), "full");
      })(),
      withSpan("getDatabaseInfo", () => {
        return connector.getDatabaseInfo();
      })(),
      withSpan("getRecentQueries", async (): Promise<RecentQueriesResult> => {
        try {
          const recentQueries = await connector.getRecentQueries();
          return { kind: "ok", queries: recentQueries };
        } catch (error) {
          console.log(error);
          // don't stop the show if the extension is not installed
          if (error instanceof ExtensionNotInstalledError) {
            return {
              kind: "error",
              type: "extension_not_installed",
              extensionName: error.extension,
            };
          }
          throw error;
        }
      })(),
      withSpan("pg_dump", () => {
        return link.dumpAsText();
      })(),
      withSpan("resolveDependencies", async () => {
        const dependencyList = await connector.dependencies({
          excludedSchemas: link.excludedSchemas(),
        });
        const graph = await analyzer.buildGraph(dependencyList);
        const dependencies = await analyzer.findAllDependencies(
          graph,
        );
        const serialized = await withSpan("serialize", () => {
          return connector.serialize(dependencies.items, options);
        })();
        return { dependencies, serialized };
      })(),
    ]);

    const notices: SyncNotice[] = [...dependencies.notices];

    if (databaseInfo.isSuperuser) {
      notices.push({
        kind: "connected_as_superuser",
        username: databaseInfo.username,
      });
    }

    this.differ.put(sql, serializedResult.schema);

    const wrapped = schema + serializedResult.serialized;

    return {
      versionNum: databaseInfo.serverVersionNum,
      version: databaseInfo.serverVersion,
      sampledRecords: serializedResult.sampledRecords,
      notices,
      queries: recentQueriesResult,
      setup: wrapped,
      stats,
    };
  }

  /**
   * @throws {ExtensionNotInstalledError}
   * @throws {PostgresError}
   */
  async liveQuery(connectable: Connectable) {
    const sql = this.manager.getOrCreateConnection(connectable);
    const connector = this.manager.getConnectorFor(sql);
    const [queries, schema] = await Promise.all([
      connector.getRecentQueries(),
      connector.getSchema(),
    ]);
    const deltas = this.differ.put(sql, schema);
    return { queries, deltas };
  }

  /**
   * @throws {ExtensionNotInstalledError}
   * @throws {PostgresError}
   */
  async reset(
    connectable: Connectable,
  ): Promise<void> {
    const connector = this.manager.getConnectorFor(connectable);
    await connector.resetPgStatStatements();
  }
}
