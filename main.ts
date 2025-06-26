import * as core from "@actions/core";
import csv from "fast-csv";
import { Readable as NodeReadable } from "node:stream";
import { format } from "sql-formatter";
import { highlight } from "sql-highlight";
import { Analyzer } from "./analyzer.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.7/mod.js";
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
  console.log([...Deno.readDirSync("/tmp/postgres_logs")]);
  console.log(`Hello ${core.getInput("name")}!`);
  // core.setOutput("time", new Date().toLocaleTimeString());
  const command = new Deno.Command("pgbadger", {
    stdout: "piped",
    stderr: "piped",
    args: [
      "--dump-raw-csv",
      "--no-progressbar",
      // "-j",
      // "12",
      "--begin",
      "2025-06-24 10:00:00",
      // "/app/postgres_logs/postgres.log",
      "/tmp/postgres_logs/postgres.log",
    ],
  });
  const child = command.spawn();
  const stream = csv.parseStream(NodeReadable.from(child.stdout), {
    headers: false,
  });
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
      const query = parsed["Query Text"];
      const rawParams = parsed["Query Parameters"];
      const params = rawParams ? extractParams(rawParams) : [];
      // console.dir(parsed.Plan, { depth: null });
      // prettyLog(
      //   parsed["Query Text"],
      //   // TODO: not correct to do this
      //   parsed["Query Parameters"]?.split(", ")
      //   // .map((s) => s.match(/\$\d+ = (.+)/)?.[1])
      // );
      const analyzer = new Analyzer();
      const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
        formatQuery(query),
        params
        // .map((s) => s.match(/\$\d+ = (.+)/)?.[1])
      );
      console.log(ansiHighlightedQuery);
      const pg = postgres(
        process.env.POSTGRES_URL ||
          "http://postgres:123@localhost:5432/hatira_dev"
      );
      const optimizer = new IndexOptimizer(pg);
      const stats = new Statistics(pg);
      const tables = await stats.dumpStats();
      const indexes = analyzer.deriveIndexes(tables, indexesToCheck);
      await optimizer.run(query, params, indexes, tables);
    }
  }
  child.stderr.pipeTo(Deno.stderr.writable);
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
  main();
}
