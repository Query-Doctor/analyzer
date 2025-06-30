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
import dedent from "dedent";
import {
  GithubReporter,
  ReportIndexRecommendation,
} from "./reporters/github.ts";

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
  // core.setOutput("time", new Date().toLocaleTimeString());
  const command = new Deno.Command("pgbadger", {
    stdout: "piped",
    stderr: "piped",
    args: [
      "--dump-raw-csv",
      "--no-progressbar",
      // "--begin",
      // "2025-06-24 10:00:00",
      logPath,
    ],
  });
  const output = command.spawn();
  output.stderr.pipeTo(Deno.stderr.writable);
  const stream = csv
    .parseStream(Readable.from(output.stdout), {
      headers: false,
    })
    .on("error", (err) => {
      console.error(err);
    });

  const seenQueries = new Set<number>();
  const recommendations: ReportIndexRecommendation[] = [];
  let matching = 0;
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
      query,
      _parameters,
      _appname,
      _backendtype,
      _queryid,
    ] = chunk as string[];
    if (loglevel !== "LOG" || !query.startsWith("plan:")) {
      continue;
    }
    const plan: string = query.split("plan:")[1].trim();
    let isJSONOutput = false;
    let i = 0;
    for (; i < plan.length; i++) {
      const char = plan[i];
      if (char === "\\" && plan[i + 1] === "n") {
        i++;
        continue;
      } else if (/\s+/.test(char)) {
        continue;
      } else if (char === "{") {
        isJSONOutput = true;
        break;
      }
    }
    if (isJSONOutput) {
      const json = plan
        .slice(i)
        .replace(/\\n/g, "\n")
        // there are random control characters in the json lol
        // deno-lint-ignore no-control-regex
        .replace(/[\u0000-\u001F]+/g, (c) =>
          c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : ""
        );
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        console.log(e);
        break;
      }
      const queryFingerprint = await fingerprint(parsed["Query Text"]);
      if (
        parsed.Plan["Node Type"] === "ModifyTable" ||
        // we get some infinite loops in development here
        parsed["Query Text"].includes("pg_catalog") ||
        parsed["Query Text"].includes("@qd_introspection")
      ) {
        continue;
      }
      const fingerprintNum = parseInt(queryFingerprint, 16);
      if (seenQueries.has(fingerprintNum)) {
        console.log("Skipping duplicate query", fingerprintNum);
        continue;
      }
      seenQueries.add(fingerprintNum);
      const query = parsed["Query Text"];
      const rawParams = parsed["Query Parameters"];
      const params = rawParams ? extractParams(rawParams) : [];
      const analyzer = new Analyzer();

      const { indexesToCheck, ansiHighlightedQuery, referencedTables } =
        await analyzer.analyze(formatQuery(query), params);

      const selectsCatalog = referencedTables.find((table) =>
        table.startsWith("pg_")
      );
      if (selectsCatalog) {
        console.log(
          "Skipping query that selects from catalog tables",
          selectsCatalog,
          fingerprintNum
        );
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
            params,
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
            console.log(dedent`
              Optimized cost from ${out.baseCost} to ${out.finalCost}
              Existing indexes: ${Array.from(out.existingIndexes).join(", ")}
              New indexes: ${newIndexes.join(", ")}
            `);
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
  }
  const reporter = new GithubReporter(process.env.GITHUB_TOKEN);
  await reporter.report({
    recommendations,
    queriesLookedAt: seenQueries.size,
    metadata: {
      logSize: fileSize,
      timeElapsed: Date.now() - startDate.getTime(),
    },
  });
  console.timeEnd("total");
  await output.status;
  console.log(`Ran ${matching} queries`);
  Deno.exit(0);
}

const paramPattern = /\$(\d+)\s*=\s*(?:'([^']*)'|([^,\s]+))/g;
function extractParams(logLine: string) {
  const paramsArray = [];
  let match;

  while ((match = paramPattern.exec(logLine)) !== null) {
    const paramValue = match[2] !== undefined ? match[2] : match[3];
    // Push the value directly into the array.
    // The order is determined by the $1, $2, etc. in the log line.
    paramsArray[parseInt(match[1]) - 1] = paramValue;
  }

  // Filter out any empty slots if parameters were not consecutive (e.g., $1, $3 present, but $2 missing)
  // This ensures a dense array without 'empty' items.
  return paramsArray.filter((value) => value !== undefined);
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
