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

const MINIMUM_COST_CHANGE_PERCENTAGE = 5;
const QUERY_TIMEOUT_MS = 10000;

type EventMap = {
  error: [RecentQuery, string];
  timeout: [RecentQuery];
  zeroCostPlan: [RecentQuery];
  noImprovements: [RecentQuery];
  improvementsAvailable: [RecentQuery];
};

type OptimizedQuery = {
  recentQuery: RecentQuery;
  optimization: LiveQueryOptimization;
};

export class QueryOptimizer extends EventEmitter<EventMap> {
  private static readonly MAX_CONCURRENCY = 1;
  private static readonly defaultStatistics: StatisticsMode = {
    kind: "fromAssumption",
    relpages: 1,
    reltuples: 10_000,
  };
  private readonly queries = new Map<QueryHash, OptimizedQuery>();
  private target?: {
    optimizer: IndexOptimizer;
    statistics: Statistics;
  };
  private semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);

  private readonly analyzer = new Analyzer(parse);

  constructor(
    private readonly manager: ConnectionManager,
  ) {
    super();
  }

  async start(
    conn: Connectable,
    recentQueries?: RecentQuery[],
    statsMode: StatisticsMode = QueryOptimizer.defaultStatistics,
  ) {
    this.stop();
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
      // we're not running on the que
      // so traces have to be disabled
      trace: false,
    });
    this.target = {
      optimizer,
      statistics,
    };
    if (recentQueries) {
      for (const query of recentQueries) {
        this.queries.set(query.hash, {
          recentQuery: query,
          optimization: { state: "waiting" },
        });
      }
    }
    for (let i = 0; i < QueryOptimizer.MAX_CONCURRENCY; i++) {
      this.work();
    }
  }

  stop() {
    this.semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
    this.queries.clear();
    this.target = undefined;
  }

  private async work() {
    // don't enter if there isn't enough space in the semaphore
    const token = await this.semaphore.acquire();
    try {
      if (!this.target) {
        return;
      }
      let recentQuery: RecentQuery | undefined;
      for (const [_hash, query] of this.queries.entries()) {
        if (query.optimization.state !== "waiting") {
          continue;
        }
        recentQuery = query.recentQuery;
      }
      if (recentQuery) {
        if (!this.isQuerySupported(recentQuery)) {
          this.onQueryUnsupported(recentQuery);
          return;
        }
        this.queries.set(recentQuery.hash, {
          recentQuery,
          optimization: { state: "optimizing" },
        });
        await this.optimizeQuery(recentQuery);
      }
    } finally {
      this.semaphore.release(token);
      setTimeout(() => this.work(), 100);
    }
  }

  private isQuerySupported(q: RecentQuery) {
    return !q.isSystemQuery && q.isSelectQuery;
  }

  private async optimizeQuery(recent: RecentQuery) {
    if (!this.target) {
      return;
    }
    const builder = new PostgresQueryBuilder(recent.query);
    let cost: number;
    try {
      const explain = await withTimeout(
        this.target.optimizer.runWithoutIndexes(builder),
        QUERY_TIMEOUT_MS,
      );
      cost = explain.Plan["Total Cost"];
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.onTimeout(recent);
      } else if (error instanceof Error) {
        this.onError(recent, error.message);
      } else {
        this.onError(recent, "Internal error");
      }
      return;
    }
    if (cost === 0) {
      this.onZeroCostPlan(recent);
      return;
    }
    const indexes = this.getPotentialIndexCandidates(
      this.target.statistics,
      recent,
    );
    let result: OptimizeResult;
    try {
      result = await withTimeout(
        this.target.optimizer.run(builder, indexes),
        QUERY_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.onTimeout(recent);
      } else if (error instanceof Error) {
        this.onError(recent, error.message);
      } else {
        this.onError(recent, "Internal error");
      }
      return;
    }

    return this.onOptimizeReady(result, recent);
  }

  private onOptimizeReady(result: OptimizeResult, recent: RecentQuery) {
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
          this.emit("noImprovements", recent);
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

  private getPotentialIndexCandidates(
    statistics: Statistics,
    recent: RecentQuery,
  ) {
    return this.analyzer.deriveIndexes(
      statistics.ownMetadata,
      recent.columnReferences,
    );
  }

  private onQueryUnsupported(recent: RecentQuery) {
    this.queries.set(recent.hash, {
      recentQuery: recent,
      optimization: {
        state: "not_supported",
        reason: "Query is not supported",
      },
    });
  }

  private onImprovementsAvailable(
    recent: RecentQuery,
    result: Extract<OptimizeResult, { kind: "ok" }>,
  ) {
    this.queries.set(recent.hash, {
      recentQuery: recent,
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
    this.emit("improvementsAvailable", recent);
  }

  private onZeroCostPlan(recent: RecentQuery) {
    this.queries.set(recent.hash, {
      recentQuery: recent,
      optimization: {
        state: "error",
        error:
          "Query plan had zero cost. This should not happen on a patched postgres instance",
      },
    });
    this.emit("zeroCostPlan", recent);
  }

  private onError(recent: RecentQuery, errorMessage: string) {
    this.queries.set(recent.hash, {
      recentQuery: recent,
      optimization: { state: "error", error: errorMessage },
    });
    this.emit("error", recent, errorMessage);
  }

  private onTimeout(recent: RecentQuery) {
    this.queries.set(recent.hash, {
      recentQuery: recent,
      optimization: { state: "timeout" },
    });
    this.emit("timeout", recent);
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

export type LiveQueryOptimization =
  | { state: "waiting" }
  | { state: "optimizing" }
  // system queries and certain other queries are exempt from optimization
  | { state: "not_supported"; reason: string }
  | {
    state: "improvements_available";
    cost: number;
    optimizedCost: number;
    costReductionPercentage: number;
    indexRecommendations: string[];
    // indexRecommendations: TraceFoundIndex[];
    indexesUsed: string[];
  }
  | {
    state: "no_improvement_found";
    cost: number;
    indexesUsed: string[];
  }
  // Cost is nullable in case the timeout was caused by the initial query
  // before we even add any indexes to it (usually unlikely)
  | { state: "timeout"; cost?: number }
  | { state: "error"; error: string };
