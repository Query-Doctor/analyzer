import * as core from "@actions/core";
import csv from "fast-csv";
import { Analyzer } from "./analyzer.ts";
import postgres from "postgresjs";
import { getPostgresVersion, Statistics } from "./optimizer/statistics.ts";
import { IndexOptimizer } from "./optimizer/genalgo.ts";
import { fingerprint } from "@libpg-query/parser";
import { GithubReporter } from "./reporters/github/github.ts";
import { preprocessEncodedJson } from "./json.ts";
import { ExplainedLog } from "./pg_log.ts";
import {
  deriveIndexStatistics,
  ReportIndexRecommendation,
} from "./reporters/reporter.ts";
import {
  DEBUG,
  GITHUB_TOKEN,
  LOG_PATH,
  POSTGRES_URL,
  STATISTICS_PATH,
} from "./env.ts";
import { Runner } from "./runner.ts";

async function main() {
  if (!POSTGRES_URL) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    Deno.exit(1);
  }
  if (!LOG_PATH) {
    core.setFailed("LOG_PATH environment variable is not set");
    Deno.exit(1);
  }
  const runner = new Runner(POSTGRES_URL, LOG_PATH, STATISTICS_PATH);
  await runner.run();
  Deno.exit();
}

if (import.meta.main) {
  await main();
}
