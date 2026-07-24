import * as core from "@actions/core";
import { PgbadgerSource } from "./sql/pgbadger.ts";
import type { RecentQuerySource } from "./sql/recent-query.ts";
import { GithubReporter } from "./reporters/github/github.ts";
import {
  deriveIndexStatistics,
  type ReportContext,
  type ReportIndexRecommendation,
  type ReportQueryCostWarning,
} from "./reporters/reporter.ts";
import { DEFAULT_CONFIG, type AnalyzerConfig } from "./config.ts";
import { env } from "./env.ts";
import { Connectable } from "./sync/connectable.ts";
import { Remote, StatisticsStrategy } from "./remote/remote.ts";
import { ConnectionManager } from "./sync/connection-manager.ts";
import type { OptimizedQuery } from "./sql/recent-query.ts";
import { ExportedStats, Statistics } from "@query-doctor/core";
import { readFile } from "node:fs/promises";
import { buildQueries } from "./reporters/site-api.ts";

export class Runner {
  constructor(
    private readonly remote: Remote,
    private readonly source: RecentQuerySource,
    private readonly maxCost?: number,
    private readonly ignoredQueryHashes: Set<string> = new Set(),
  ) { }

  static async build(options: {
    targetPostgresUrl: Connectable;
    sourcePostgresUrl: Connectable;
    statisticsPath?: string;
    maxCost?: number;
    source: RecentQuerySource;
    ignoredQueryHashes?: string[];
    remote?: Remote;
    // Real production statistics pulled from the Site API. When present, queries
    // are costed against true prod cardinality instead of synthetic assumptions.
    productionStats?: ExportedStats[];
  }) {
    const remote = options.remote ?? new Remote(
      options.targetPostgresUrl,
      ConnectionManager.forLocalDatabase(),
      ConnectionManager.forRemoteDatabase(),
      { disableQueryLoader: true }
    );
    await remote.syncFrom(options.sourcePostgresUrl,
      await Runner.determineStatsMode(options.statisticsPath, options.productionStats)
    );
    await remote.optimizer.finish;
    return new Runner(
      remote,
      options.source,
      options.maxCost,
      new Set(options.ignoredQueryHashes ?? []),
    );
  }

  // Stats-mode precedence for CI: real production stats pulled from the Site API
  // win, then an explicit stats file, then synthetic assumptions. CI never dumps
  // stats from the ephemeral target database itself.
  static async determineStatsMode(
    statsPath?: string,
    productionStats?: ExportedStats[],
  ): Promise<StatisticsStrategy> {
    if (productionStats && productionStats.length > 0) {
      return {
        type: "static",
        stats: Statistics.statsModeFromExport(productionStats),
      };
    }
    if (statsPath) {
      const file = await readFile(statsPath);
      const rawStats = JSON.parse(file.toString())
      const stats = ExportedStats.array().parse(rawStats);
      return {
        type: "static",
        stats: {
          kind: "fromStatisticsExport",
          source: { kind: "path", path: statsPath },
          stats
        }
      }
    }

    return {
      type: "static",
      stats: {
        kind: "fromAssumption",
        reltuples: 10_000_000,
      }
    }
  }

  async close() {
    await this.remote.cleanup();
  }

  async run(config: AnalyzerConfig = DEFAULT_CONFIG) {
    const startDate = new Date();

    console.time("total");
    const recentQueries = await this.source.getRecentQueries();
    const error = this.source instanceof PgbadgerSource
      ? this.source.streamError
      : undefined;
    const totalRows = this.source instanceof PgbadgerSource
      ? this.source.totalRows
      : recentQueries.length;
    await this.remote.optimizer.addQueries(recentQueries);

    await this.remote.optimizer.finish;

    const optimizedQueries = this.remote.optimizer.getQueries();
    const existingIndexes = this.remote.optimizer.getExistingIndexes();

    const resolveIndexNames = (names: string[]) =>
      names.map((name) => {
        const idx = existingIndexes.find((e) => e.indexName.toString() === name);
        return idx
          ? `${idx.schemaName}.${idx.tableName}(${idx.keyColumns.map((c) => `"${c.name}" ${c.order ?? "ASC"}`).join(", ")})`
          : name;
      });

    console.log(
      `Matched ${this.remote.optimizer.validQueriesProcessed} unique queries out of ${totalRows} entries`,
    );

    const recommendations: ReportIndexRecommendation[] = [];
    const queriesPastThreshold: ReportQueryCostWarning[] = [];
    const allResults: OptimizedQuery[] = [];

    for (const q of optimizedQueries) {
      if (this.ignoredQueryHashes.has(q.hash)) {
        continue;
      }
      const { optimization } = q;
      if (
        optimization.state === "improvements_available" ||
        optimization.state === "no_improvement_found"
      ) {
        optimization.indexesUsed = resolveIndexNames(optimization.indexesUsed);
      }
      allResults.push(q);
      if (optimization.state === "improvements_available") {
        recommendations.push({
          fingerprint: q.hash,
          formattedQuery: q.formattedQuery,
          baseCost: optimization.cost,
          baseExplainPlan: optimization.explainPlan,
          optimizedCost: optimization.optimizedCost,
          existingIndexes: optimization.indexesUsed,
          proposedIndexes: optimization.indexRecommendations.map((r) => r.definition),
          explainPlan: optimization.optimizedExplainPlan,
        });
      } else if (
        optimization.state === "no_improvement_found" &&
        typeof this.maxCost === "number" &&
        optimization.cost > this.maxCost
      ) {
        queriesPastThreshold.push({
          fingerprint: q.hash,
          formattedQuery: q.formattedQuery,
          baseCost: optimization.cost,
          explainPlan: optimization.explainPlan,
          maxCost: this.maxCost,
        });
      }
    }

    const filteredRecommendations =
      config.minimumCost > 0
        ? recommendations.filter((r) => r.baseCost > config.minimumCost)
        : recommendations;
    // Kept, not discarded: still shown in the comment (marked below-threshold) so
    // a below-floor query isn't mislabeled "no index suggestion", but excluded
    // from gating and index statistics.
    const belowThresholdRecommendations =
      config.minimumCost > 0
        ? recommendations.filter((r) => r.baseCost <= config.minimumCost)
        : [];
    const filteredThresholdWarnings =
      config.minimumCost > 0
        ? queriesPastThreshold.filter((w) => w.baseCost > config.minimumCost)
        : queriesPastThreshold;

    if (config.minimumCost > 0) {
      const shownNotGated = belowThresholdRecommendations.length;
      const filteredWarnings =
        queriesPastThreshold.length - filteredThresholdWarnings.length;
      if (shownNotGated > 0 || filteredWarnings > 0) {
        console.log(
          `minimumCost=${config.minimumCost}: ${shownNotGated} recommendation(s) shown below threshold (not gated), ${filteredWarnings} cost warning(s) filtered from the PR comment`,
        );
      }
    }

    const analyzed = buildQueries(allResults, config).length;

    const statistics = deriveIndexStatistics(filteredRecommendations);
    const timeElapsed = Date.now() - startDate.getTime();
    const reportContext: ReportContext = {
      statisticsMode: this.remote.optimizer.statisticsMode,
      computedStats: this.remote.optimizer.computedStats,
      recommendations: filteredRecommendations,
      belowThresholdRecommendations,
      queriesPastThreshold: filteredThresholdWarnings,
      queryStats: Object.freeze({
        analyzed,
        matched: this.remote.optimizer.validQueriesProcessed,
        optimized: filteredRecommendations.length,
        errored: optimizedQueries.filter((q) => q.optimization.state === "error").length,
      }),
      statistics,
      error,
      metadata: {
        logSize: this.source instanceof PgbadgerSource ? this.source.logSize : -1,
        timeElapsed,
      },
    };
    console.timeEnd("total");
    return { reportContext, allResults };
  }

  async report(reportContext: ReportContext) {
    const reporter = new GithubReporter(env.GITHUB_TOKEN);
    console.log(`Generating report (${reporter.provider()})`);
    await reporter.report(reportContext);
  }
}

export type QueryProcessResult = OptimizedQuery;
