import {
  dumpSchema,
  FullSchema,
  PgIdentifier,
  type Postgres,
  PostgresVersion,
  Statistics,
  StatisticsMode,
  type ExtensionPresence,
  type ExportedStats,
  FullSchemaTable,
} from "@query-doctor/core";
import { type Connectable } from "../sync/connectable.ts";
import { DumpCommand, RestoreCommand } from "../sync/schema-link.ts";
import { describeCommandFailure } from "../sync/command-failure.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { ExtensionNotInstalledError } from "../sync/errors.ts";
import { type OptimizedQuery, type RecentQuery } from "../sql/recent-query.ts";
import { type Op } from "jsondiffpatch/formatters/jsonpatch";
import { type RemoteSyncFullSchemaResponse } from "./remote.dto.ts";
import { QueryOptimizer } from "./query-optimizer.ts";
import { EventEmitter } from "node:events";
import { log } from "../log.ts";
import { QueryLoader } from "./query-loader.ts";
import { SchemaLoader } from "./schema-loader.ts";
import {
  baselineFromDump,
  DEFAULT_REFRESH_FLOOR_MS,
  DEFAULT_SIZE_DRIFT_RATIO,
  detectDrift,
  isPastRefreshFloor,
  type StatsBaseline,
} from "./stats-drift.ts";

type RemoteEvents = {
  dumpLog: [line: string];
  restoreLog: [line: string];
  extensionPresenceChanged: [presence: ExtensionPresence];
  queriesPolled: [queries: RecentQuery[]];
  schemaSynced: [schema: FullSchema];
  schemaDiffed: [diffs: Op[], schema: FullSchema];
  statsApplied: [stats: ExportedStats[]];
  queryError: [error: Error, query: OptimizedQuery];
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
  private static readonly optimizingDbPrefix = "optimizing_db";
  static defaultOptimizingDbPrefix = PgIdentifier.fromString(Remote.optimizingDbPrefix)

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
  private generation = 0;
  private lastSourceDb?: Connectable;
  /** The URL of the current generation optimizing db */
  private optimizingDbUDRL: Connectable;

  get optimizingDb(): Connectable {
    return this.optimizingDbUDRL;
  }

  private isPolling = false;
  private queryLoader?: QueryLoader;
  private schemaLoader?: SchemaLoader;
  /**
   * Tables and row counts as of the last statistics dump this analyzer pushed.
   * Drift is measured against this, not against the previous poll, so a slow
   * steady change still eventually earns a re-dump (ADR 0007 §2). Undefined
   * until the first push, and only maintained for `fromSource` stats — an
   * imported or synthetic snapshot has no live baseline to drift against.
   */
  private statsBaseline?: StatsBaseline;
  /** Guards against a second drift dump starting while one is in flight. */
  private refreshingStats = false;
  /** When the in-flight refresh started, so a wedged one can say how long. */
  private refreshingSince?: number;
  /**
   * The last reason a poll declined to refresh, and when it was reported.
   *
   * The check runs every 60s and almost always declines, so reporting each one
   * would bury the log. Reporting only changes would hide a steady state from
   * any window that opens after it settled, which is exactly the position a
   * five-day statistics gap left us in. Both, then: on change, and on a slow
   * heartbeat.
   */
  private lastSkippedRefresh?: { reason: string; loggedAt: number };
  private static readonly SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
  /**
   * When this analyzer last pushed a dump, for the daily floor. A drift-
   * triggered push updates it too, so the two triggers can't dump twice in
   * quick succession.
   */
  private lastStatsPushAt?: number;
  /** Earliest time a failed refresh may be retried. See {@link Remote.STATS_RETRY_BACKOFF_MS}. */
  private retryStatsAfter?: number;
  private static readonly STATS_RETRY_BACKOFF_MS = 15 * 60 * 1000;
  private pgStatStatementsStatus: PgStatStatementsStatus =
    PgStatStatementsStatus.Unknown;

  constructor(
    /** This has to be a local url. Very bad things will happen if this is a remote URL */
    targetURL: Connectable,
    private readonly manager: ConnectionManager,
    /** The manager for ONLY the source db connections */
    private readonly sourceManager: ConnectionManager = ConnectionManager
      .forRemoteDatabase(),
    private readonly options: { disableQueryLoader: boolean } = { disableQueryLoader: false },
    initialSourceDb?: Connectable,
  ) {
    super();
    this.baseDbURL = targetURL.withDatabaseName(Remote.baseDbName);
    this.optimizingDbUDRL = targetURL.withDatabaseName(
      Remote.defaultOptimizingDbPrefix,
    );
    this.optimizer = new QueryOptimizer(manager, this.optimizingDbUDRL);
    this.optimizer.on("error", (error, query) => this.emit("queryError", error, query));
    if (initialSourceDb) {
      this.lastSourceDb = initialSourceDb;
    }
  }

  async resync(): Promise<ReturnType<Remote["syncFrom"]>> {
    if (!this.lastSourceDb) {
      throw new Error("No source database has been synced yet");
    }
    return this.syncFrom(this.lastSourceDb, { type: "pullFromSource" });
  }

  async syncFrom(
    source: Connectable,
    statsStrategy: StatisticsStrategy = { type: "pullFromSource" },
    options?: {
      events?: {
        onGetQueries?: (queryCount: number) => void;
        onDatabaseInfo?: (info: string) => void;
      }
    }
  ): Promise<
    {
      meta: { version?: string; inferredStatsStrategy?: InferredStatsStrategy };
      schema: RemoteSyncFullSchemaResponse;
      recentQueriesError?: {
        type: "extension_not_installed";
        extensionName: string;
      };
    }
  > {
    this.lastSourceDb = source;
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
        this.getRecentQueries(source).then(r => {
          options?.events?.onGetQueries?.(r.length)
          return r;
        }),
        this.getFullSchema(source),
        this.getDatabaseInfo(source).then(r => {
          options?.events?.onDatabaseInfo?.(r.serverVersion)
          return r;
        }),
      ]);

    if (restoreResult.status === "rejected") {
      throw new Error(`Schema sync failed: ${restoreResult.reason}`);
    }

    if (fullSchema.status === "fulfilled") {
      this.schemaLoader?.update(fullSchema.value);
      this.emit("schemaSynced", fullSchema.value);
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
    let recentQueriesError: {
      type: "extension_not_installed";
      extensionName: string;
    } | undefined;
    if (recentQueries.status === "fulfilled") {
      queries = recentQueries.value;
    } else if (recentQueries.reason instanceof ExtensionNotInstalledError) {
      recentQueriesError = {
        type: "extension_not_installed",
        extensionName: recentQueries.reason.extensionNames[0],
      };
      this.emit("extensionPresenceChanged", { type: "missing" });
    }

    await this.onSuccessfulSync(
      pg,
      source,
      queries,
      statsResult.mode,
      fullSchema.status === "fulfilled" ? fullSchema.value : undefined,
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
      recentQueriesError,
    };
  }

  getLatestSchema(): FullSchema | undefined {
    return this.schemaLoader?.getLatestSchema();
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

    return {
      queries,
      diffs,
      disabledIndexes,
      pgStatStatementsNotInstalled:
        this.pgStatStatementsStatus === PgStatStatementsStatus.NotInstalled,
    };
  }

  /**
   * Runs a single poll of pg_stat_statements if
   * there isn't already an in-flight request
   */
  async pollQueriesOnce() {
    if (this.queryLoader && !this.isPolling && !this.options.disableQueryLoader) {
      try {
        this.isPolling = true;
        await this.queryLoader.poll();
      } finally {
        this.isPolling = false;
      }
    }
  }

  private generationDbName(generation: number): PgIdentifier {
    return generation === 0
      ? Remote.defaultOptimizingDbPrefix
      : PgIdentifier.fromString(`${Remote.optimizingDbPrefix}_${generation}`);
  }

  private async resetDatabase(): Promise<void> {
    const prevGeneration = this.generation;
    const nextGeneration = prevGeneration + 1;
    const nextDbName = this.generationDbName(nextGeneration);
    log.info(`Creating new generation database: ${nextDbName}`, "remote");
    const baseDb = this.manager.getOrCreateConnection(this.baseDbURL);
    try {
      await baseDb.exec(`create database ${nextDbName};`);
    } catch (err) {
      // it's ok if the db already exists (previously crashed)
    }
    const prevDbName = this.generationDbName(prevGeneration);
    const prevOptimizingDb = this.optimizingDbUDRL;
    this.generation = nextGeneration;
    this.optimizingDbUDRL = this.optimizingDbUDRL.withDatabaseName(nextDbName);
    this.optimizer.updateConnectable(this.optimizingDbUDRL);
    await this.optimizer.drain();
    await this.manager.close(prevOptimizingDb);
    // these cannot be run in the same `exec` block as that implicitly creates transactions
    await baseDb.exec(
      `drop database if exists ${prevDbName};`,
    );
  }

  private async pipeSchema(
    target: Connectable,
    source: Connectable,
  ): Promise<void> {
    const dump = DumpCommand.spawn(source, "native-postgres");
    // Keep what these emit, not just forward it. The listeners below reach a
    // websocket the live UI subscribes to, and CI has no such subscriber — so
    // a failed CI restore reported an exit code while pg_restore had already
    // named the extension or collation it could not create.
    const dumpOutput: string[] = [];
    const restoreOutput: string[] = [];
    dump.on("dump", (data) => {
      dumpOutput.push(data);
      this.emit("dumpLog", data);
    });
    dump.on("restore", (data) => {
      restoreOutput.push(data);
      this.emit("restoreLog", data);
    });

    const restore = RestoreCommand.spawn(target);
    const { dump: dumpResult, restore: restoreResult } = await dump.pipeTo(
      restore,
    );
    if (!dumpResult.status.success) {
      throw new Error(
        describeCommandFailure("pg_dump", dumpResult.status.code, dumpOutput),
      );
    }
    if (restoreResult && !restoreResult.status.success) {
      throw new Error(
        describeCommandFailure(
          "pg_restore",
          restoreResult.status.code,
          restoreOutput,
        ),
      );
    }
  }

  private async resolveStatistics(
    source: Connectable,
    strategy: StatisticsStrategy,
    tables: FullSchemaTable[],
  ): Promise<StatsResult> {
    if (strategy.type === "static") {
      // Static strategy doesn't go through inference
      return { mode: strategy.stats, strategy: "fromSource" };
    }
    return this.decideStatsStrategy(source, tables);
  }

  private async decideStatsStrategy(
    source: Connectable,
    tables: FullSchemaTable[],
  ): Promise<StatsResult> {
    const connector = this.sourceManager.getConnectorFor(source);
    const totalRows = await connector.getTotalRowCount(tables);

    if (totalRows < Remote.STATS_ROWS_THRESHOLD) {
      log.info(
        `Total rows (${totalRows}) below threshold, using default stats`,
        "remote",
      );
      return { mode: Statistics.defaultStatsMode, strategy: "default" };
    }

    log.info(
      `Total rows (${totalRows}) above threshold, pulling source stats`,
      "remote",
    );
    return { mode: await this.dumpSourceStats(source), strategy: "fromSource" };
  }

  /**
   * Re-dump and push the source's statistics when they've drifted far enough
   * from what we last pushed (ADR 0007 §2). Runs on the schema poll tick.
   *
   * No-ops until a `fromSource` dump has established a baseline: a synthetic or
   * imported snapshot has nothing meaningful to drift against, and inventing a
   * baseline for it would push someone else's numbers as this project's
   * production statistics.
   */
  private async refreshStatsIfStale(source: Connectable): Promise<void> {
    if (!this.statsBaseline) {
      this.noteSkippedRefresh(
        "no drift baseline, so nothing can trigger a dump",
      );
      return;
    }
    if (this.refreshingStats) {
      this.noteSkippedRefresh(
        `a refresh has been in flight for ${
          since(this.refreshingSince)
        }; nothing else can start while it is`,
      );
      return;
    }
    // Back off after a failure. `lastStatsPushAt` only advances on success, so
    // without this a dump that keeps throwing (a statement_timeout on a large
    // pg_statistic read, say) would be retried on every 60s poll.
    if (this.retryStatsAfter !== undefined && Date.now() < this.retryStatsAfter) {
      this.noteSkippedRefresh(
        `backed off for another ${
          duration(this.retryStatsAfter - Date.now())
        } after a failed refresh`,
      );
      return;
    }
    const connector = this.sourceManager.getConnectorFor(source);
    const reltuples = await connector.getReltuplesByTable();
    const verdict = detectDrift(this.statsBaseline, { reltuples });
    const now = Date.now();
    const pastFloor = isPastRefreshFloor(this.lastStatsPushAt, now);
    if (!verdict.drifted && !pastFloor) {
      // The near-miss matters: a table sitting just under the ratio means the
      // threshold is what is holding the refresh back, not a quiet database.
      const closest = verdict.closest
        ? `closest was ${verdict.closest.table} at ${
          Math.round(verdict.closest.ratio * 100)
        }% of ${Math.round(DEFAULT_SIZE_DRIFT_RATIO * 100)}%`
        : "no table was eligible";
      this.noteSkippedRefresh(
        `no drift (${closest}), and ${
          this.lastStatsPushAt === undefined
            ? "the daily floor is unarmed"
            : `${
              duration(DEFAULT_REFRESH_FLOOR_MS - (now - this.lastStatsPushAt))
            } until the daily floor`
        }`,
      );
      return;
    }

    this.refreshingSince = Date.now();
    this.refreshingStats = true;
    try {
      log.info(
        verdict.drifted
          ? `${verdict.kind === "shape" ? "Shape" : "Size"} Drift — ${verdict.reason}. Re-dumping production statistics`
          : "Production statistics are past the daily floor. Re-dumping",
        "remote",
      );
      // applyStatistics records the new baseline and emits `statsApplied`,
      // which is what carries the dump back to the server.
      await this.applyStatistics(await this.dumpSourceStats(source));
      this.retryStatsAfter = undefined;
    } catch (error) {
      this.retryStatsAfter = Date.now() + Remote.STATS_RETRY_BACKOFF_MS;
      throw error;
    } finally {
      this.refreshingStats = false;
    }
  }

  /**
   * Reports why a poll declined to refresh the statistics.
   *
   * Every early return above used to be silent, so a project that had not
   * captured statistics for days looked identical in the logs to one that
   * refreshed on schedule.
   */
  private noteSkippedRefresh(reason: string): void {
    const now = Date.now();
    const last = this.lastSkippedRefresh;
    if (
      last && last.reason === reason &&
      now - last.loggedAt < Remote.SKIP_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastSkippedRefresh = { reason, loggedAt: now };
    log.info(`Statistics refresh skipped: ${reason}`, "remote");
  }

  private async dumpSourceStats(source: Connectable): Promise<StatisticsMode> {
    const pg = this.sourceManager.getOrCreateConnection(
      source,
    );
    const stats = await Statistics.dumpStats(
      pg,
      PostgresVersion.parse("17"),
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
    const connector = this.sourceManager.getOrCreateConnection(source);
    return dumpSchema(connector);
  }

  private getDatabaseInfo(source: Connectable) {
    const connector = this.sourceManager.getConnectorFor(source);
    return connector.getDatabaseInfo();
  }

  /**
   * Adopt the server's stored snapshot as the drift baseline, without pushing.
   *
   * Drift is measured against the last dump this process pushed, so an analyzer
   * that has never pushed has no baseline and never drifts — which is every
   * project whose snapshot was seeded by hand. Seeding on connect closes that
   * gap: the first schema poll can then compare the live schema against what
   * the server holds and re-dump if it has fallen behind.
   *
   * Deliberately does not push. These numbers came from the server; echoing
   * them back would republish a stale snapshot as if it were fresh.
   *
   * Ignored once a baseline exists, so a reconnect can't discard a fresher
   * local one in favour of the server's older copy.
   */
  seedStatsBaseline(stats: ExportedStats[]): void {
    if (this.statsBaseline || stats.length === 0) {
      return;
    }
    this.statsBaseline = baselineFromDump(stats);
    // Arm the daily floor too. The sync path reaches the optimizer directly
    // rather than through `applyStatistics`, so without this `lastStatsPushAt`
    // stays undefined and the floor never fires for a seeded analyzer — which
    // is every analyzer that hasn't happened to drift. Dated from now rather
    // than the snapshot's capture time, which the RPC doesn't carry: the floor
    // then fires 24h after connect instead of immediately.
    this.lastStatsPushAt = Date.now();
  }

  async applyStatistics(statsMode: StatisticsMode): Promise<void> {
    await this.optimizer.setStatistics(statsMode);
    // Push the statistics we were handed, not `optimizer.ownMetadata`. That is
    // a dump of the *optimizing* database, which is restored with
    // `--exclude-table-data-and-children` and never durably analyzed, so every
    // table in it reports `reltuples = -1` and every column `stats: null`.
    // Sending it would overwrite the project's real snapshot with an empty one.
    //
    // `fromAssumption` carries no real numbers at all, so it pushes nothing —
    // synthetic defaults are not this project's production statistics.
    if (statsMode.kind === "fromStatisticsExport" && statsMode.stats.length > 0) {
      this.statsBaseline = baselineFromDump(statsMode.stats);
      this.lastStatsPushAt = Date.now();
      this.emit("statsApplied", statsMode.stats);
    }
    // don't block the reply by awaiting all optimizations
    this.optimizer.restart();
  }

  async resetPgStatStatements(source: Connectable): Promise<void> {
    const connector = this.sourceManager.getConnectorFor(source);
    await connector.resetPgStatStatements();
    this.optimizer.restart({ clearQueries: true });
  }

  async installPgStatStatements(source: Connectable): Promise<{ preloadUpdated: boolean }> {
    const connector = this.sourceManager.getConnectorFor(source);
    return connector.installPgStatStatements();
  }

  /**
   * Process a successful sync and run any potential cleanup functions
   */
  private async onSuccessfulSync(
    postgres: Postgres,
    source: Connectable,
    recentQueries: RecentQuery[],
    stats?: StatisticsMode,
    schema?: FullSchema,
  ): Promise<void> {
    if (source.isSupabase()) {
      // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
      await postgres.exec("drop schema if exists extensions cascade");
    }
    this.startQueryLoader(source);
    this.optimizer.start(recentQueries, stats, schema);
  }

  private startQueryLoader(source: Connectable) {
    if (this.queryLoader) {
      this.queryLoader.stop();
    }
    if (this.schemaLoader) {
      this.schemaLoader.stop();
    }
    this.queryLoader = new QueryLoader(this.sourceManager, source);
    this.schemaLoader = new SchemaLoader(this.sourceManager, source);
    this.schemaLoader.on("diff", (diffs, schema) => {
      this.emit("schemaDiffed", diffs, schema);
    });
    // The schema poll is also the drift tick: it already runs every 60s, so
    // checking here costs one `pg_class` read and no extra schedule.
    this.schemaLoader.on("polled", () => {
      this.refreshStatsIfStale(source).catch((error) => {
        log.error("Failed to check statistics drift", "remote");
        console.error(error);
      });
    });
    this.schemaLoader.on("pollError", (error) => {
      log.error("Failed to poll schema", "remote");
      console.error(error);
    });
    this.schemaLoader.on("exit", () => {
      log.error("Schema loader exited", "remote");
      this.schemaLoader = undefined;
    });
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
      this.pgStatStatementsStatus = PgStatStatementsStatus.Installed;
      this.emit("extensionPresenceChanged", { type: "present", extensionName: "pg_stat_statements", needsRestart: false });
      this.emit("queriesPolled", queries);
    }).on("pgStatStatementsNotInstalled", () => {
      this.pgStatStatementsStatus = PgStatStatementsStatus.NotInstalled;
      this.emit("extensionPresenceChanged", { type: "missing" });
    });
    this.queryLoader.on("exit", () => {
      log.error("Query loader exited", "remote");
      this.queryLoader = undefined;
    });
    if (!this.options.disableQueryLoader) {
      this.queryLoader.start();
      this.schemaLoader.start();
    }
  }

  async cleanup(): Promise<void> {
    this.queryLoader?.stop();
    this.schemaLoader?.stop();
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

export type InferredStatsStrategy = "default" | "fromSource" | "imported";

type StatsResult = {
  mode: StatisticsMode;
  strategy: InferredStatsStrategy;
};

const PgStatStatementsStatus = {
  Installed: "Installed",
  NotInstalled: "Not Installed",
  Unknown: "Unknown",
} as const;

type PgStatStatementsStatus =
  typeof PgStatStatementsStatus[keyof typeof PgStatStatementsStatus];

/** Rounded to the largest unit that still reads as a number, for log lines. */
function duration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function since(startedAt: number | undefined): string {
  return startedAt === undefined ? "an unknown time" : duration(Date.now() - startedAt);
}
