import * as core from "@actions/core";
import { QueryProcessResult, Runner } from "./runner.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { createServer } from "./server/http.ts";
import { Connectable } from "./sync/connectable.ts";
import { shutdownController } from "./shutdown.ts";
import {
  buildQueries,
  compareRuns,
  fetchPreviousRun,
  postToSiteApi,
} from "./reporters/site-api.ts";
import { DEFAULT_CONFIG, fetchAnalyzerConfig } from "./config.ts";

async function runInCI(
  postgresUrl: Connectable,
  logPath: string,
  statisticsPath?: string,
  maxCost?: number,
) {
  const siteApiEndpoint = env.SITE_API_ENDPOINT;
  const repo = env.GITHUB_REPOSITORY;
  const branch =
    process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "";

  const config =
    siteApiEndpoint && repo
      ? await fetchAnalyzerConfig(siteApiEndpoint, repo)
      : DEFAULT_CONFIG;

  const runner = await Runner.build({
    postgresUrl,
    statisticsPath,
    logPath,
    maxCost,
    ignoredQueryHashes: config.ignoredQueryHashes,
  });
  let allResults: QueryProcessResult[];
  let reportContext;

  try {
    log.info("main", "Running in CI mode. Skipping server creation");
    const results = await runner.run(config);
    allResults = results.allResults;
    reportContext = results.reportContext;
  } finally {
    await runner.close();
  }

  const queries = buildQueries(allResults, config);

  // POST to Site API first so we get the run ID for the PR comment link
  let runId: string | null = null;
  if (siteApiEndpoint) {
    runId = await postToSiteApi(siteApiEndpoint, queries);
  }

  // Build the run URL and query base URL for the PR comment
  if (siteApiEndpoint && runId) {
    // SITE_API_ENDPOINT is e.g. https://api.querydoctor.com
    // The app lives at https://app.querydoctor.com — derive from the API URL
    const appUrl =
      process.env.SITE_APP_URL ??
      siteApiEndpoint.replace(/\/api\/?$/, "").replace("api.", "app.");
    const baseUrl = appUrl.replace(/\/$/, "");
    reportContext.runUrl = `${baseUrl}/ci/${runId}`;
    reportContext.queryBaseUrl = baseUrl;
  }

  // Fetch previous run for comparison
  if (siteApiEndpoint && repo) {
    const comparisonBranch =
      config.comparisonBranch ?? process.env.GITHUB_BASE_REF ?? branch;
    const previousRun = await fetchPreviousRun(
      siteApiEndpoint,
      repo,
      comparisonBranch,
      runId ?? undefined,
    );
    if (previousRun) {
      reportContext.comparison = compareRuns(
        queries,
        previousRun,
        config.regressionThreshold,
        config.minimumCost,
        config.acknowledgedQueryHashes,
      );
    }
  }

  // Generate PR comment with comparison data
  await runner.report(reportContext);

  // Block PR if regressions exceed thresholds
  if (reportContext.comparison && reportContext.comparison.regressed.length > 0) {
    const messages = reportContext.comparison.regressed.map(
      (q) =>
        `  - ${q.hash}: cost ${q.previousCost} → ${q.currentCost} (+${q.regressionPercentage.toFixed(1)}%)`,
    );
    core.setFailed(
      `${reportContext.comparison.regressed.length} untriaged regression(s) beyond threshold:\n${messages.join("\n")}`,
    );
  }
}

async function runOutsideCI() {
  const os = process.platform;
  const arch = process.arch;
  log.info(
    `Starting server (${os}-${arch}) on ${env.HOST}:${env.PORT}`,
    "main",
  );
  if (!env.POSTGRES_URL) {
    core.setFailed("POSTGRES_URL environment variable is not set");
    process.exit(1);
  }
  const server = await createServer(
    env.HOST,
    env.PORT,
    Connectable.fromString(env.POSTGRES_URL),
    env.SOURCE_DATABASE_URL ? Connectable.fromString(env.SOURCE_DATABASE_URL) : undefined,
  );

  const shutdown = async () => {
    shutdownController.abort();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function main() {
  if (env.CI) {
    if (!env.POSTGRES_URL) {
      core.setFailed("POSTGRES_URL environment variable is not set");
      process.exit(1);
    }
    if (!env.LOG_PATH) {
      core.setFailed("LOG_PATH environment variable is not set");
      process.exit(1);
    }
    await runInCI(
      Connectable.fromString(env.POSTGRES_URL),
      env.LOG_PATH,
      env.STATISTICS_PATH,
      typeof env.MAX_COST === "number" ? env.MAX_COST : undefined,
    );
  } else {
    await runOutsideCI();
  }
}

await main();
