import EventEmitter from "node:events";
import { OptimizedQuery, QueryHash, RecentQuery } from "../sql/recent-query.ts";
import type { LiveQueryOptimization } from "./optimization.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Sema } from "async-sema";
import {
  Analyzer,
  dropIndex,
  IndexedTable,
  IndexOptimizer,
  IndexRecommendation,
  OptimizeResult,
  PgIdentifier,
  PostgresExplainStage,
  PostgresQueryBuilder,
  PostgresTransaction,
  PostgresVersion,
  Statistics,
  StatisticsMode,
} from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { parse } from "@libpg-query/parser";
import { DisabledIndexes } from "./disabled-indexes.ts";

const MINIMUM_COST_CHANGE_PERCENTAGE = 5;
const QUERY_TIMEOUT_MS = 10000;

type EventMap = {
  error: [Error, OptimizedQuery];
  timeout: [OptimizedQuery, number];
  zeroCostPlan: [OptimizedQuery];
  noImprovements: [OptimizedQuery];
  improvementsAvailable: [OptimizedQuery];
  vacuumStart: [];
  vacuumEnd: [];
};

type Target = {
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
  private readonly disabledIndexes = new DisabledIndexes();

  private target?: Target;
  private semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
  private _finish = Promise.withResolvers();

  private _validQueriesProcessed = 0;
  private _invalidQueries = 0;
  private _allQueries = 0;
  private running = false;

  private queriedSinceVacuum = 0;
  private static readonly vacuumThreshold = 5;
  static MAX_RETRIES = 3;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly connectable: Connectable,
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

  /**
   * This getter has to be evaluated immediately before
   * calling `await` on it. The underlying promise is
   * reassigned after new work gets queued and may be stale.
   */
  get finish() {
    return this._finish.promise;
  }

  getDisabledIndexes(): PgIdentifier[] {
    return [...this.disabledIndexes];
  }

  /**
   * Start optimizing a new set of queries
   * @returns Promise of array of queries that were considered for optimization.
   * Resolves when all queries are optimized
   */
  async start(
    allRecentQueries: RecentQuery[],
    statsMode: StatisticsMode = QueryOptimizer.defaultStatistics,
  ): Promise<OptimizedQuery[]> {
    this.stop();
    const validQueries = this.appendQueries(allRecentQueries);
    const version = PostgresVersion.parse("17");
    const pg = this.manager.getOrCreateConnection(this.connectable);
    const ownStats = await Statistics.dumpStats(pg, version, "full");
    const statistics = new Statistics(
      pg,
      version,
      ownStats,
      statsMode,
    );
    const existingIndexes = await statistics.getExistingIndexes();
    const filteredIndexes = this.filterDisabledIndexes(existingIndexes);
    const optimizer = new IndexOptimizer(pg, statistics, filteredIndexes, {
      trace: false,
    });
    this.target = { optimizer, statistics };

    this._allQueries = this.queries.size;
    await this.work();
    return validQueries;
  }

  stop() {
    this.semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
    this.queries.clear();
    this.target = undefined;
    this._finish = Promise.withResolvers();
    this._allQueries = 0;
    this._invalidQueries = 0;
    this._validQueriesProcessed = 0;
  }

  async restart({ clearQueries } = { clearQueries: false }) {
    this.semaphore = new Sema(QueryOptimizer.MAX_CONCURRENCY);
    if (clearQueries) {
      this.queries.clear();
    } else {
      this.resetQueryOptimizationState();
    }
    this._finish = Promise.withResolvers();
    this._invalidQueries = 0;
    this._validQueriesProcessed = 0;
    if (this.target) {
      // update the indexes the optimizer knows about
      // to exclude the disabled ones
      this.target.optimizer.transformIndexes((indexes) =>
        this.filterDisabledIndexes(indexes)
      );
    }
    await this.work();
  }

  toggleIndex(identifier: PgIdentifier): boolean {
    const disabled = this.disabledIndexes.toggle(identifier);
    // TODO: Instead of blindly restarting the query optimizer
    // we should introspect the index and only reset the queries
    // that touch the table the index is defined on
    this.restart();
    return disabled;
  }

  /**
   * Insert new queries to be processed. The {@link start} method must
   * have been called previously for this to take effect
   */
  async addQueries(queries: RecentQuery[]) {
    this.appendQueries(queries);
    await this.work();
  }

  private resetQueryOptimizationState() {
    for (const [hash, query] of this.queries) {
      const status = this.checkQueryUnsupported(query);
      let optimization: LiveQueryOptimization;
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
      this.queries.set(
        hash,
        query.withOptimization(optimization),
      );
    }
    this._allQueries = this.queries.size;
  }

  private appendQueries(queries: RecentQuery[]): OptimizedQuery[] {
    const validQueries: OptimizedQuery[] = [];
    for (const query of queries) {
      const existingOptimization = this.queries.get(query.hash);
      if (existingOptimization) {
        validQueries.push(existingOptimization);
        continue;
      }
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
      if (!existingOptimization) {
        this.queries.set(query.hash, optimized);
      }
    }
    return validQueries;
  }

  private async work() {
    if (!this.target) {
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (true) {
        let optimized: OptimizedQuery | undefined;
        const token = await this.semaphore.acquire();
        try {
          optimized = this.findAndMarkFirstQueryWhere((entry) =>
            entry.optimization.state === "waiting"
          );
          // if nothing is in queue, start working through timed-out queries
          if (!optimized) {
            optimized = this.findAndMarkFirstQueryWhere((entry) =>
              entry.optimization.state === "timeout" &&
              this.isEligibleForTimeoutRetry(entry)
            );
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
        this.queriedSinceVacuum++;
        if (this.queriedSinceVacuum > QueryOptimizer.vacuumThreshold) {
          await this.vacuum();
          this.queriedSinceVacuum = 0;
        }

        this.queries.set(
          optimized.hash,
          optimized.withOptimization(optimization),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private isEligibleForTimeoutRetry(
    entry: OptimizedQuery,
  ): boolean {
    if (entry.optimization.state !== "timeout") {
      return false;
    }
    return entry.optimization.retries < QueryOptimizer.MAX_RETRIES;
  }

  /**
   * Gets the status of the current queries in the optimizer
   */
  getQueries(): OptimizedQuery[] {
    return Array.from(this.queries.values());
  }

  private findAndMarkFirstQueryWhere(
    filter: (query: OptimizedQuery) => boolean,
  ): OptimizedQuery | undefined {
    for (const [hash, entry] of this.queries.entries()) {
      if (!filter(entry)) {
        continue;
      }
      let retries = 0;
      if (entry.optimization.state === "timeout") {
        retries = entry.optimization.retries;
      }
      this.queries.set(
        hash,
        entry.withOptimization({ state: "optimizing", retries }),
      );
      return entry;
    }
  }

  private async vacuum() {
    const connector = this.manager.getConnectorFor(this.connectable);
    try {
      this.emit("vacuumStart");
      await connector.vacuum();
    } finally {
      this.emit("vacuumEnd");
    }
  }

  private filterDisabledIndexes(indexes: IndexedTable[]): IndexedTable[] {
    return indexes.filter((idx) => {
      const indexName = PgIdentifier.fromString(idx.index_name);
      return !this.disabledIndexes.has(indexName);
    });
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
    let explainPlan: PostgresExplainStage | undefined;
    try {
      const explain = await withTimeout(
        target.optimizer.testQueryWithStats(builder),
        timeoutMs,
      );
      cost = explain.Plan["Total Cost"];
      explainPlan = explain.Plan;
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
      return this.onZeroCostPlan(recent, explainPlan);
    }
    const indexes = this.getPotentialIndexCandidates(
      target.statistics,
      recent,
    );
    let result: OptimizeResult;
    try {
      result = await withTimeout(
        target.optimizer.run(
          builder,
          indexes,
          (tx) => this.dropDisabledIndexes(tx),
        ),
        timeoutMs,
      );
    } catch (error) {
      console.error("Error with optimization", error);
      if (error instanceof TimeoutError) {
        return this.onTimeout(recent, timeoutMs);
      } else if (error instanceof Error) {
        return this.onError(recent, error.message, explainPlan);
      } else {
        return this.onError(recent, "Internal error", explainPlan);
      }
    }

    if (!explainPlan) {
      throw new Error("explainPlan should be defined after baseline run");
    }
    return this.onOptimizeReady(result, recent, explainPlan);
  }

  private async dropDisabledIndexes(tx: PostgresTransaction): Promise<void> {
    for (const indexName of this.disabledIndexes) {
      await dropIndex(tx, indexName);
    }
  }

  private onOptimizeReady(
    result: OptimizeResult,
    recent: OptimizedQuery,
    explainPlan: PostgresExplainStage,
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
          this.onNoImprovements(
            recent,
            result.baseCost,
            indexesUsed,
            explainPlan,
          );
          return {
            state: "no_improvement_found",
            cost: result.baseCost,
            indexesUsed,
            explainPlan,
          };
        } else {
          this.onImprovementsAvailable(recent, result, explainPlan);
          return {
            state: "improvements_available",
            cost: result.baseCost,
            optimizedCost: result.finalCost,
            costReductionPercentage,
            indexRecommendations,
            indexesUsed,
            explainPlan,
            optimizedExplainPlan: result.explainPlan,
          };
        }
      }
      // unlikely to hit if we've already checked the base plan for zero cost
      case "zero_cost_plan":
        return this.onZeroCostPlan(recent, explainPlan);
    }
  }

  private onNoImprovements(
    recent: OptimizedQuery,
    cost: number,
    indexesUsed: string[],
    explainPlan: PostgresExplainStage,
  ) {
    this.emit(
      "noImprovements",
      recent.withOptimization({
        state: "no_improvement_found",
        cost,
        indexesUsed,
        explainPlan,
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
      recent.tableReferences,
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
    explainPlan: PostgresExplainStage,
  ) {
    const optimized = recent.withOptimization(
      this.resultToImprovementsAvailable(result, explainPlan),
    );
    this.emit("improvementsAvailable", optimized);
    this.queries.set(
      optimized.hash,
      optimized,
    );
  }

  private resultToImprovementsAvailable(
    result: Extract<OptimizeResult, { kind: "ok" }>,
    explainPlan: PostgresExplainStage,
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
      explainPlan,
      optimizedExplainPlan: result.explainPlan,
    };
  }

  private onZeroCostPlan(
    recent: OptimizedQuery,
    explainPlan?: PostgresExplainStage,
  ): LiveQueryOptimization {
    this.emit("zeroCostPlan", recent);
    return {
      state: "error",
      error:
        "Query plan had zero cost. You're likely pulling statistics from a source database with a table that has no rows.",
      explainPlan,
    };
  }

  private onError(
    recent: OptimizedQuery,
    errorMessage: string,
    explainPlan?: PostgresExplainStage,
  ): LiveQueryOptimization {
    const error = new Error(errorMessage);
    this.emit("error", error, recent);
    return { state: "error", error: error.message, explainPlan };
  }

  private onTimeout(
    recent: OptimizedQuery,
    waitedMs: number,
  ): LiveQueryOptimization {
    let retries = 0;
    // increment retries if query was already timed out
    if (recent.optimization.state === "timeout") {
      retries = recent.optimization.retries + 1;
    }
    this.emit("timeout", recent, waitedMs);
    return { state: "timeout", waitedMs, retries };
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
