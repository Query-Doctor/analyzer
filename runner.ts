import * as core from "@actions/core";
import { format } from "sql-formatter";
import csv from "fast-csv";
import { Readable } from "node:stream";
import postgres from "postgresjs";
import { fingerprint } from "@libpg-query/parser";
import { Analyzer } from "./analyzer.ts";
import { DEBUG, GITHUB_TOKEN, STATISTICS_PATH } from "./env.ts";
import { preprocessEncodedJson } from "./json.ts";
import { IndexOptimizer } from "./optimizer/genalgo.ts";
import { getPostgresVersion, Statistics } from "./optimizer/statistics.ts";
import { ExplainedLog } from "./pg_log.ts";
import { GithubReporter } from "./reporters/github/github.ts";
import {
  deriveIndexStatistics,
  ReportContext,
  ReportIndexRecommendation,
} from "./reporters/reporter.ts";
import { bgBrightMagenta, blue, green, yellow } from "@std/fmt/colors";

export class Runner {
  constructor(
    private readonly postgresUrl: string,
    private readonly logPath: string,
    private readonly statisticsPath?: string,
  ) {}
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

    const seenQueries = new Set<number>();
    const recommendations: ReportIndexRecommendation[] = [];
    let queryStats: ReportContext["queryStats"] = {
      total: 0,
      matched: 0,
      optimized: 0,
      errored: 0,
    };
    const pg = postgres(this.postgresUrl);
    const pgVersion = await getPostgresVersion(pg);
    const stats = await Statistics.fromPostgres(
      pg,
      pgVersion,
      this.statisticsPath,
    );
    const existingIndexes = await stats.getExistingIndexes();
    const optimizer = new IndexOptimizer(pg, stats, existingIndexes);

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
        parsed = new ExplainedLog(json);
      } catch (e) {
        console.log(e);
        console.log(
          "Log line that looked like valid auto_explain was not valid json?",
        );
        continue;
      }
      queryStats.total++;
      const { query, parameters } = parsed;
      const queryFingerprint = await fingerprint(query);
      const fingerprintNum = parseInt(queryFingerprint, 16);
      if (parsed.isIntrospection) {
        if (DEBUG) {
          console.log("Skipping introspection query", fingerprintNum);
        }
        continue;
      }
      if (seenQueries.has(fingerprintNum)) {
        if (DEBUG) {
          console.log("Skipping duplicate query", fingerprintNum);
        }
        continue;
      }
      seenQueries.add(fingerprintNum);

      const analyzer = new Analyzer();
      const { indexesToCheck, ansiHighlightedQuery, referencedTables } =
        await analyzer.analyze(this.formatQuery(query));

      const selectsCatalog = referencedTables.find((table) =>
        table.startsWith("pg_")
      );
      if (selectsCatalog) {
        if (DEBUG) {
          console.log(
            "Skipping query that selects from catalog tables",
            selectsCatalog,
            fingerprintNum,
          );
        }
        continue;
      }
      const indexCandidates = analyzer.deriveIndexes(
        stats.ownMetadata,
        indexesToCheck,
      );
      if (indexCandidates.length === 0) {
        if (DEBUG) {
          console.log(ansiHighlightedQuery);
          console.log("No index candidates found", fingerprintNum);
        }
        continue;
      }
      await core.group(`query:${fingerprintNum}`, async () => {
        console.time(`timing`);
        this.printLegend();
        console.log(ansiHighlightedQuery);
        // TODO: give concrete type
        let out: Awaited<ReturnType<typeof optimizer.run>>;
        queryStats.matched++;
        try {
          out = await optimizer.run(query, parameters, indexCandidates);
        } catch (err) {
          console.error(err);
          console.error(
            `Something went wrong while running this query. Skipping`,
          );
          queryStats.errored++;
          console.timeEnd(`timing`);
          return;
        }
        if (out.kind === "ok" && out.newIndexes.size > 0) {
          queryStats.optimized++;
          const newIndexes = Array.from(out.newIndexes)
            .map((n) => out.triedIndexes.get(n)?.definition)
            .filter((n) => n !== undefined);
          const existingIndexesForQuery = Array.from(out.existingIndexes)
            .map((index) => {
              const existing = existingIndexes.find(
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
          console.log(`New indexes: ${newIndexes.join(", ")}`);
          recommendations.push({
            fingerprint: fingerprintNum,
            formattedQuery: this.formatQuery(query),
            baseCost: out.baseCost,
            optimizedCost: out.finalCost,
            existingIndexes: existingIndexesForQuery,
            proposedIndexes: newIndexes,
            explainPlan: out.explainPlan,
          });
        } else if (out.kind === "zero_cost_plan") {
          console.log("Zero cost plan found", out);
        } else {
          console.log("No new indexes found");
        }
        console.timeEnd(`timing`);
      });
    }
    await output.status;
    console.log(
      `Matched ${queryStats.matched} queries out of ${queryStats.total}`,
    );
    const reporter = new GithubReporter(GITHUB_TOKEN);
    const statistics = deriveIndexStatistics(recommendations);
    const timeElapsed = Date.now() - startDate.getTime();
    console.log(`Generating report (${reporter.provider()})`);
    const reportContext: ReportContext = {
      recommendations,
      queryStats,
      statistics,
      error,
      metadata: { logSize, timeElapsed },
    };
    await reporter.report(reportContext);
    console.timeEnd("total");
    return reportContext;
  }

  private formatQuery(query: string) {
    return format(query, {
      language: "postgresql",
      keywordCase: "lower",
      linesBetweenQueries: 2,
    });
  }

  private printLegend() {
    console.log(`--Legend--------------------------`);
    console.log(`| ${bgBrightMagenta(" column ")} | Candidate            |`);
    console.log(`| ${yellow(" column ")} | Ignored              |`);
    console.log(`| ${blue(" column ")} | Temp table reference |`);
    console.log(`-----------------------------------`);
    console.log();
  }
}
