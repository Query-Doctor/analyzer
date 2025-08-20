import postgres from "postgresjs";
import {
  DependencyAnalyzer,
  type DependencyAnalyzerOptions,
  DependencyResolutionNotice,
  FindAllDependenciesError,
} from "./dependency-tree.ts";
import {
  PostgresConnector,
  RecentQueriesResult,
  type TableMetadata,
} from "./pg-connector.ts";
import { PostgresSchemaLink } from "./schema.ts";
import { withSpan } from "../otel.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { Connectable } from "./connectable.ts";

type SyncOptions = DependencyAnalyzerOptions;

export type PostgresConnectionError = {
  kind: "error";
  type: "postgres_connection_error";
  error: Error;
};

type PostgresError = {
  kind: "error";
  type: "postgres_error";
  error: Error;
};

type PostgresSuperuserError = {
  kind: "connected_as_superuser";
  username: string;
};

export type SyncNotice = DependencyResolutionNotice | PostgresSuperuserError;

export type SyncResult =
  | {
    kind: "ok";
    versionNum: string;
    version: string;
    setup: string;
    sampledRecords: Record<string, number>;
    notices: SyncNotice[];
    queries: RecentQueriesResult;
    metadata: TableMetadata[];
  }
  | PostgresConnectionError
  | PostgresError
  | FindAllDependenciesError;

export class PostgresSyncer {
  private readonly connections = new Map<string, postgres.Sql>();
  constructor() {}

  async syncWithUrl(
    connectable: Connectable,
    schemaName: string,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const urlString = connectable.toString();
    let sql = this.connections.get(urlString);
    if (!sql) {
      sql = postgres(urlString, { max: 50 });
      this.connections.set(urlString, sql);
    }
    const connector = new PostgresConnector(sql);
    const link = new PostgresSchemaLink(urlString, schemaName);
    const analyzer = new DependencyAnalyzer(connector, options);
    // Even though this looks like it can be parallelized, it's not possible to run it
    // simultaneously with `link.syncSchema` because pg_dump changes `search_path` which
    // causes inconsistent results when querying regclasses. They get prefixed with
    // the current search_path which can cause race conditions when pg_dump sets it to ''
    const [
      databaseInfo,
      recentQueries,
      schema,
      { dependencies, serialized: serializedResult },
      privilege,
    ] = await Promise.all([
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
        const deps = await analyzer.findAllDependencies(schemaName, graph);
        if (deps.kind !== "ok") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: deps.type === "unexpected_error"
              ? deps.error.message
              : deps.type,
          });
          return { dependencies: deps, serialized: undefined };
        }
        const serialized = await withSpan("serialize", (span) => {
          span.setAttribute("schemaName", schemaName);
          return connector.serialize(schemaName, deps.items, options);
        })();
        return { dependencies: deps, serialized };
      })(),
      withSpan("checkPrivilege", () => {
        return connector.checkPrivilege();
      })(),
    ]);

    if (dependencies.kind !== "ok") {
      return dependencies;
    }

    const notices: SyncNotice[] = [...dependencies.notices];

    if (privilege.isSuperuser) {
      notices.push({
        kind: "connected_as_superuser",
        username: privilege.username,
      });
    }

    if (serializedResult === undefined) {
      throw new Error(`Serialization result not found`);
    }

    const wrapped = schema + serializedResult.serialized;

    return {
      kind: "ok",
      versionNum: databaseInfo.serverVersionNum,
      version: databaseInfo.serverVersion,
      sampledRecords: serializedResult.sampledRecords,
      notices,
      queries: recentQueries,
      setup: wrapped,
      metadata: serializedResult.schema,
    };
  }

  liveQuery(
    connectable: Connectable,
  ): Promise<RecentQueriesResult | PostgresConnectionError> {
    const sql = this.getConnection(connectable);
    const connector = new PostgresConnector(sql);
    return connector.getRecentQueries();
  }

  private checkConnection(sql: postgres.Sql) {
    return withSpan("checkConnection", async () => {
      await sql`select 1`;
    })();
  }

  private getConnection(connectable: Connectable) {
    const urlString = connectable.toString();
    let sql = this.connections.get(urlString);
    if (!sql) {
      sql = postgres(urlString);
      this.connections.set(urlString, sql);
    }
    return sql;
  }
}
