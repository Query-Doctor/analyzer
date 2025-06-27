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
import { ReportIndexRecommendation } from "./reporters/github.ts";

function formatQuery(query: string) {
  return format(query, {
    language: "postgresql",
    keywordCase: "lower",
    linesBetweenQueries: 2,
  });
}

async function main() {
  console.log(process.env.GITHUB_WORKSPACE);
  // console.log([...Deno.readDirSync(process.env.GITHUB_WORKSPACE!)]);
  const logPath = process.env.LOG_PATH || core.getInput("log_path");
  const postgresUrl = process.env.POSTGRES_URL || core.getInput("postgres_url");
  console.log(logPath);
  console.log(postgresUrl);
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
  const stream = csv.parseStream(Readable.from(output.stdout), {
    headers: false,
  });

  const seenQueries = new Set<number>();
  const recommendations: ReportIndexRecommendation[] = [];
  let matching = 0;
  const pg = postgres(postgresUrl);
  const stats = new Statistics(pg);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(pg, existingIndexes);
  console.log(existingIndexes);
  const tables = await stats.dumpStats();

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
        console.log(json[850].codePointAt(0));
        console.log(json.slice(830, 1000));
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
          console.log(ansiHighlightedQuery);
          const out = await optimizer.run(
            query,
            params,
            indexCandidates,
            tables
          );
          if (out.newIndexes.size > 0) {
            console.log(dedent`
        Optimized cost from ${out.baseCost} to ${out.finalCost}
        Existing indexes: ${Array.from(out.existingIndexes).join(", ")}
        New indexes: ${Array.from(
          out.newIndexes,
          (n) => out.triedIndexes.get(n)?.definition
        ).join(", ")}
      `);
            recommendations.push({
              formattedQuery: formatQuery(query),
              baseCost: out.baseCost,
              optimizedCost: out.finalCost,
              existingIndexes: Array.from(out.existingIndexes),
              proposedIndexes: Array.from(out.newIndexes),
            });
          } else {
            console.log("No new indexes found");
          }
          console.timeEnd(`timing`);
        });
      }
    }
  }
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
