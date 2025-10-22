import {
  DependencyAnalyzer,
  type DependencyAnalyzerOptions,
  DependencyResolutionNotice,
} from "./dependency-tree.ts";
import {
  PostgresConnector,
  RecentQuery,
  type ResetPgStatStatementsResult,
} from "./pg-connector.ts";
import { PostgresSchemaLink } from "./schema.ts";
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
  queries: RecentQuery[];
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
    schemaName: string,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const sql = this.getConnection(connectable);
    const connector = new PostgresConnector(sql, this.segmentedQueryCache);
    const link = new PostgresSchemaLink(connectable.toString(), schemaName);
    const analyzer = new DependencyAnalyzer(connector, options);
    const [
      stats,
      databaseInfo,
      recentQueries,
      schema,
      { dependencies, serialized: serializedResult },
    ] = await Promise.all([
      withSpan("stats", () => {
        return Statistics.dumpStats(sql, PostgresVersion.parse("17"), "full");
      })(),
      withSpan("getDatabaseInfo", () => {
        return connector.getDatabaseInfo();
      })(),
      withSpan("getRecentQueries", () => {
        return connector.getRecentQueries();
      })(),
      withSpan("pg_dump", () => {
        return link.syncSchema(schemaName);
      })(),
      withSpan("resolveDependencies", async (span) => {
        const dependencyList = await connector.dependencies(schemaName);
        const graph = await analyzer.buildGraph(dependencyList);
        span.setAttribute("schemaName", schemaName);
        const dependencies = await analyzer.findAllDependencies(
          schemaName,
          graph,
        );
        const serialized = await withSpan("serialize", (span) => {
          span.setAttribute("schemaName", schemaName);
          return connector.serialize(schemaName, dependencies.items, options);
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
      queries: recentQueries,
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
