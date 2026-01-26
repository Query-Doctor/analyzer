import {
  PgIdentifier,
  type Postgres,
  PostgresVersion,
  Statistics,
  StatisticsMode,
} from "@query-doctor/core";
import { type Connectable } from "../sync/connectable.ts";
import { DumpCommand, RestoreCommand } from "../sync/schema-link.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { type RecentQuery } from "../sql/recent-query.ts";
import { type Op } from "jsondiffpatch/formatters/jsonpatch";
import { type FullSchema } from "../sync/schema_differ.ts";
import { type RemoteSyncFullSchemaResponse } from "./remote.dto.ts";
import { QueryOptimizer } from "./query-optimizer.ts";
import { EventEmitter } from "node:events";
import { log } from "../log.ts";
import { QueryLoader } from "./query-loader.ts";
import { SchemaLoader } from "./schema-loader.ts";

type RemoteEvents = {
  dumpLog: [line: string];
  restoreLog: [line: string];
};

/**
 * Represents a db for doing optimization work.
 * We only maintain one instance of this class as we only do
 * optimization against one physical postgres database.
 * But potentially more logical databases in the future.
 *
 * `Remote` only concerns itself with the remote it's doing optimization
 * against. It does not deal with the source in any way aside from running sync
 */
export class Remote extends EventEmitter<RemoteEvents> {
  static readonly baseDbName = PgIdentifier.fromString("postgres");
  static readonly optimizingDbName = PgIdentifier.fromString(
    "optimizing_db",
  );
  /* Threshold that we determine is "too few rows" for Postgres to start using indexes
   * and not defaulting to table scan.
   */
  private static readonly STATS_ROWS_THRESHOLD = 5_000;

  readonly optimizer: QueryOptimizer;

  /**
   * We have to juggle 2 different connections to the Remote
   *
   * 1 -> connection to `/postgres` where we manage other databases.
   *      this pool stays connected long-term. That's this variable
   *
   * 2 -> connections to {@link Remote.databaseName}. This connection pool is
   *      destroyed and re-created on each successful sync along with the db itself
   */
  private baseDbURL: Connectable;
  /** The URL of the optimizing db */
  private readonly optimizingDbUDRL: Connectable;

  private isPolling = false;
  private queryLoader?: QueryLoader;
  private schemaLoader?: SchemaLoader;

  constructor(
    /** This has to be a local url. Very bad things will happen if this is a remote URL */
    targetURL: Connectable,
    private readonly manager: ConnectionManager,
    /** The manager for ONLY the source db connections */
    private readonly sourceManager: ConnectionManager = ConnectionManager
      .forRemoteDatabase(),
  ) {
    super();
    this.baseDbURL = targetURL.withDatabaseName(Remote.baseDbName);
    this.optimizingDbUDRL = targetURL.withDatabaseName(Remote.optimizingDbName);
    this.optimizer = new QueryOptimizer(manager, this.optimizingDbUDRL);
  }

  async syncFrom(
    source: Connectable,
    statsStrategy: StatisticsStrategy = { type: "pullFromSource" },
  ): Promise<
    {
      meta: { version?: string; inferredStatsStrategy?: InferredStatsStrategy };
      schema: RemoteSyncFullSchemaResponse;
    }
  > {
    await this.resetDatabase();

    // First batch: get schema and other info in parallel (needed for stats decision)
    const [
      restoreResult,
      recentQueries,
      fullSchema,
      databaseInfo,
    ] = await Promise
      .allSettled([
        // This potentially creates a lot of connections to the source
        this.pipeSchema(this.optimizingDbUDRL, source),
        this.getRecentQueries(source),
        this.getFullSchema(source),
        this.getDatabaseInfo(source),
      ]);

    if (fullSchema.status === "fulfilled") {
      this.schemaLoader?.update(fullSchema.value);
    }

    // Second: resolve stats strategy using table list from schema
    const tables = fullSchema.status === "fulfilled"
      ? fullSchema.value.tables
      : [];
    const statsResult = await this.resolveStatistics(
      source,
      statsStrategy,
      tables,
    );

    const pg = this.manager.getOrCreateConnection(
      this.optimizingDbUDRL,
    );

    let queries: RecentQuery[] = [];
    if (recentQueries.status === "fulfilled") {
      queries = recentQueries.value;
    }

    await this.onSuccessfulSync(
      pg,
      source,
      queries,
      statsResult.mode,
    );

    return {
      meta: {
        version: databaseInfo.status === "fulfilled"
          ? databaseInfo.value.serverVersion
          : undefined,
        inferredStatsStrategy: statsResult.strategy,
      },
      schema: fullSchema.status === "fulfilled"
        ? { type: "ok", value: fullSchema.value }
        : {
          type: "error",
          error: fullSchema.reason instanceof Error
            ? fullSchema.reason.message
            : "Unknown error",
        },
    };
  }

  async getStatus() {
    const queries = this.optimizer.getQueries();
    const disabledIndexes = this.optimizer.getDisabledIndexes();
    const [diffs] = await Promise.allSettled([
      this.schemaLoader?.poll().then(
        (results) => results.diffs,
        (error) => {
          log.error("Failed to poll schema", "remote");
          console.error(error);
          throw error;
        },
      ) ??
        [] as Op[], /* no panic in case schemaLoader has not loaded in yet */
      this.pollQueriesOnce().catch((error) => {
        log.error("Failed to poll queries", "remote");
        console.error(error);
        throw error;
      }),
    ]);

    return { queries, diffs, disabledIndexes };
  }

  /**
   * Runs a single poll of pg_stat_statements if
   * there isn't already an in-flight request
   */
  private async pollQueriesOnce() {
    if (this.queryLoader && !this.isPolling) {
      try {
        this.isPolling = true;
        await this.queryLoader.poll();
      } finally {
        this.isPolling = false;
      }
    }
  }

  /**
   * Drops and recreates the {@link Remote.optimizingDbName} db.
   *
   * TODO: allow juggling multiple databases in the future
   */
  private async resetDatabase(): Promise<void> {
    const databaseName = Remote.optimizingDbName;
    log.info(`Resetting internal database: ${databaseName}`, "remote");
    const baseDb = this.manager.getOrCreateConnection(this.baseDbURL);
    // these cannot be run in the same `exec` block as that implicitly creates transactions
    await baseDb.exec(
      // drop database does not allow parameterization
      `drop database if exists ${databaseName} with (force);`,
    );
    await baseDb.exec(`create database ${databaseName};`);
  }

  private async pipeSchema(
    target: Connectable,
    source: Connectable,
  ): Promise<void> {
    const dump = DumpCommand.spawn(source, "native-postgres");
    // is copying up events like this a good idea?
    dump.on("dump", (data) => {
      this.emit("dumpLog", data);
    });
    dump.on("restore", (data) => {
      this.emit("restoreLog", data);
    });

    const restore = RestoreCommand.spawn(target);
    const { dump: dumpResult, restore: restoreResult } = await dump.pipeTo(
      restore,
    );
    if (!dumpResult.status.success) {
      throw new Error(
        `Dump failed with status ${dumpResult.status.code}`,
      );
    }
    if (restoreResult && !restoreResult.status.success) {
      throw new Error(
        `Restore failed with status ${restoreResult.status.code}`,
      );
    }
  }

  private async resolveStatistics(
    source: Connectable,
    strategy: StatisticsStrategy,
    tables: { schemaName: PgIdentifier; tableName: PgIdentifier }[],
  ): Promise<StatsResult> {
    if (strategy.type === "static") {
      // Static strategy doesn't go through inference
      return { mode: strategy.stats, strategy: "fromSource" };
    }
    return this.decideStatsStrategy(source, tables);
  }

  private async decideStatsStrategy(
    source: Connectable,
    tables: { schemaName: PgIdentifier; tableName: PgIdentifier }[],
  ): Promise<StatsResult> {
    const connector = this.sourceManager.getConnectorFor(source);
    const totalRows = await connector.getTotalRowCount(tables);

    if (totalRows < Remote.STATS_ROWS_THRESHOLD) {
      log.info(
        `Total rows (${totalRows}) below threshold, using default 10k stats`,
        "remote",
      );
      return { mode: Statistics.defaultStatsMode, strategy: "10k" };
    }

    log.info(
      `Total rows (${totalRows}) above threshold, pulling source stats`,
      "remote",
    );
    return { mode: await this.dumpSourceStats(source), strategy: "fromSource" };
  }

  private async dumpSourceStats(source: Connectable): Promise<StatisticsMode> {
    const pg = this.sourceManager.getOrCreateConnection(
      source,
    );
    const stats = await Statistics.dumpStats(
      pg,
      PostgresVersion.parse("17"),
      "full",
    );
    return { kind: "fromStatisticsExport", source: { kind: "inline" }, stats };
  }

  private async getRecentQueries(
    source: Connectable,
  ): Promise<RecentQuery[]> {
    const connector = this.sourceManager.getConnectorFor(source);
    return await connector.getRecentQueries();
  }

  private getFullSchema(source: Connectable): Promise<FullSchema> {
    const connector = this.sourceManager.getConnectorFor(source);
    return connector.getSchema();
  }

  private getDatabaseInfo(source: Connectable) {
    const connector = this.sourceManager.getConnectorFor(source);
    return connector.getDatabaseInfo();
  }

  async resetPgStatStatements(source: Connectable): Promise<void> {
    const connector = this.sourceManager.getConnectorFor(source);
    await connector.resetPgStatStatements();
    this.optimizer.restart({ clearQueries: true });
  }

  /**
   * Process a successful sync and run any potential cleanup functions
   */
  private async onSuccessfulSync(
    postgres: Postgres,
    source: Connectable,
    recentQueries: RecentQuery[],
    stats?: StatisticsMode,
  ): Promise<void> {
    if (source.isSupabase()) {
      // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
      await postgres.exec("drop schema if exists extensions cascade");
    }
    this.startQueryLoader(source);
    this.optimizer.start(recentQueries, stats);
  }

  private startQueryLoader(source: Connectable) {
    if (this.queryLoader) {
      this.queryLoader.stop();
    }
    this.queryLoader = new QueryLoader(this.sourceManager, source);
    this.schemaLoader = new SchemaLoader(this.sourceManager, source);
    this.queryLoader.on("pollError", (error) => {
      log.error("Failed to poll queries", "remote");
      console.error(error);
    });
    this.queryLoader.on("poll", (queries) => {
      this.optimizer.addQueries(queries).catch((error) => {
        log.error(
          `Failed to add ${queries.length} queries to optimizer`,
          "remote",
        );
        console.error(error);
      });
    });
    this.queryLoader.on("exit", () => {
      log.error("Query loader exited", "remote");
      this.queryLoader = undefined;
    });
    this.queryLoader.start();
  }

  async cleanup(): Promise<void> {
    await this.optimizer.finish;
    this.optimizer.stop();
    await Promise.all([
      this.manager.closeAll(),
      this.sourceManager.closeAll(),
    ]);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

export type StatisticsStrategy = {
  type: "pullFromSource";
} | {
  type: "static";
  stats: StatisticsMode;
};

export type InferredStatsStrategy = "10k" | "fromSource";

type StatsResult = {
  mode: StatisticsMode;
  strategy: InferredStatsStrategy;
};
