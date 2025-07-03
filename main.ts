import * as core from "@actions/core";
import csv from "fast-csv";
import { Readable } from "node:stream";
import { format } from "sql-formatter";
import { Analyzer } from "./analyzer.ts";
import postgres from "postgresjs";
import { Statistics } from "./optimizer/statistics.ts";
import { IndexOptimizer } from "./optimizer/genalgo.ts";
import process from "node:process";
import { fingerprint } from "@libpg-query/parser";
import {
  GithubReporter,
  ReportIndexRecommendation,
} from "./reporters/github.ts";
import { preprocessEncodedJson } from "./json.ts";
import { ExplainedLog } from "./pg_log.ts";

function formatQuery(query: string) {
  return format(query, {
    language: "postgresql",
    keywordCase: "lower",
    linesBetweenQueries: 2,
  });
}

async function main() {
  const logPath = process.env.LOG_PATH || "/var/log/postgresql/postgres.log";
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    Deno.exit(1);
  }
  const startDate = new Date();
  const fileSize = Deno.statSync(logPath).size;
  console.log(`logPath=${logPath},fileSize=${fileSize}`);
  // core.setOutput("time", new Date().toLocaleTimeString());
  const args = [
    "--dump-raw-csv",
    "--no-progressbar",
    "-f",
    "stderr",
    // "--begin",
    // "2025-06-24 10:00:00",
    logPath,
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
  let allQueries = 0;
  let matching = 0;
  let skipped = {};
  const pg = postgres(postgresUrl);
  const stats = new Statistics(pg);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(pg, existingIndexes);
  const tables = await stats.dumpStats();
  // console.log(tables);

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
      continue;
    }
    let parsed: ExplainedLog;
    try {
      parsed = new ExplainedLog(json);
    } catch (e) {
      console.log(e);
      break;
    }
    allQueries++;
    const { query, parameters, plan } = parsed;
    const queryFingerprint = await fingerprint(query);
    if (
      // TODO: we can support inserts/updates too. Just need the right optimization for it.
      plan.nodeType === "ModifyTable" ||
      query.includes("@qd_introspection")
    ) {
      continue;
    }
    const fingerprintNum = parseInt(queryFingerprint, 16);
    if (seenQueries.has(fingerprintNum)) {
      if (process.env.DEBUG) {
        console.log("Skipping duplicate query", fingerprintNum);
      }
      continue;
    }
    seenQueries.add(fingerprintNum);
    const analyzer = new Analyzer();

    const { indexesToCheck, ansiHighlightedQuery, referencedTables } =
      await analyzer.analyze(formatQuery(query), parameters);

    const selectsCatalog = referencedTables.find((table) =>
      table.startsWith("pg_")
    );
    if (selectsCatalog) {
      if (process.env.DEBUG) {
        console.log(
          "Skipping query that selects from catalog tables",
          selectsCatalog,
          fingerprintNum
        );
      }
      continue;
    }
    const indexCandidates = analyzer.deriveIndexes(tables, indexesToCheck);
    if (indexCandidates.length > 0) {
      await core.group(`query:${fingerprintNum}`, async () => {
        console.time(`timing`);
        matching++;
        printLegend();
        console.log(ansiHighlightedQuery);
        const out = await optimizer.run(
          query,
          parameters,
          indexCandidates,
          tables
        );
        if (out.newIndexes.size > 0) {
          const newIndexes = Array.from(out.newIndexes)
            .map((n) => out.triedIndexes.get(n)?.definition)
            .filter((n) => n !== undefined);
          const existingIndexesForQuery = Array.from(out.existingIndexes)
            .map((index) => {
              const existing = existingIndexes.find(
                (e) => e.index_name === index
              );
              if (existing) {
                return `${existing.schema_name}.${
                  existing.table_name
                }(${existing.index_columns
                  .map((c) => `"${c.name}" ${c.order}`)
                  .join(", ")})`;
              }
            })
            .filter((i) => i !== undefined);
          console.log(`New indexes: ${newIndexes.join(", ")}`);
          recommendations.push({
            formattedQuery: formatQuery(query),
            baseCost: out.baseCost,
            optimizedCost: out.finalCost,
            existingIndexes: existingIndexesForQuery,
            proposedIndexes: newIndexes,
            explainPlan: out.explainPlan,
          });
        } else {
          console.log("No new indexes found");
        }
        console.timeEnd(`timing`);
      });
    }
  }
  await output.status;
  console.log(`Matched ${matching} queries out of ${allQueries}`);
  const reporter = new GithubReporter(process.env.GITHUB_TOKEN);
  await reporter.report({
    recommendations,
    queriesLookedAt: matching,
    totalQueries: allQueries,
    error,
    metadata: {
      logSize: fileSize,
      timeElapsed: Date.now() - startDate.getTime(),
    },
  });
  console.timeEnd("total");
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}

function printLegend() {
  console.log(`--Legend--------------------------`);
  console.log(`| \x1b[48;5;205m column \x1b[0m | Candidate            |`);
  console.log(`| \x1b[33m column \x1b[0m | Ignored              |`);
  console.log(`| \x1b[34m column \x1b[0m | Temp table reference |`);
  console.log(`-----------------------------------`);
  console.log();
}
