import * as core from "@actions/core";
import csv from "fast-csv";
import { Readable as NodeReadable, Readable } from "node:stream";
import { format } from "sql-formatter";
import { highlight } from "sql-highlight";
import { Analyzer } from "./analyzer.ts";
import postgres from "postgresjs";
import { Statistics } from "./optimizer/statistics.ts";
import { IndexOptimizer } from "./optimizer/genalgo.ts";
import process from "node:process";

function formatQuery(query: string) {
  return format(query, {
    language: "postgresql",
    keywordCase: "lower",
    denseOperators: false,
    linesBetweenQueries: 2,
  });
}

function prettyLog(query: string, params: unknown[]) {
  const formatted = formatQuery(query);
  console.log(highlight(formatted));
  if (params) {
    console.log(params);
  }
  console.log();
}

async function main() {
  console.log(process.env.GITHUB_WORKSPACE);
  // console.log([...Deno.readDirSync(process.env.GITHUB_WORKSPACE!)]);
  const beginDate = process.env.BEGIN_DATE || core.getInput("begin_date");
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

  let matching = 0;
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
      if (
        parsed.Plan["Node Type"] === "ModifyTable" ||
        // we get some infinite loops in development here
        parsed["Query Text"].includes("pg_catalog") ||
        parsed["Query Text"].includes("@qd_introspection")
      ) {
        continue;
      }
      matching++;
      const query = parsed["Query Text"];
      const rawParams = parsed["Query Parameters"];
      const params = rawParams ? extractParams(rawParams) : [];
      const analyzer = new Analyzer();
      const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
        formatQuery(query),
        params
      );
      console.log(ansiHighlightedQuery);
      const pg = postgres(postgresUrl);
      const optimizer = new IndexOptimizer(pg);
      const stats = new Statistics(pg);
      const tables = await stats.dumpStats();
      const indexes = analyzer.deriveIndexes(tables, indexesToCheck);
      await optimizer.run(query, params, indexes, tables);
    }
  }
  await output.status;
  console.log(`Ran ${matching} queries`);
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
