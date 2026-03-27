import * as core from "@actions/core";
import csv from "fast-csv";
import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fingerprint } from "@libpg-query/parser";
import { preprocessEncodedJson } from "./sql/json.ts";
import { ExplainedLog } from "./sql/pg_log.ts";
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
import { Remote } from "./remote/remote.ts";
import { ConnectionManager } from "./sync/connection-manager.ts";
import { RecentQuery } from "./sql/recent-query.ts";
import { QueryHash } from "./sql/recent-query.ts";
import type { OptimizedQuery } from "./sql/recent-query.ts";

export class Runner {
  constructor(
    private readonly remote: Remote,
    private readonly logPath: string,
    private readonly maxCost?: number,
    private readonly ignoredQueryHashes: Set<string> = new Set(),
  ) { }

  static async build(options: {
    targetPostgresUrl: Connectable;
    sourcePostgresUrl: Connectable;
    statisticsPath?: string;
    maxCost?: number;
    logPath: string;
    ignoredQueryHashes?: string[];
  }) {
    const remote = new Remote(
      options.targetPostgresUrl,
      ConnectionManager.forLocalDatabase(),
    );
    await remote.syncFrom(options.sourcePostgresUrl);
    await remote.optimizer.finish;
    return new Runner(
      remote,
      options.logPath,
      options.maxCost,
      new Set(options.ignoredQueryHashes ?? []),
    );
  }

  async close() {
    await this.remote.cleanup();
  }

  async run(config: AnalyzerConfig = DEFAULT_CONFIG) {
    const startDate = new Date();
    const logSize = statSync(this.logPath).size;
    console.log(`logPath=${this.logPath},fileSize=${logSize}`);
    const args = [
      "--dump-raw-csv",
      "--no-progressbar",
      "-f",
      "stderr",
      this.logPath,
    ];
    console.log(`pgbadger ${args.join(" ")}`);
    const child = spawn("pgbadger", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.pipe(process.stderr);
    let error: Error | undefined;
    const stream = csv
      .parseStream(child.stdout!, {
        headers: false,
      })
      .on("error", (err) => {
        error = err;
      });

    let total = 0;

    console.time("total");
    const recentQueries: RecentQuery[] = [];
    for await (const chunk of stream) {
      const [
        _timestamp,
        _username,
        _dbname,
        _pid,
        _client,
        _sessionid,
        loglevel,
        _sqlstate,
        _duration,
        queryString,
        _parameters,
        _appname,
        _backendtype,
        _queryid,
      ] = chunk as string[];
      if (loglevel !== "LOG" || !queryString.startsWith("plan:")) {
        continue;
      }
      total++;
      const planString: string = queryString.split("plan:")[1].trim();
      const json = preprocessEncodedJson(planString);
      if (!json) {
        console.log("Skipping LOG that is not JSON", queryString);
        continue;
      }
      let parsed: ExplainedLog;
      try {
        parsed = ExplainedLog.fromLog(json);
      } catch (e) {
        console.log(e);
        console.log(
          "Log line that looked like valid auto_explain was not valid json?",
        );
        continue;
      }

      const query = parsed.query;
      const hash = QueryHash.parse(await fingerprint(query));
      if (this.ignoredQueryHashes.has(hash)) {
        continue;
      }
      if (parsed.isIntrospection) {
        continue;
      }

      const recentQuery = await RecentQuery.fromLogEntry(query, hash);
      recentQueries.push(recentQuery)
    }
    await this.remote.optimizer.addQueries(recentQueries);

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    await this.remote.optimizer.finish;

    const optimizedQueries = this.remote.optimizer.getQueries();

    console.log(
      `Matched ${this.remote.optimizer.validQueriesProcessed} queries out of ${total}`,
    );

    const recommendations: ReportIndexRecommendation[] = [];
    const queriesPastThreshold: ReportQueryCostWarning[] = [];
    const allResults: OptimizedQuery[] = [];

    for (const q of optimizedQueries) {
      if (this.ignoredQueryHashes.has(q.hash)) {
        continue;
      }
      allResults.push(q);
      const { optimization } = q;
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
    const filteredThresholdWarnings =
      config.minimumCost > 0
        ? queriesPastThreshold.filter((w) => w.baseCost > config.minimumCost)
        : queriesPastThreshold;

    if (config.minimumCost > 0) {
      const filtered =
        recommendations.length - filteredRecommendations.length +
        (queriesPastThreshold.length - filteredThresholdWarnings.length);
      if (filtered > 0) {
        console.log(
          `Filtered ${filtered} queries below minimumCost=${config.minimumCost} from PR comment`,
        );
      }
    }

    const statistics = deriveIndexStatistics(filteredRecommendations);
    const timeElapsed = Date.now() - startDate.getTime();
    const reportContext: ReportContext = {
      statisticsMode: this.remote.optimizer.statisticsMode,
      recommendations: filteredRecommendations,
      queriesPastThreshold: filteredThresholdWarnings,
      queryStats: Object.freeze({
        total,
        matched: this.remote.optimizer.validQueriesProcessed,
        optimized: filteredRecommendations.length,
        errored: optimizedQueries.filter((q) => q.optimization.state === "error").length,
      }),
      statistics,
      error,
      metadata: { logSize, timeElapsed },
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
