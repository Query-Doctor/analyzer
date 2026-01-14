import * as core from "@actions/core";
import * as prettier from "prettier";
import prettierPluginSql from "prettier-plugin-sql";
import csv from "fast-csv";
import { Readable } from "node:stream";
import { fingerprint } from "@libpg-query/parser";
import { preprocessEncodedJson } from "./sql/json.ts";
import {
  Analyzer,
  ExportedStats,
  IndexedTable,
  IndexOptimizer,
  OptimizeResult,
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
import { bgBrightMagenta, blue, yellow } from "@std/fmt/colors";
import { env } from "./env.ts";
import { connectToSource } from "./sql/postgresjs.ts";
import { parse } from "@libpg-query/parser";
import { Connectable } from "./sync/connectable.ts";

export class Runner {
  private readonly seenQueries = new Set<number>();
  public readonly queryStats: ReportStatistics = {
    total: 0,
    errored: 0,
    matched: 0,
    optimized: 0,
  };
  constructor(
    private readonly optimizer: IndexOptimizer,
    private readonly existingIndexes: IndexedTable[],
    private readonly stats: Statistics,
    private readonly logPath: string,
    private readonly maxCost?: number,
  ) {}

  static async build(options: {
    postgresUrl: Connectable;
    statisticsPath?: string;
    maxCost?: number;
    logPath: string;
  }) {
    const db = connectToSource(options.postgresUrl);
    const statisticsMode = Runner.decideStatisticsMode(options.statisticsPath);
    const stats = await Statistics.fromPostgres(db, statisticsMode);
    const existingIndexes = await stats.getExistingIndexes();
    const optimizer = new IndexOptimizer(db, stats, existingIndexes);
    return new Runner(
      optimizer,
      existingIndexes,
      stats,
      options.logPath,
      options.maxCost,
    );
  }

  async run() {
    const startDate = new Date();
    const logSize = Deno.statSync(this.logPath).size;
    console.log(`logPath=${this.logPath},fileSize=${logSize}`);
    const args = [
      "--dump-raw-csv",
      "--no-progressbar",
      "-f",
      "stderr",
      this.logPath,
    ];
    const command = new Deno.Command("pgbadger", {
      stdout: "piped",
      stderr: "piped",
      args,
    });
    console.log(`pgbadger ${args.join(" ")}`);
    const output = command.spawn();
    output.stderr.pipeTo(Deno.stderr.writable);
    let error: Error | undefined;
    const stream = csv
      .parseStream(Readable.from(output.stdout), {
        headers: false,
      })
      .on("error", (err) => {
        error = err;
      });

    const recommendations: ReportIndexRecommendation[] = [];
    const queriesPastThreshold: ReportQueryCostWarning[] = [];

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
        case "invalid":
          break;
      }
    }
    await output.status;
    console.log(
      `Matched ${this.queryStats.matched} queries out of ${this.queryStats.total}`,
    );
    const reporter = new GithubReporter(env.GITHUB_TOKEN);
    const statistics = deriveIndexStatistics(recommendations);
    const timeElapsed = Date.now() - startDate.getTime();
    console.log(`Generating report (${reporter.provider()})`);
    const reportContext: ReportContext = {
      statisticsMode: this.stats.mode,
      recommendations,
      queriesPastThreshold,
      queryStats: Object.freeze(this.queryStats),
      statistics,
      error,
      metadata: { logSize, timeElapsed },
    };
    await reporter.report(reportContext);
    console.timeEnd("total");
    return reportContext;
  }

  async processQuery(log: ExplainedLog): Promise<QueryProcessResult> {
    this.queryStats.total++;
    const { query } = log;
    const queryFingerprint = await fingerprint(query);
    const fingerprintNum = parseInt(queryFingerprint, 16);
    if (log.isIntrospection) {
      if (env.DEBUG) {
        console.log("Skipping introspection query", fingerprintNum);
      }
      return { kind: "invalid" };
    }
    if (this.seenQueries.has(fingerprintNum)) {
      if (env.DEBUG) {
        console.log("Skipping duplicate query", fingerprintNum);
      }
      return { kind: "invalid" };
    }
    this.seenQueries.add(fingerprintNum);

    const analyzer = new Analyzer(parse);
    const formattedQuery = await this.formatQuery(query);
    const { indexesToCheck, ansiHighlightedQuery, referencedTables } =
      await analyzer.analyze(formattedQuery);

    const selectsCatalog = referencedTables.find((ref) =>
      ref.table.startsWith("pg_")
    );
    if (selectsCatalog) {
      if (env.DEBUG) {
        console.log(
          "Skipping query that selects from catalog tables",
          selectsCatalog,
          fingerprintNum,
        );
      }
      return { kind: "invalid" };
    }
    const indexCandidates = analyzer.deriveIndexes(
      this.stats.ownMetadata,
      indexesToCheck,
    );
    if (indexCandidates.length === 0) {
      if (env.DEBUG) {
        console.log(ansiHighlightedQuery);
        console.log("No index candidates found", fingerprintNum);
      }
      if (typeof this.maxCost === "number" && log.plan.cost > this.maxCost) {
        return {
          kind: "cost_past_threshold",
          warning: {
            fingerprint: fingerprintNum,
            formattedQuery,
            baseCost: log.plan.cost,
            explainPlan: log.plan.json,
            maxCost: this.maxCost,
          },
        };
      }
    }
    return core.group<QueryProcessResult>(
      `query:${fingerprintNum}`,
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
          return { kind: "error", error: err as Error };
        }
        if (out.kind === "ok") {
          const existingIndexesForQuery = Array.from(out.existingIndexes)
            .map((index) => {
              const existing = this.existingIndexes.find(
                (e) => e.index_name === index,
              );
              if (existing) {
                return `${existing.schema_name}.${existing.table_name}(${
                  existing.index_columns
                    .map((c) => `"${c.name}" ${c.order}`)
                    .join(", ")
                })`;
              }
            })
            .filter((i) => i !== undefined);
          if (out.newIndexes.size > 0) {
            this.queryStats.optimized++;
            const newIndexes = Array.from(out.newIndexes)
              .map((n) => out.triedIndexes.get(n)?.definition)
              .filter((n) => n !== undefined);
            console.log(`New indexes: ${newIndexes.join(", ")}`);
            return {
              kind: "recommendation",
              recommendation: {
                fingerprint: fingerprintNum,
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
                warning: {
                  fingerprint: fingerprintNum,
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
            return { kind: "invalid" };
          }
        } else if (out.kind === "zero_cost_plan") {
          console.log("Zero cost plan found");
          console.log(out);
          console.timeEnd(`timing`);
          return {
            kind: "zero_cost_plan",
            explainPlan: out.explainPlan,
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
    const data = Deno.readFileSync(path);
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
    warning: ReportQueryCostWarning;
  }
  | {
    kind: "recommendation";
    recommendation: ReportIndexRecommendation;
  }
  | {
    kind: "error";
    error: Error;
  }
  | {
    kind: "zero_cost_plan";
    explainPlan: object;
  };
