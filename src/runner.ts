import * as core from "@actions/core";
import * as prettier from "prettier";
import prettierPluginSql from "prettier-plugin-sql";
import csv from "fast-csv";
import { Readable } from "node:stream";
import { statSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fingerprint } from "@libpg-query/parser";
import { preprocessEncodedJson } from "./sql/json.ts";
import {
  Analyzer,
  ExportedStats,
  IndexedTable,
  IndexOptimizer,
  type IndexRecommendation,
  type Nudge,
  type SQLCommenterTag,
  OptimizeResult,
  type Postgres,
  PostgresQueryBuilder,
  Statistics,
  StatisticsMode,
} from "@query-doctor/core";
import { ExplainedLog } from "./sql/pg_log.ts";
import { GithubReporter } from "./reporters/github/github.ts";
import {
  deriveIndexStatistics,
  type ReportContext,
  type ReportIndexRecommendation,
  type ReportQueryCostWarning,
  type ReportStatistics,
} from "./reporters/reporter.ts";
import { DEFAULT_CONFIG, type AnalyzerConfig } from "./config.ts";
const bgBrightMagenta = (s: string) => `\x1b[105m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
import { env } from "./env.ts";
import { connectToSource } from "./sql/postgresjs.ts";
import { parse } from "@libpg-query/parser";
import { Connectable } from "./sync/connectable.ts";

export class Runner {
  private readonly seenQueries = new Set<string>();
  public readonly queryStats: ReportStatistics = {
    total: 0,
    errored: 0,
    matched: 0,
    optimized: 0,
  };
  constructor(
    private readonly db: Postgres,
    private readonly optimizer: IndexOptimizer,
    private readonly existingIndexes: IndexedTable[],
    private readonly stats: Statistics,
    private readonly logPath: string,
    private readonly maxCost?: number,
    private readonly ignoredQueryHashes: Set<string> = new Set(),
  ) { }

  static async build(options: {
    postgresUrl: Connectable;
    statisticsPath?: string;
    maxCost?: number;
    logPath: string;
    ignoredQueryHashes?: string[];
  }) {
    const db = connectToSource(options.postgresUrl);
    const statisticsMode = Runner.decideStatisticsMode(options.statisticsPath);
    const stats = await Statistics.fromPostgres(db, statisticsMode);
    const existingIndexes = await stats.getExistingIndexes();
    const optimizer = new IndexOptimizer(db, stats, existingIndexes);
    return new Runner(
      db,
      optimizer,
      existingIndexes,
      stats,
      options.logPath,
      options.maxCost,
      new Set(options.ignoredQueryHashes ?? []),
    );
  }

  async close() {
    await (this.db as unknown as { close(): Promise<void> }).close();
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

    const recommendations: ReportIndexRecommendation[] = [];
    const queriesPastThreshold: ReportQueryCostWarning[] = [];
    const allResults: QueryProcessResult[] = [];

    console.time("total");
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
      const result = await this.processQuery(parsed);
      if (result.kind !== "invalid") {
        allResults.push(result);
      }
      switch (result.kind) {
        case "error":
          this.queryStats.errored++;
          break;
        case "cost_past_threshold":
          queriesPastThreshold.push(result.warning);
          break;
        case "recommendation":
          recommendations.push(result.recommendation);
          break;
        case "no_improvement":
        case "zero_cost_plan":
        case "invalid":
          break;
      }
    }
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    console.log(
      `Matched ${this.queryStats.matched} queries out of ${this.queryStats.total}`,
    );
    const filteredRecommendations =
      config.minimumCost > 0
        ? recommendations.filter((r) => r.baseCost > config.minimumCost)
        : recommendations;
    const filteredThresholdWarnings =
      config.minimumCost > 0
        ? queriesPastThreshold.filter((w) => w.baseCost > config.minimumCost)
        : queriesPastThreshold;
    const statistics = deriveIndexStatistics(filteredRecommendations);
    const timeElapsed = Date.now() - startDate.getTime();
    if (config.minimumCost > 0) {
      const filtered =
        recommendations.length -
        filteredRecommendations.length +
        (queriesPastThreshold.length - filteredThresholdWarnings.length);
      if (filtered > 0) {
        console.log(
          `Filtered ${filtered} queries below minimumCost=${config.minimumCost} from PR comment`,
        );
      }
    }
    const reportContext: ReportContext = {
      statisticsMode: this.stats.mode,
      recommendations: filteredRecommendations,
      queriesPastThreshold: filteredThresholdWarnings,
      queryStats: Object.freeze(this.queryStats),
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

  async processQuery(log: ExplainedLog): Promise<QueryProcessResult> {
    this.queryStats.total++;
    const { query } = log;
    const queryFingerprint = await fingerprint(query);
    if (this.ignoredQueryHashes.has(queryFingerprint)) {
      if (env.DEBUG) {
        console.log("Skipping ignored query", queryFingerprint);
      }
      return { kind: "invalid" };
    }
    if (log.isIntrospection) {
      if (env.DEBUG) {
        console.log("Skipping introspection query", queryFingerprint);
      }
      return { kind: "invalid" };
    }
    if (this.seenQueries.has(queryFingerprint)) {
      if (env.DEBUG) {
        console.log("Skipping duplicate query", queryFingerprint);
      }
      return { kind: "invalid" };
    }
    this.seenQueries.add(queryFingerprint);

    const analyzer = new Analyzer(parse);
    const formattedQuery = await this.formatQuery(query);
    const { indexesToCheck, ansiHighlightedQuery, referencedTables, nudges, tags } =
      await analyzer.analyze(formattedQuery);

    const selectsCatalog = referencedTables.find((ref) =>
      ref.table.startsWith("pg_"),
    );
    if (selectsCatalog) {
      if (env.DEBUG) {
        console.log(
          "Skipping query that selects from catalog tables",
          selectsCatalog,
          queryFingerprint,
        );
      }
      return { kind: "invalid" };
    }
    const indexCandidates = analyzer.deriveIndexes(
      this.stats.ownMetadata,
      indexesToCheck,
      referencedTables,
    );
    if (indexCandidates.length === 0) {
      if (env.DEBUG) {
        console.log(ansiHighlightedQuery);
        console.log("No index candidates found", queryFingerprint);
      }
      if (typeof this.maxCost === "number" && log.plan.cost > this.maxCost) {
        return {
          kind: "cost_past_threshold",
          rawQuery: query,
          nudges,
          tags,
          warning: {
            fingerprint: queryFingerprint,
            formattedQuery,
            baseCost: log.plan.cost,
            explainPlan: log.plan.json,
            maxCost: this.maxCost,
          },
        };
      }
    }
    return core.group<QueryProcessResult>(
      `query:${queryFingerprint}`,
      async (): Promise<QueryProcessResult> => {
        console.time(`timing`);
        this.printLegend();
        console.log(ansiHighlightedQuery);
        // TODO: give concrete type
        let out: OptimizeResult;
        this.queryStats.matched++;
        try {
          const builder = new PostgresQueryBuilder(query);
          out = await this.optimizer.run(builder, indexCandidates);
        } catch (err) {
          console.error(err);
          console.error(
            `Something went wrong while running this query. Skipping`,
          );
          // this.queryStats.errored++;
          console.timeEnd(`timing`);
          return {
            kind: "error",
            error: err as Error,
            fingerprint: queryFingerprint,
            rawQuery: query,
            formattedQuery,
            nudges,
            tags,
          };
        }
        if (out.kind === "ok") {
          const existingIndexesForQuery = Array.from(out.existingIndexes)
            .map((index) => {
              const existing = this.existingIndexes.find(
                (e) => e.index_name === index,
              );
              if (existing) {
                return `${existing.schema_name}.${existing.table_name}(${existing.index_columns
                  .map((c) => `"${c.name}" ${c.order}`)
                  .join(", ")})`;
              }
            })
            .filter((i) => i !== undefined);
          if (out.newIndexes.size > 0) {
            const costReductionPct = out.baseCost > 0
              ? ((out.baseCost - out.finalCost) / out.baseCost) * 100
              : 0;
            if (Math.round(costReductionPct) <= 0) {
              console.log(
                `Skipping recommendation with ${costReductionPct.toFixed(1)}% cost reduction (rounds to 0%)`,
              );
              console.timeEnd(`timing`);
              return {
                kind: "no_improvement",
                fingerprint: queryFingerprint,
                rawQuery: query,
                formattedQuery,
                cost: out.baseCost,
                existingIndexes: existingIndexesForQuery,
                nudges,
                tags,
                explainPlan: out.baseExplainPlan,
              };
            }
            this.queryStats.optimized++;
            const newIndexRecommendations = Array.from(out.newIndexes)
              .map((n) => out.triedIndexes.get(n))
              .filter((n) => n !== undefined);
            const newIndexes = newIndexRecommendations.map((n) => n.definition);
            console.log(`New indexes: ${newIndexes.join(", ")}`);
            return {
              kind: "recommendation",
              rawQuery: query,
              nudges,
              tags,
              indexRecommendations: newIndexRecommendations,
              recommendation: {
                fingerprint: queryFingerprint,
                formattedQuery,
                baseCost: out.baseCost,
                baseExplainPlan: out.baseExplainPlan,
                optimizedCost: out.finalCost,
                existingIndexes: existingIndexesForQuery,
                proposedIndexes: newIndexes,
                explainPlan: out.explainPlan,
              },
            };
          } else {
            console.log("No new indexes found");
            if (
              typeof this.maxCost === "number" &&
              out.finalCost > this.maxCost
            ) {
              console.log(
                "Query cost is too high",
                out.finalCost,
                this.maxCost,
              );
              return {
                kind: "cost_past_threshold",
                rawQuery: query,
                nudges,
                tags,
                warning: {
                  fingerprint: queryFingerprint,
                  formattedQuery,
                  baseCost: out.baseCost,
                  optimization: {
                    newCost: out.finalCost,
                    existingIndexes: existingIndexesForQuery,
                    proposedIndexes: [],
                  },
                  explainPlan: out.explainPlan,
                  maxCost: this.maxCost,
                },
              };
            }
            return {
              kind: "no_improvement",
              fingerprint: queryFingerprint,
              rawQuery: query,
              formattedQuery,
              cost: out.baseCost,
              existingIndexes: existingIndexesForQuery,
              nudges,
              tags,
              explainPlan: out.baseExplainPlan,
            };
          }
        } else if (out.kind === "zero_cost_plan") {
          console.log("Zero cost plan found");
          console.log(out);
          console.timeEnd(`timing`);
          return {
            kind: "zero_cost_plan",
            explainPlan: out.explainPlan,
            fingerprint: queryFingerprint,
            rawQuery: query,
            formattedQuery,
            nudges,
            tags,
          };
        }
        console.timeEnd(`timing`);
        console.error(out);
        throw new Error(`Unexpected output: ${out}`);
      },
    );
  }

  private async formatQuery(query: string): Promise<string> {
    try {
      return await prettier.format(query, {
        parser: "sql",
        plugins: [prettierPluginSql],
        language: "postgresql",
        keywordCase: "upper",
      });
    } catch {
      return query;
    }
  }

  private printLegend() {
    console.log(`--Legend--------------------------`);
    console.log(`| ${bgBrightMagenta(" column ")} | Candidate            |`);
    console.log(`| ${yellow(" column ")} | Ignored              |`);
    console.log(`| ${blue(" column ")} | Temp table reference |`);
    console.log(`-----------------------------------`);
    console.log();
  }

  private static decideStatisticsMode(path?: string): StatisticsMode {
    if (path) {
      const data = Runner.readStatisticsFile(path);
      return Statistics.statsModeFromExport(data);
    } else {
      return Statistics.defaultStatsMode;
    }
  }
  private static readStatisticsFile(path: string): ExportedStats[] {
    const data = readFileSync(path);
    const json = JSON.parse(new TextDecoder().decode(data));
    return ExportedStats.array().parse(json);
  }
}

export type QueryProcessResult =
  | {
    kind: "invalid";
  }
  | {
    kind: "cost_past_threshold";
    rawQuery: string;
    nudges: Nudge[];
    tags: SQLCommenterTag[];
    warning: ReportQueryCostWarning;
  }
  | {
    kind: "recommendation";
    rawQuery: string;
    nudges: Nudge[];
    tags: SQLCommenterTag[];
    indexRecommendations: IndexRecommendation[];
    recommendation: ReportIndexRecommendation;
  }
  | {
    kind: "no_improvement";
    fingerprint: string;
    rawQuery: string;
    formattedQuery: string;
    cost: number;
    existingIndexes: string[];
    nudges: Nudge[];
    tags: SQLCommenterTag[];
    explainPlan?: object;
  }  | {
    kind: "error";
    error: Error;
    fingerprint: string;
    rawQuery: string;
    formattedQuery: string;
    nudges: Nudge[];
    tags: SQLCommenterTag[];
  }
  | {
    kind: "zero_cost_plan";
    explainPlan: object;
    fingerprint: string;
    rawQuery: string;
    formattedQuery: string;
    nudges: Nudge[];
    tags: SQLCommenterTag[];
  };
