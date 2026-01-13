import EventEmitter from "node:events";
import { OptimizedQuery, QueryHash, RecentQuery } from "../sql/recent-query.ts";
import type { LiveQueryOptimization } from "./optimization.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Sema } from "async-sema";
import {
  Analyzer,
  IndexOptimizer,
  IndexRecommendation,
  OptimizeResult,
  PostgresQueryBuilder,
  PostgresVersion,
  Statistics,
  StatisticsMode,
} from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { parse } from "@libpg-query/parser";

const MINIMUM_COST_CHANGE_PERCENTAGE = 5;
const QUERY_TIMEOUT_MS = 10000;

type EventMap = {
  error: [Error, OptimizedQuery];
  timeout: [OptimizedQuery, number];
  zeroCostPlan: [OptimizedQuery];
  noImprovements: [OptimizedQuery];
  improvementsAvailable: [OptimizedQuery];
};

type Target = {
  connectable: Connectable;
  optimizer: IndexOptimizer;
  statistics: Statistics;
};

export class QueryOptimizer extends EventEmitter<EventMap> {
  private static readonly MAX_CONCURRENCY = 1;
  private static readonly defaultStatistics: StatisticsMode = {
    kind: "fromAssumption",
    relpages: 1,
    reltuples: 10_000,
  };
  private readonly queries = new Map<QueryHash, OptimizedQuery>();
  private target?: Target;
  private semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
  private _finish = Promise.withResolvers();

  private _validQueriesProcessed = 0;
  private _invalidQueries = 0;
  private _allQueries = 0;

  constructor(
    private readonly manager: ConnectionManager,
  ) {
    super();
  }

  get validQueriesProcessed() {
    return this._validQueriesProcessed;
  }

  get invalidQueries() {
    return this._invalidQueries;
  }

  get allQueries() {
    return this._allQueries;
  }

  get finish() {
    return this._finish.promise;
  }

  /**
   * Start optimizing a new set of queries
   * @returns Promise of array of queries that were considered for optimization.
   * Resolves when all queries are optimized
   */
  async start(
    conn: Connectable,
    allRecentQueries: RecentQuery[],
    statsMode: StatisticsMode = QueryOptimizer.defaultStatistics,
  ): Promise<OptimizedQuery[]> {
    this.stop();
    const validQueries: OptimizedQuery[] = [];
    for (const query of allRecentQueries) {
      let optimization: LiveQueryOptimization;
      const status = this.checkQueryUnsupported(query);
      switch (status.type) {
        case "ok":
          optimization = { state: "waiting" };
          break;
        case "not_supported":
          optimization = this.onQueryUnsupported(status.reason);
          break;
        case "ignored":
          continue;
      }
      const optimized = query.withOptimization(optimization);

      validQueries.push(optimized);
      this.queries.set(query.hash, optimized);
    }
    const version = PostgresVersion.parse("17");
    const pg = this.manager.getOrCreateConnection(conn);
    const ownStats = await Statistics.dumpStats(pg, version, "full");
    const statistics = new Statistics(
      pg,
      version,
      ownStats,
      statsMode,
    );
    const existingIndexes = await statistics.getExistingIndexes();
    const optimizer = new IndexOptimizer(pg, statistics, existingIndexes, {
      // we're not running on our pg fork (yet)
      // so traces have to be disabled
      trace: false,
    });
    this.target = { connectable: conn, optimizer, statistics };

    this._allQueries = this.queries.size;
    await this.work();
    return validQueries;
  }

  stop() {
    this.semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
    this.queries.clear();
    this.target = undefined;
    this._allQueries = 0;
    this._finish = Promise.withResolvers();
    this._invalidQueries = 0;
    this._validQueriesProcessed = 0;
  }

  private async work() {
    if (!this.target) {
      return;
    }

    while (true) {
      let optimized: OptimizedQuery | undefined;
      const token = await this.semaphore.acquire();
      try {
        for (const [hash, entry] of this.queries.entries()) {
          if (entry.optimization.state !== "waiting") {
            continue;
          }
          this.queries.set(
            hash,
            entry.withOptimization({ state: "optimizing" }),
          );
          optimized = entry;
          break;
        }
      } finally {
        this.semaphore.release(token);
      }
      if (!optimized) {
        this._finish.resolve(0);
        break;
      }
      this._validQueriesProcessed++;
      const optimization = await this.optimizeQuery(
        optimized,
        this.target,
      );

      this.queries.set(
        optimized.hash,
        optimized.withOptimization(optimization),
      );
    }
  }

  getQueries(): OptimizedQuery[] {
    return Array.from(this.queries.values());
  }

  private checkQueryUnsupported(
    query: RecentQuery,
  ): { type: "ok" } | { type: "ignored" } | {
    type: "not_supported";
    reason: string;
  } {
    if (
      query.isIntrospection || query.isSystemQuery ||
      query.isTargetlessSelectQuery
    ) {
      return { type: "ignored" };
    }
    if (!query.isSelectQuery) {
      return {
        type: "not_supported",
        reason:
          "Only select statements are currently eligible for optimization",
      };
    }
    return { type: "ok" };
  }

  private async optimizeQuery(
    recent: OptimizedQuery,
    target: Target,
    timeoutMs = QUERY_TIMEOUT_MS,
  ): Promise<LiveQueryOptimization> {
    const builder = new PostgresQueryBuilder(recent.query);
    let cost: number;
    try {
      const explain = await withTimeout(
        target.optimizer.testQueryWithStats(builder),
        timeoutMs,
      );
      cost = explain.Plan["Total Cost"];
    } catch (error) {
      console.error("Error with baseline run", error);
      if (error instanceof TimeoutError) {
        return this.onTimeout(recent, timeoutMs);
      } else if (error instanceof Error) {
        return this.onError(recent, error.message);
      } else {
        return this.onError(recent, "Internal error");
      }
    }
    if (cost === 0) {
      return this.onZeroCostPlan(recent);
    }
    const indexes = this.getPotentialIndexCandidates(
      target.statistics,
      recent,
    );
    let result: OptimizeResult;
    try {
      result = await withTimeout(
        target.optimizer.run(builder, indexes),
        timeoutMs,
      );
    } catch (error) {
      console.error("Error with optimization", error);
      if (error instanceof TimeoutError) {
        return this.onTimeout(recent, timeoutMs);
      } else if (error instanceof Error) {
        return this.onError(recent, error.message);
      } else {
        return this.onError(recent, "Internal error");
      }
    }

    return this.onOptimizeReady(result, recent);
  }

  private onOptimizeReady(
    result: OptimizeResult,
    recent: OptimizedQuery,
  ): LiveQueryOptimization {
    switch (result.kind) {
      case "ok": {
        const indexRecommendations = mapIndexRecommandations(result);
        const percentageReduction = costDifferencePercentage(
          result.baseCost,
          result.finalCost,
        );
        const indexesUsed = Array.from(result.existingIndexes);
        const costReductionPercentage = Math.trunc(
          Math.abs(percentageReduction),
        );
        if (costReductionPercentage < MINIMUM_COST_CHANGE_PERCENTAGE) {
          this.onNoImprovements(recent, result.baseCost, indexesUsed);
          return {
            state: "no_improvement_found",
            cost: result.baseCost,
            indexesUsed,
          };
        } else {
          this.onImprovementsAvailable(recent, result);
          return {
            state: "improvements_available",
            cost: result.baseCost,
            optimizedCost: result.finalCost,
            costReductionPercentage,
            indexRecommendations,
            indexesUsed,
          };
        }
      }
      // unlikely to hit if we've already checked the base plan for zero cost
      case "zero_cost_plan":
        return this.onZeroCostPlan(recent);
    }
  }

  private onNoImprovements(
    recent: OptimizedQuery,
    cost: number,
    indexesUsed: string[],
  ) {
    this.emit(
      "noImprovements",
      recent.withOptimization({
        state: "no_improvement_found",
        cost,
        indexesUsed,
      }),
    );
  }

  private getPotentialIndexCandidates(
    statistics: Statistics,
    recent: OptimizedQuery,
  ) {
    const analyzer = new Analyzer(parse);
    return analyzer.deriveIndexes(
      statistics.ownMetadata,
      recent.columnReferences,
    );
  }

  private onQueryUnsupported(reason: string): LiveQueryOptimization {
    this._invalidQueries++;
    return {
      state: "not_supported",
      reason,
    };
  }

  private onImprovementsAvailable(
    recent: OptimizedQuery,
    result: Extract<OptimizeResult, { kind: "ok" }>,
  ) {
    const optimized = recent.withOptimization(
      this.resultToImprovementsAvailable(result),
    );
    this.emit("improvementsAvailable", optimized);
    this.queries.set(
      optimized.hash,
      optimized,
    );
  }

  private resultToImprovementsAvailable(
    result: Extract<OptimizeResult, { kind: "ok" }>,
  ): LiveQueryOptimization {
    const indexesUsed = Array.from(result.existingIndexes);
    const indexRecommendations = Array.from(result.newIndexes)
      .map((n) => result.triedIndexes.get(n))
      .filter((n) => n !== undefined);
    const percentageReduction = costDifferencePercentage(
      result.baseCost,
      result.finalCost,
    );
    const costReductionPercentage = Math.trunc(Math.abs(percentageReduction));
    return {
      state: "improvements_available",
      cost: result.baseCost,
      optimizedCost: result.finalCost,
      costReductionPercentage,
      indexRecommendations,
      indexesUsed,
    };
  }

  private onZeroCostPlan(recent: OptimizedQuery): LiveQueryOptimization {
    this.emit("zeroCostPlan", recent);
    return {
      state: "error",
      error:
        "Query plan had zero cost. You're likely pulling statistics from a source database with a table that has no rows.",
    };
  }

  private onError(
    recent: OptimizedQuery,
    errorMessage: string,
  ): LiveQueryOptimization {
    const error = new Error(errorMessage);
    this.emit("error", error, recent);
    return { state: "error", error: error.message };
  }

  private onTimeout(
    recent: OptimizedQuery,
    waitedMs: number,
  ): LiveQueryOptimization {
    this.emit("timeout", recent, waitedMs);
    return { state: "timeout" };
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("Timeout");
    this.name = "TimeoutError";
  }
}

export const withTimeout = <T>(
  promise: Promise<T>,
  timeout: number,
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new TimeoutError()), timeout)
    ),
  ]);
};

function mapIndexRecommandations(
  result: Extract<OptimizeResult, { kind: "ok" }>,
): IndexRecommendation[] {
  return Array.from(result.newIndexes.keys(), (definition) => {
    const index = result.triedIndexes.get(definition);
    if (!index) {
      throw new Error(
        `Index ${definition} not found in tried indexes. This shouldn't happen.`,
      );
    }
    return index;
  });
}

type PercentageDifference = number;

export function costDifferencePercentage(
  oldVal: number,
  newVal: number,
): PercentageDifference {
  return ((newVal - oldVal) / oldVal) * 100;
}
