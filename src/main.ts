import * as core from "@actions/core";
import { QueryProcessResult, Runner } from "./runner.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { createServer } from "./server/http.ts";
import { Connectable } from "./sync/connectable.ts";
import { shutdownController } from "./shutdown.ts";
import {
  buildQueries,
  type CiRunResult,
  classifyIngestFailure,
  compareRuns,
  fetchPreviousRun,
  gateEligibleNewQueries,
  postToSiteApi,
} from "./reporters/site-api.ts";
import { formatCost, queryPreview } from "./reporters/github/github.ts";
import { fetchPrChangedFiles } from "./gate/changed-files.ts";
import { evaluateTestPresence } from "./gate/test-presence.ts";
import { gateRegression } from "./gate/regression.ts";
import { gateSchemaChange } from "./gate/schema-change.ts";
import { resolveVerdict } from "./gate/policy.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ApiClient } from "./remote/api-client.ts";
import { Remote } from "./remote/remote.ts";
import { ConnectionManager } from "./sync/connection-manager.ts";
import { PgbadgerSource } from "./sql/pgbadger.ts";
import type { RecentQuerySource } from "./sql/recent-query.ts";
import type { FullSchema, RepoPolicyConfig } from "@query-doctor/core";

async function runInCI(
  targetPostgresUrl: Connectable,
  sourcePostgresUrl: Connectable,
  logPath: string | undefined,
  maxCost?: number,
) {
  const siteApiEndpoint = env.SITE_API_ENDPOINT;
  const repo = env.GITHUB_REPOSITORY;
  const branch =
    process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "";

  const remoteDbManager = ConnectionManager.forRemoteDatabase()
  const remote = new Remote(
    targetPostgresUrl,
    ConnectionManager.forLocalDatabase(),
    remoteDbManager,
    { disableQueryLoader: true },
  );

  if (!env.TOKEN) {
    throw new Error("CI mode cannot be run without a TOKEN variable provided")
  }

  const { api, dispose: disposeApi } = await ApiClient.connect(siteApiEndpoint, env.TOKEN, { kind: "ci", branch, sha: "" }, remote, (err) => {
    log.warn(`API connection broken during CI run: ${err}`, "main");
  });

  // `Runner.build` triggers `remote.syncFrom`, which emits `schemaSynced` with
  // the schema dumped from the source DB. CI doesn't wire up `hookUpApiReporter`
  // (that's the persistent-server path), so capture the schema here and push it
  // explicitly. We await the push before `disposeApi` so the short-lived CI
  // process doesn't exit before the WS write flushes.
  let syncedSchema: FullSchema | undefined;
  const onSchemaSynced = (schema: FullSchema) => {
    syncedSchema = schema;
  };
  remote.on("schemaSynced", onSchemaSynced);

  try {
    const config = repo
      ? await api.getRepoConfig(repo, branch).catch(
        (err) => {
          log.warn(`Failed to fetch repo config via RPC: ${err}. Using defaults`, "main");
          return DEFAULT_CONFIG;
        },
      )
      : DEFAULT_CONFIG;

    // Cost against the project's stored production statistics when available, so
    // CI numbers reflect real prod cardinality instead of synthetic assumptions.
    // Scoped server-side to this connection's project; null when none is stored
    // or the pull fails, in which case the runner falls back to synthetic stats.
    const productionStats = await api.getProductionStats().catch((err) => {
      log.warn(
        `Failed to fetch production stats via RPC: ${err}. Falling back to synthetic stats`,
        "main",
      );
      return null;
    });
    if (productionStats && productionStats.length > 0) {
      log.info(
        `Costing against ${productionStats.length} table(s) of stored production statistics`,
        "main",
      );
    }

    const source: RecentQuerySource = logPath
      ? new PgbadgerSource(logPath)
      : remoteDbManager.getConnectorFor(sourcePostgresUrl);

    const runner = await Runner.build({
      targetPostgresUrl,
      sourcePostgresUrl,
      source,
      maxCost,
      ignoredQueryHashes: config.ignoredQueryHashes,
      remote,
      productionStats: productionStats ?? undefined,
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

    // POST to Site API first so we get the run ID (for baseline exclusion) and
    // the unified CI-signal metadata for the PR comment.
    let runResult: CiRunResult | null = null;
    if (siteApiEndpoint) {
      const outcome = await postToSiteApi(siteApiEndpoint, queries, reportContext.statisticsMode, reportContext.computedStats, syncedSchema);
      if (outcome.ok) {
        runResult = outcome.result;
      } else {
        // Ingestion failed: the run was computed but not saved. Without this it
        // silently vanishes — no dashboard link, a degraded PR comment that
        // looks like a normal empty result, and a green check. Surface it in the
        // comment, and pick the Actions severity by who can act and whether it
        // recovers (see classifyIngestFailure).
        const kind = classifyIngestFailure(outcome.failure.status);
        reportContext.ingestError = { kind, ...outcome.failure };
        const statusText = outcome.failure.status
          ? ` (HTTP ${outcome.failure.status})`
          : "";
        const base = `Query Doctor could not record this run${statusText}; it was not saved to the dashboard.`;
        if (kind === "auth") {
          // The user's to fix and means CI isn't actually running — fail loudly.
          core.setFailed(`${base} The project TOKEN is missing or invalid.`);
        } else if (kind === "too_large") {
          // The payload exceeded the API's size limit — our side to fix, not
          // theirs, and re-running the same payload won't help. Loud but
          // non-blocking unless opted in, same as a rejected run.
          const msg = `${base} The submission was too large for the API to accept; re-running won't help.`;
          if (env.FAIL_ON_INGEST_ERROR) core.setFailed(msg);
          else core.error(msg);
        } else if (kind === "rejected") {
          // The API refused a computed run (likely analyzer/API skew) — our bug,
          // not theirs. Red and loud, but don't block the PR unless opted in.
          const msg = `${base} The API rejected the submission; re-running won't help.`;
          if (env.FAIL_ON_INGEST_ERROR) core.setFailed(msg);
          else core.error(msg);
        } else {
          // Transient (network/timeout/5xx) — recoverable, so warn and move on.
          core.warning(`${base} Query Doctor was unreachable — re-run to retry.`);
        }
      }
    }
    const runId: string | null = runResult?.id ?? null;

    // Run link and per-query links come straight from the API response. Both
    // degrade gracefully: `url` is null and `queries` is empty for an unlinked repo.
    if (runResult) {
      reportContext.runUrl = runResult.url ?? undefined;
      reportContext.runMetadata = runResult.metadata ?? undefined;
    }

    // Fetch previous run for comparison
    let previousRun = null;
    if (siteApiEndpoint && repo) {
      const comparisonBranch =
        config.comparisonBranch ?? process.env.GITHUB_BASE_REF ?? branch;
      const result = await fetchPreviousRun(
        siteApiEndpoint,
        repo,
        comparisonBranch,
        runId ?? undefined,
      );
      reportContext.comparisonBranch = comparisonBranch;
      if (result.kind === "found") {
        previousRun = result.run;
      } else if (result.kind === "not-found") {
        log.info(
          "main",
          `No baseline found on branch "${comparisonBranch}". Comparison will be skipped. ` +
          `To establish a baseline, run the analyzer on pushes to "${comparisonBranch}" ` +
          `(add "push: branches: [${comparisonBranch}]" to your workflow trigger).`,
        );
      } else {
        // Transient fetch failure after retries — flag it so the comment says
        // "temporarily unavailable, re-run" rather than claiming there is no
        // baseline (which would tell the user to add an already-present trigger).
        reportContext.comparisonUnavailable = true;
        log.warn(
          "main",
          `Failed to fetch baseline for branch "${comparisonBranch}" (${result.reason}). ` +
          `Comparison will be skipped this run — re-run the check to retry.`,
        );
      }
    }
    if (previousRun) {
      reportContext.comparison = await compareRuns(
        queries,
        previousRun,
        config.regressionThreshold,
        config.minimumCost,
        config.acknowledgedQueryHashes,
      );
    }

    // Test-presence gate (#3496): flag data-access changes that ship with no
    // data-layer test. A diff heuristic, but capture overrides it (#3502): when
    // the run captured new query surface, the change demonstrably ran against
    // Postgres, so the "no related test" guess is dropped. Runs even on a
    // brand-new PR with no baseline (then capture is empty and it's diff-only).
    // Best-effort: a GitHub API hiccup must never sink the whole run.
    if (env.GITHUB_TOKEN) {
      try {
        const changedFiles = await fetchPrChangedFiles(env.GITHUB_TOKEN);
        if (changedFiles) {
          const capture = reportContext.comparison
            ? { newQueryHashes: reportContext.comparison.newQueries.map((q) => q.hash) }
            : undefined;
          reportContext.testPresenceVerdict =
            evaluateTestPresence(changedFiles, undefined, capture) ?? undefined;
        }
      } catch (err) {
        log.warn(`Test-presence gate skipped: ${err}`, "main");
      }
    }

    // Resolve the gate verdict's CI conclusion via the shared taxonomy (#3498)
    // and policy engine (#3500) instead of a local severity. By default an
    // unverified data-access change concludes `failure`, so it blocks the check —
    // a "Warning" beside a green check is invisible to downstream reviewers
    // (Site#3541). A repo can soften it to a non-blocking neutral (`warn`) or
    // suppress it (`off`). Resolved before the report so `off` also drops the
    // comment block, and so the comment can render the right framing.
    if (reportContext.testPresenceVerdict) {
      const policyConfig: RepoPolicyConfig =
        ("conditionPolicies" in config ? config.conditionPolicies : undefined) ??
        {};
      const resolved = resolveVerdict(
        reportContext.testPresenceVerdict,
        policyConfig,
      );
      if (resolved.surfaced) {
        reportContext.testPresenceConclusion = resolved.conclusion;
      } else {
        reportContext.testPresenceVerdict = undefined;
      }
    }

    console.log("Creating report...")
    // Generate PR comment with comparison data
    await runner.report(reportContext);

    // Carry the verdict into the check itself: a blocking conclusion fails the
    // run (red X), a softened one surfaces as a non-blocking annotation. Framed
    // as "could not verify", never "your query is broken".
    if (reportContext.testPresenceVerdict) {
      const verdict = reportContext.testPresenceVerdict;
      const files = verdict.dataAccessFiles.map((f) => `  - ${f}`).join("\n");
      const message =
        `${verdict.reason}\n\nNext step: ${verdict.nextStep}\n\n` +
        `Changed data-access files with no related data-layer test:\n${files}`;
      if (reportContext.testPresenceConclusion === "failure") {
        core.setFailed(message);
      } else {
        core.warning(message);
      }
    }

    // Schema-change gate (Site#3289). The API already computed the schema diff
    // (`runMetadata.schemaChange`) and the comment renders it; this only decides
    // the check. Block by default so a person validates the migration; a repo
    // softens it to `warn`/`off` via the schema-drift policy.
    const schemaGate = gateSchemaChange(
      reportContext.runMetadata?.schemaChange,
      "conditionPolicies" in config ? config.conditionPolicies : undefined,
    );
    if (schemaGate) {
      if (schemaGate.conclusion === "failure") {
        core.setFailed(schemaGate.message);
      } else {
        core.warning(schemaGate.message);
      }
    }

    // Block PR if regressions exceed thresholds, or if a brand-new query ships
    // with a high-confidence index recommendation (#3281). New queries have no
    // baseline so they can never regress; the new-query gate catches the missing
    // index at introduction, while it's still a one-line fix.
    if (reportContext.comparison) {
      const queryLinks = new Map(
        (reportContext.runMetadata?.queries ?? []).map((q) => [q.hash, q.link]),
      );
      const linkFor = (hash: string) => {
        const queryLink = queryLinks.get(hash);
        return queryLink ? `\n    ${queryLink}` : "";
      };

      const policyConfig: RepoPolicyConfig =
        ("conditionPolicies" in config ? config.conditionPolicies : undefined) ??
        {};

      const { regressed, newQueries } = reportContext.comparison;

      // Regression arm routed through the shared policy engine (#3500), so a repo
      // can soften it to warn/off like untested-data-access and schema-drift.
      // `regressed` is already the untriaged, beyond-threshold set; the policy is
      // a second, repo-wide layer on top of per-query triage. Default `fail`, so
      // a repo that sets nothing blocks exactly as the old inline path did.
      const regressionGate = gateRegression(regressed.length, policyConfig);
      if (regressionGate) {
        const messages = regressed.map((q) => {
          const preview = queryPreview(q.formattedQuery);
          const cost = `cost ${formatCost(q.previousCost)} → ${formatCost(q.currentCost)} (+${q.regressionPercentage.toFixed(1)}%)`;
          return `  - ${preview}: ${cost}${linkFor(q.hash)}`;
        });
        const message = `${regressed.length} untriaged regression(s) beyond threshold:\n${messages.join("\n")}`;
        if (regressionGate.conclusion === "failure") core.setFailed(message);
        else core.warning(message);
      }

      // New-query arm stays on its inline setFailed. Its default policy is
      // `warn`, so routing it through resolveVerdict would silently stop it
      // blocking — a behavior change that needs a human sign-off, tracked
      // separately from this regression-only task.
      const gateNewQueries = gateEligibleNewQueries(
        newQueries,
        config.regressionThreshold,
        config.acknowledgedQueryHashes,
        config.minimumCost,
      );
      if (gateNewQueries.length > 0) {
        const messages = gateNewQueries.map((q) => {
          const preview = queryPreview(q.formattedQuery);
          // gateEligibleNewQueries only returns improvements_available entries.
          const opt = q.optimization as Extract<
            typeof q.optimization,
            { state: "improvements_available" }
          >;
          const detail = `cost ${formatCost(opt.cost)}, index recommendation cuts it ${opt.costReductionPercentage.toFixed(1)}%`;
          return `  - ${preview}: ${detail}${linkFor(q.hash)}`;
        });
        core.setFailed(
          `${gateNewQueries.length} new quer${gateNewQueries.length === 1 ? "y" : "ies"} ship${gateNewQueries.length === 1 ? "s" : ""} with a high-impact index recommendation (acknowledge on the dashboard to allow):\n${messages.join("\n")}`,
        );
      }
    }
  } finally {
    remote.off("schemaSynced", onSchemaSynced);
    disposeApi();
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
    throw new Error("POSTGRES_URL environment variable is not set. If you're seeing this inside Docker something has gone wrong");
  }
  if (!env.TOKEN) {
    throw new Error("TOKEN environment variable is not set\nYou probably forgot to pass a `-e TOKEN=...` parameter to the docker container");
  }
  const sourceDb = Connectable.fromString(env.SOURCE_DATABASE_URL)
  const remote = new Remote(
    Connectable.fromString(env.POSTGRES_URL),
    ConnectionManager.forLocalDatabase(),
    ConnectionManager.forRemoteDatabase(),
    { disableQueryLoader: false },
    sourceDb,
  );
  ApiClient.connectWithReconnect(env.SITE_API_ENDPOINT, env.TOKEN, { kind: "persistent" }, remote);
  const server = await createServer(
    env.HOST,
    env.PORT,
    remote,
    sourceDb
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
    await runInCI(
      Connectable.fromString(env.POSTGRES_URL),
      Connectable.fromString(env.SOURCE_DATABASE_URL),
      env.LOG_PATH,
      typeof env.MAX_COST === "number" ? env.MAX_COST : undefined,
    );
    process.exit(process.exitCode ?? 0);
  } else {
    await runOutsideCI();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
