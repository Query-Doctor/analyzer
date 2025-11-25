import {
  DependencyAnalyzer,
  type DependencyAnalyzerOptions,
  DependencyResolutionNotice,
} from "./dependency-tree.ts";
import { PostgresConnector, RecentQueriesResult } from "./pg-connector.ts";
import { PostgresSchemaLink } from "./schema-link.ts";
import { withSpan } from "../otel.ts";
import { Connectable } from "./connectable.ts";
import {
  ExportedStats,
  type Postgres,
  type PostgresFactory,
  PostgresVersion,
  Statistics,
} from "@query-doctor/core";
import { SegmentedQueryCache } from "./seen-cache.ts";
import { SchemaDiffer } from "./schema_differ.ts";
import { ExtensionNotInstalledError } from "./errors.ts";

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
  private readonly connections = new Map<string, Postgres>();
  private readonly segmentedQueryCache = new SegmentedQueryCache();
  private readonly differ = new SchemaDiffer();

  constructor(private readonly factory: PostgresFactory) {}

  /**
   * @throws {ExtensionNotInstalledError}
   * @throws {PostgresError}
   */
  async syncWithUrl(
    connectable: Connectable,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const sql = this.getConnection(connectable);
    const connector = new PostgresConnector(sql, this.segmentedQueryCache);
    const link = new PostgresSchemaLink(connectable);
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
        return link.syncSchema();
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
    const sql = this.getConnection(connectable);
    const connector = new PostgresConnector(sql, this.segmentedQueryCache);
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
    const sql = this.getConnection(connectable);
    const connector = new PostgresConnector(sql, this.segmentedQueryCache);
    await connector.resetPgStatStatements();
  }

  private getConnection(connectable: Connectable) {
    const urlString = connectable.toString();
    let sql = this.connections.get(urlString);
    if (!sql) {
      sql = this.factory({ url: urlString });
      this.connections.set(urlString, sql);
    }
    return sql;
  }
}
