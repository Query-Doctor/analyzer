import EventEmitter from "node:events";
import { QueryHash, RecentQuery } from "../sql/recent-query.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Sema } from "async-sema";
import {
  Analyzer,
  IndexOptimizer,
  OptimizeResult,
  PostgresQueryBuilder,
  PostgresVersion,
  Statistics,
  StatisticsMode,
} from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { parse } from "@libpg-query/parser";
import z from "zod";

const MINIMUM_COST_CHANGE_PERCENTAGE = 5;
const QUERY_TIMEOUT_MS = 10000;

type EventMap = {
  error: [Error, RecentQuery];
  timeout: [RecentQuery, number];
  zeroCostPlan: [RecentQuery];
  queryUnsupported: [RecentQuery];
  noImprovements: [RecentQuery, Extract<OptimizeResult, { kind: "ok" }>];
  improvementsAvailable: [RecentQuery, Extract<OptimizeResult, { kind: "ok" }>];
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
  ): Promise<RecentQuery[]> {
    this.stop();
    const validQueries: RecentQuery[] = [];
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
      validQueries.push(query);
      this.queries.set(query.hash, { query, optimization });
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
      let recentQuery: RecentQuery | undefined;
      const token = await this.semaphore.acquire();
      try {
        for (const [hash, entry] of this.queries.entries()) {
          if (entry.optimization.state !== "waiting") {
            continue;
          }
          this.queries.set(hash, {
            query: entry.query,
            optimization: { state: "optimizing" },
          });
          recentQuery = entry.query;
          break;
        }
      } finally {
        this.semaphore.release(token);
      }
      if (!recentQuery) {
        this._finish.resolve(0);
        break;
      }
      this._validQueriesProcessed++;
      const optimization = await this.optimizeQuery(
        recentQuery,
        this.target,
      );

      this.queries.set(recentQuery.hash, {
        query: recentQuery,
        optimization,
      });
    }
  }

  getQueries(): OptimizedQuery[] {
    return Array.from(this.queries.values());
  }

  // private summarizeQueue() {
  //   let waitingQueries = 0;
  //   let optimizingQueries = 0;
  //   let improvementsAvailableQueries = 0;
  //   let noImprovementFoundQueries = 0;
  //   let timeoutQueries = 0;
  //   let errorQueries = 0;
  //   let notSupportedQueries = 0;

  //   for (const [_hash, query] of this.queries.entries()) {
  //     if (query.optimization.state === "waiting") {
  //       waitingQueries++;
  //     } else if (query.optimization.state === "optimizing") {
  //       optimizingQueries++;
  //     } else if (query.optimization.state === "improvements_available") {
  //       improvementsAvailableQueries++;
  //     } else if (query.optimization.state === "no_improvement_found") {
  //       noImprovementFoundQueries++;
  //     } else if (query.optimization.state === "timeout") {
  //       timeoutQueries++;
  //     } else if (query.optimization.state === "error") {
  //       errorQueries++;
  //     } else if (query.optimization.state === "not_supported") {
  //       notSupportedQueries++;
  //     }
  //   }
  //   console.log("============");
  //   console.log(`waiting: ${waitingQueries}`);
  //   console.log(`optimizing: ${optimizingQueries}`);
  //   console.log(`timeout: ${timeoutQueries}`);
  //   console.log(`error: ${errorQueries}`);
  //   console.log(
  //     `improvements: ${improvementsAvailableQueries}`,
  //   );
  //   console.log(`no improvements: ${noImprovementFoundQueries}`);
  //   console.log("============");
  // }

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
    recent: RecentQuery,
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
        QUERY_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        return this.onTimeout(recent, QUERY_TIMEOUT_MS);
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
    recent: RecentQuery,
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
          this.onNoImprovements(recent, result);
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
    recent: RecentQuery,
    result: Extract<OptimizeResult, { kind: "ok" }>,
  ) {
    this.emit("noImprovements", recent, result);
  }

  private getPotentialIndexCandidates(
    statistics: Statistics,
    recent: RecentQuery,
  ) {
    const analyzer = new Analyzer(parse);
    return analyzer.deriveIndexes(
      statistics.ownMetadata,
      recent.columnReferences,
    );
  }

  private onQueryUnsupported(reason: string): LiveQueryOptimization {
    // this.emit("queryUnsupported", recent);
    this._invalidQueries++;
    return {
      state: "not_supported",
      reason,
    };
  }

  private onImprovementsAvailable(
    recent: RecentQuery,
    result: Extract<OptimizeResult, { kind: "ok" }>,
  ) {
    this.emit("improvementsAvailable", recent, result);
    this.queries.set(recent.hash, {
      query: recent,
      optimization: {
        state: "improvements_available",
        cost: result.baseCost,
        optimizedCost: result.finalCost,
        costReductionPercentage: 0,
        indexRecommendations: [],
        indexesUsed: [],
        // costReductionPercentage,
        // indexRecommendations,
        // indexesUsed,
      },
    });
  }

  private onZeroCostPlan(recent: RecentQuery): LiveQueryOptimization {
    this.emit("zeroCostPlan", recent);
    return {
      state: "error",
      error: new Error(
        "Query plan had zero cost. This should not happen on a patched postgres instance",
      ),
    };
  }

  private onError(
    recent: RecentQuery,
    errorMessage: string,
  ): LiveQueryOptimization {
    const error = new Error(errorMessage);
    this.emit("error", error, recent);
    return { state: "error", error };
  }

  private onTimeout(
    recent: RecentQuery,
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
): string[] {
  return Array.from(result.newIndexes.keys(), (definition) => {
    const index = result.triedIndexes.get(definition);
    if (!index) {
      throw new Error(
        `Index ${definition} not found in tried indexes. This shouldn't happen.`,
      );
    }
    return definition;
  });
}

type PercentageDifference = number;

export function costDifferencePercentage(
  oldVal: number,
  newVal: number,
): PercentageDifference {
  return ((newVal - oldVal) / oldVal) * 100;
}

export const LiveQueryOptimization = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("waiting"),
  }),
  z.object({ state: z.literal("optimizing") }),
  z.object({ state: z.literal("not_supported"), reason: z.string() }),
  z.object({
    state: z.literal("improvements_available"),
    cost: z.number(),
    optimizedCost: z.number(),
    costReductionPercentage: z.number(),
    indexRecommendations: z.array(z.string()),
    indexesUsed: z.array(z.string()),
  }),
  z.object({
    state: z.literal("no_improvement_found"),
    cost: z.number(),
    indexesUsed: z.array(z.string()),
  }),
  z.object({ state: z.literal("timeout") }),
  z.object({ state: z.literal("error"), error: z.instanceof(Error) }),
]);

export type LiveQueryOptimization = z.infer<typeof LiveQueryOptimization>;

export const OptimizedQuery = z.object({
  query: z.instanceof(RecentQuery),
  optimization: LiveQueryOptimization,
});

export type OptimizedQuery = z.infer<typeof OptimizedQuery>;
