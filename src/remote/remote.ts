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
import { type FullSchema, SchemaDiffer } from "../sync/schema_differ.ts";
import { type RemoteSyncResponse } from "./remote.dto.ts";
import { QueryOptimizer } from "./query-optimizer.ts";

/**
 * Represents a db for doing optimization work.
 * We only maintain one instance of this class as we only do
 * optimization against one physical postgres database.
 * But potentially more logical databases in the future.
 *
 * `Remote` only concerns itself with the remote it's doing optimization
 * against. It does not deal with the source in any way aside from running sync
 */
export class Remote {
  static readonly baseDbName = PgIdentifier.fromString("postgres");
  static readonly optimizingDbName = PgIdentifier.fromString(
    "optimizing_db",
  );

  private readonly differ = new SchemaDiffer();
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

  constructor(
    /** This has to be a local url. Very bad things will happen if this is a remote URL */
    targetURL: Connectable,
    private readonly manager: ConnectionManager,
  ) {
    this.baseDbURL = targetURL.withDatabaseName(Remote.baseDbName);
    this.optimizingDbUDRL = targetURL.withDatabaseName(Remote.optimizingDbName);
    this.optimizer = new QueryOptimizer(manager);
  }

  async syncFrom(
    source: Connectable,
    statsStrategy: StatisticsStrategy = { type: "pullFromSource" },
  ): Promise<RemoteSyncResponse> {
    await this.resetDatabase();
    const [_restoreResult, recentQueries, fullSchema, pulledStats] =
      await Promise
        .allSettled([
          // This potentially creates a lot of connections to the source
          this.pipeSchema(this.optimizingDbUDRL, source),
          this.getRecentQueries(source),
          this.getFullSchema(source),
          this.dumpSourceStats(source),
          this.resolveStatisticsStrategy(source, statsStrategy),
        ]);

    if (fullSchema.status === "fulfilled") {
      this.differ.put(source, fullSchema.value);
    }

    const pg = this.manager.getOrCreateConnection(
      this.optimizingDbUDRL,
    );

    let queries: RecentQuery[] = [];
    if (recentQueries.status === "fulfilled") {
      queries = recentQueries.value;
    }

    let stats: StatisticsMode | undefined;
    if (pulledStats.status === "fulfilled") {
      stats = pulledStats.value;
    }

    await this.onSuccessfulSync(
      pg,
      source,
      queries,
      stats,
    );

    return {
      queries: recentQueries.status === "fulfilled"
        ? {
          type: "ok",
          value: recentQueries.value,
        }
        : {
          type: "error",
          error: recentQueries.reason instanceof Error
            ? recentQueries.reason.message
            : "Unknown error",
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

  /**
   * Drops and recreates the {@link Remote.optimizingDbName} db.
   *
   * TODO: allow juggling multiple databases in the future
   */
  private async resetDatabase(): Promise<void> {
    const databaseName = Remote.optimizingDbName;
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
    // TODO: handle event emitter events
    // dump.on("dump", (data) => {
    //   console.log("got dump data", data);
    // });
    // dump.on("restore", (data) => {
    //   console.log("got restore data", data);
    // });
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

  private resolveStatisticsStrategy(
    source: Connectable,
    strategy: StatisticsStrategy,
  ): Promise<StatisticsMode> {
    switch (strategy.type) {
      case "static":
        return Promise.resolve(strategy.stats);
      case "pullFromSource":
        return this.dumpSourceStats(source);
    }
  }

  private async dumpSourceStats(source: Connectable): Promise<StatisticsMode> {
    const pg = this.manager.getOrCreateConnection(source);
    const stats = await Statistics.dumpStats(
      pg,
      PostgresVersion.parse("17"),
      "full",
    );
    return { kind: "fromStatisticsExport", source: { kind: "inline" }, stats };
  }

  private getRecentQueries(
    source: Connectable,
  ): Promise<RecentQuery[]> {
    const connector = this.manager.getConnectorFor(source);
    return connector.getRecentQueries();
  }

  private getFullSchema(source: Connectable): Promise<FullSchema> {
    const connector = this.manager.getConnectorFor(source);
    return connector.getSchema();
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
    this.optimizer.start(this.optimizingDbUDRL, recentQueries, stats);
  }
}

export type StatisticsStrategy = {
  type: "pullFromSource";
} | {
  type: "static";
  stats: StatisticsMode;
};
