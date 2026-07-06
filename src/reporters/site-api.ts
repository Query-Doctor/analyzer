import { gzip } from "node:zlib";
import { promisify } from "node:util";
import * as github from "@actions/github";
import { isTestOriginQuery } from "@query-doctor/core";
import type { ComputedStats, FullSchema, IndexRecommendation, Nudge, SQLCommenterTag, StatisticsMode, TableReference } from "@query-doctor/core";
import { DEFAULT_CONFIG, type AnalyzerConfig } from "../config.ts";
import type { OptimizedQuery } from "../sql/recent-query.ts";
import type { Op } from "jsondiffpatch/formatters/jsonpatch";

const gzipAsync = promisify(gzip);

interface CiRunPayload {
  repo: string;
  branch: string;
  /**
   * The PR base branch (`GITHUB_BASE_REF`), forwarded so the Site roll-up
   * resolves the same baseline the PR-comment body already used. Absent on
   * push runs, where there is no base ref. See Query-Doctor/Site#3292.
   */
  baseBranch?: string;
  commitSha: string;
  commitMessage?: string;
  prNumber?: number;
  runId: string;
  queries: CiQueryPayload[];
  statisticsMode?: StatisticsMode;
  computedStats?: ComputedStats;
  schema?: unknown;
}

export interface CiQueryPayload {
  hash: string;
  query: string;
  formattedQuery: string;
  optimization: CiOptimization;
  nudges: Nudge[];
  tags: SQLCommenterTag[];
  tableReferences: TableReference[];
}

export type CiOptimization =
  | {
    state: "improvements_available";
    cost: number;
    optimizedCost: number;
    costReductionPercentage: number;
    indexRecommendations: CiIndexRecommendation[];
    indexesUsed: string[];
    explainPlan?: object;
    optimizedExplainPlan?: object;
  }
  | {
    state: "no_improvement_found";
    cost: number;
    indexesUsed: string[];
    explainPlan?: object;
  }
  | {
    state: "error";
    error: string;
  };

interface CiIndexRecommendation {
  schema: string;
  table: string;
  columns: Array<{
    schema: string;
    table: string;
    column: string;
    sort?: unknown;
    where?: unknown;
  }>;
  where?: string;
  definition: string;
}

export interface PreviousRun {
  id: string;
  repo: string;
  branch: string;
  commitSha: string;
  queries: CiQueryPayload[];
}

/**
 * Unified CI-signal metadata returned by `POST /ci/runs` (Site #3067).
 * The analyzer renders these fields verbatim so the PR comment speaks the same
 * language as the Slack/webhook alert. See analyzer#141.
 */
export interface CiRunMetadata {
  /**
   * Structured roll-up counts. The rendered roll-up line must equal `rollupText`.
   * `null` when the API couldn't resolve the comparison baseline (a degraded read,
   * distinct from a genuine all-new first run) — omit the roll-up line in that case.
   */
  rollup: {
    regressed: number;
    improved: number;
    new: number;
    removed: number;
  } | null;
  /** The roll-up line — render verbatim (equals the alert's `formatRollup(...)`). `null` when {@link rollup} is. */
  rollupText: string | null;
  /** The small "more detail" footer — render verbatim (equals `formatRunFooter(runId)`). */
  footer: string;
  /** A small `docs` link. May be null. */
  docsUrl: string | null;
  /** Presentation-agnostic icon keys for the four signal types. Map each to an image asset. */
  signalKeys: { new: string; regressed: string; improved: string; index: string };
  /** Per-query run-scoped detail links, keyed by query hash. Empty when the repo isn't linked. */
  queries: Array<{ hash: string; link: string }>;
  /**
   * Comparison-baseline state (Site #3297). Optional: absent on a Site API that
   * predates it (deploy skew — render nothing), `null` when the API couldn't
   * resolve the baseline (a degraded read — unknown, not "unset"). When `unset`
   * is true the project has no comparison branch configured (or it collapsed to
   * a head-vs-head comparison), so the counts can be inaccurate (#3292) and the
   * comment should warn. `resolvedBranch` is what the comparison fell back to;
   * `headVsHead` is the acute all-zeros case; `mcpCall` is the MCP call to
   * inspect/fix the config.
   */
  baseline?: {
    comparisonBranchConfigured: boolean;
    resolvedBranch: string;
    headVsHead: boolean;
    unset: boolean;
    mcpCall: string;
  } | null;
  /**
   * Schema delta of this run's pushed schema against the latest schema stored
   * for the resolved comparison baseline — the same baseline the roll-up uses,
   * so the schema diff and the query signals agree on what "the target branch"
   * is. `operations` is a jsondiffpatch JSON Patch (RFC 6902) over the
   * {@link FullSchema} shape, keyed by table/index/constraint OID server-side.
   *
   * Optional/nullable to mirror {@link baseline}: absent on a Site API that
   * predates this field (deploy skew — render nothing), `null` when the API
   * couldn't resolve the baseline schema (a degraded read — distinct from a
   * clean run with no schema change, which is `changed: false`).
   */
  schemaChange?: {
    changed: boolean;
    operations: Op[];
  } | null;
}

/**
 * The `POST /ci/runs` response. `id` is always present; `url` is null and
 * `metadata` is absent/degraded when the repo can't be resolved to a project.
 */
export interface CiRunResult {
  id: string;
  url: string | null;
  metadata: CiRunMetadata | null;
}

/**
 * Why `POST /ci/runs` didn't save the run. `status` is the HTTP status, or null
 * when the request never completed (network/timeout). `message` is the (capped)
 * response body or error text, surfaced in the PR comment so the failure isn't
 * silent.
 */
export interface PostRunFailure {
  status: number | null;
  message: string;
}

export type PostRunOutcome =
  | { ok: true; result: CiRunResult }
  | { ok: false; failure: PostRunFailure };

/**
 * How a rejected ingest should be treated, by recipient and recoverability:
 * - `transient`: network/timeout/5xx — recoverable, re-run to retry.
 * - `auth`: 401/403 — CI is misconfigured; the user must fix the token.
 * - `too_large`: 413 — the payload exceeded the API's size limit. A distinct
 *   cause from `rejected`: it's not contract skew, so the "out of sync" copy
 *   would be wrong. Re-running the same payload won't help.
 * - `rejected`: other 4xx — the API refused a computed run (e.g. analyzer/API
 *   contract skew); not the user's to fix and re-running won't help.
 */
export type IngestFailureKind = "transient" | "auth" | "too_large" | "rejected";

export function classifyIngestFailure(status: number | null): IngestFailureKind {
  if (status === null || status >= 500) return "transient";
  if (status === 401 || status === 403) return "auth";
  if (status === 413) return "too_large";
  return "rejected";
}

// Response bodies (e.g. a ZodError) can be large; cap what we echo into the PR
// comment so a failure banner stays readable.
const MAX_FAILURE_MESSAGE_LENGTH = 600;

function truncateFailureMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MAX_FAILURE_MESSAGE_LENGTH
    ? trimmed.slice(0, MAX_FAILURE_MESSAGE_LENGTH) + "…"
    : trimmed;
}

export interface RunComparison {
  previousRunId: string;
  previousBranch: string;
  previousCommitSha: string;
  regressed: RegressedQuery[];
  acknowledgedRegressed: RegressedQuery[];
  improved: ImprovedQuery[];
  newQueries: CiQueryPayload[];
  /**
   * Queries bucketed out of the gate because they originate from a test file
   * (Query-Doctor/Site#3199). Kept as a distinct list — not silently dropped —
   * so the run stays auditable: the PR comment can show what was excluded, and
   * they never appear in `regressed`/`newQueries`/`improved`, so the gate can't
   * fail on them.
   */
  testOriginExcluded: CiQueryPayload[];
  disappearedHashes: string[];
}

export interface RegressedQuery {
  hash: string;
  query: string;
  formattedQuery: string;
  previousCost: number;
  currentCost: number;
  regressionPercentage: number;
}

export interface ImprovedQuery {
  hash: string;
  query: string;
  formattedQuery: string;
  previousCost: number;
  currentCost: number;
  improvementPercentage: number;
  previousIndexes: string[];
  currentIndexes: string[];
}

function mapIndexRecommendation(rec: IndexRecommendation): CiIndexRecommendation {
  return {
    schema: rec.schema,
    table: rec.table,
    columns: rec.columns.map((c) => ({
      schema: c.schema,
      table: c.table,
      column: c.column,
      sort: c.sort,
      where: c.where,
    })),
    where: rec.where,
    definition: rec.definition,
  };
}

function mapResultToQuery(result: OptimizedQuery): CiQueryPayload | null {
  const { optimization } = result;
  if (
    optimization.state === "waiting" ||
    optimization.state === "optimizing" ||
    optimization.state === "not_supported" ||
    optimization.state === "timeout"
  ) {
    return null;
  }
  return {
    hash: result.hash,
    query: result.query,
    formattedQuery: result.formattedQuery,
    nudges: result.nudges,
    tags: result.tags,
    tableReferences: result.tableReferences ?? [],
    optimization,
  };
}

function getQueryCost(q: CiQueryPayload): number | null {
  if (q.optimization.state === "improvements_available") return q.optimization.cost;
  if (q.optimization.state === "no_improvement_found") return q.optimization.cost;
  return null;
}

function getQueryIndexes(q: CiQueryPayload): string[] {
  if (q.optimization.state === "improvements_available") return q.optimization.indexesUsed;
  if (q.optimization.state === "no_improvement_found") return q.optimization.indexesUsed;
  return [];
}

export function buildQueries(
  results: OptimizedQuery[],
  config: AnalyzerConfig = DEFAULT_CONFIG,
): CiQueryPayload[] {
  const ignoredSet = new Set(config.ignoredQueryHashes);
  return results
    .map(mapResultToQuery)
    .filter((q): q is CiQueryPayload => q !== null)
    .filter((q) => !ignoredSet.has(q.hash));
}

export function compareRuns(
  currentQueries: CiQueryPayload[],
  previousRun: PreviousRun,
  regressionThreshold: number,
  minimumCost: number = 0,
  acknowledgedQueryHashes: string[] = [],
): RunComparison {
  const prevByHash = new Map(previousRun.queries.map((q) => [q.hash, q]));
  const currentHashes = new Set(currentQueries.map((q) => q.hash));
  const acknowledgedSet = new Set(acknowledgedQueryHashes);

  const regressed: RegressedQuery[] = [];
  const acknowledgedRegressed: RegressedQuery[] = [];
  const improved: ImprovedQuery[] = [];
  const newQueries: CiQueryPayload[] = [];
  const testOriginExcluded: CiQueryPayload[] = [];

  for (const current of currentQueries) {
    // A query issued from a test file runs no production path, so it must never
    // gate the PR (#3199). Bucket it out before any regressed/new/improved
    // categorization — same rule the Site alert engine applies, via the shared
    // detector in @query-doctor/core — so the two surfaces can't drift.
    if (isTestOriginQuery(current.tags)) {
      testOriginExcluded.push(current);
      continue;
    }
    const prev = prevByHash.get(current.hash);
    if (!prev) {
      newQueries.push(current);
      continue;
    }
    const prevCost = getQueryCost(prev);
    const currentCost = getQueryCost(current);
    if (prevCost === null || currentCost === null || prevCost === 0) continue;

    const changePct = ((currentCost - prevCost) / prevCost) * 100;
    if (changePct > regressionThreshold) {
      // Skip regressions where both costs are below minimumCost
      if (minimumCost > 0 && prevCost < minimumCost && currentCost < minimumCost) {
        continue;
      }
      const entry: RegressedQuery = {
        hash: current.hash,
        query: current.query,
        formattedQuery: current.formattedQuery,
        previousCost: prevCost,
        currentCost,
        regressionPercentage: changePct,
      };
      if (acknowledgedSet.has(current.hash)) {
        acknowledgedRegressed.push(entry);
      } else {
        regressed.push(entry);
      }
    } else if (changePct < -regressionThreshold) {
      // Skip improvements where both costs are below minimumCost
      if (minimumCost > 0 && prevCost < minimumCost && currentCost < minimumCost) {
        continue;
      }
      improved.push({
        hash: current.hash,
        query: current.query,
        formattedQuery: current.formattedQuery,
        previousCost: prevCost,
        currentCost,
        improvementPercentage: Math.abs(changePct),
        previousIndexes: getQueryIndexes(prev),
        currentIndexes: getQueryIndexes(current),
      });
    }
  }

  const disappearedHashes: string[] = [];
  for (const [hash] of prevByHash) {
    if (!currentHashes.has(hash)) {
      disappearedHashes.push(hash);
    }
  }

  return {
    previousRunId: previousRun.id,
    previousBranch: previousRun.branch,
    previousCommitSha: previousRun.commitSha,
    regressed,
    acknowledgedRegressed,
    improved,
    newQueries,
    testOriginExcluded,
    disappearedHashes,
  };
}

/**
 * New queries that should block the CI gate (#3281). A new query has no
 * baseline, so it can never be a regression and historically shipped green at
 * any cost. We instead gate it on a *recommendation-backed* signal: the planner
 * found a real index that collapses its cost. This keys on plan shape, not the
 * raw modeled cost, so it survives the `fromAssumption` row-count inflation and
 * naturally excludes test-only queries (which carry no index recommendation).
 *
 * Reuses the same `regressionThreshold` the existing gate already uses — no new
 * knob: eligible when the query carries an index recommendation whose modeled
 * cost reduction exceeds `regressionThreshold` percent, mirroring how a
 * regression must exceed that same percentage. Acknowledged hashes are exempt,
 * the same triage escape hatch regressions have; ignored hashes never reach here
 * (they're dropped in {@link buildQueries}).
 */
export function gateEligibleNewQueries(
  newQueries: CiQueryPayload[],
  regressionThreshold: number,
  acknowledgedQueryHashes: string[] = [],
): CiQueryPayload[] {
  const acknowledgedSet = new Set(acknowledgedQueryHashes);
  return newQueries.filter((q) => {
    if (acknowledgedSet.has(q.hash)) return false;
    const opt = q.optimization;
    return (
      opt.state === "improvements_available" &&
      opt.indexRecommendations.length > 0 &&
      opt.costReductionPercentage > regressionThreshold
    );
  });
}

export async function postToSiteApi(
  endpoint: string,
  queries: CiQueryPayload[],
  statisticsMode?: StatisticsMode,
  computedStats?: ComputedStats,
  schema?: FullSchema,
): Promise<PostRunOutcome> {
  const payload: CiRunPayload = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "",
    // Forward the PR base ref so the Site roll-up compares against the same
    // baseline as the PR-comment body. Empty/unset on push runs → omitted.
    baseBranch: process.env.GITHUB_BASE_REF || undefined,
    commitSha: process.env.GITHUB_SHA ?? "",
    prNumber: github.context.payload.pull_request?.number,
    runId: process.env.GITHUB_RUN_ID ?? "",
    queries,
    statisticsMode,
    computedStats,
    schema,
  };

  // POST /ci/runs authenticates the run with the project token and attributes
  // it to that project. Without the header the Site API rejects the request as
  // Unauthorized, so warn loudly rather than silently dropping the run.
  const token = process.env.TOKEN;
  if (!token) {
    console.warn(
      "TOKEN is not set — POST /ci/runs will be rejected as Unauthorized. " +
      "Set TOKEN to your Query Doctor project token.",
    );
  }

  const url = `${endpoint.replace(/\/$/, "")}/ci/runs`;

  // Gzip the body: CI run payloads reach multiple MB (many queries + schema),
  // and the Site API decompresses request bodies before enforcing its size
  // limit. See Query-Doctor/Site raise-json-body-limit work.
  const body = await gzipAsync(JSON.stringify(payload));

  const sentKib = (body.byteLength / 1024).toFixed(1);
  console.log(
    `Posting CI run to ${url} (${queries.length} queries, ${sentKib} KiB gzipped)`,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Site API responded with ${response.status}: ${text}`);
      return {
        ok: false,
        failure: {
          status: response.status,
          message: truncateFailureMessage(text),
        },
      };
    }
    const responseBody = (await response.json()) as {
      id: string;
      url?: string | null;
      metadata?: CiRunMetadata | null;
    };
    console.log(`Site API ingestion successful: ${JSON.stringify(responseBody)}`);
    return {
      ok: true,
      result: {
        id: responseBody.id,
        url: responseBody.url ?? null,
        metadata: responseBody.metadata ?? null,
      },
    };
  } catch (err) {
    console.warn(`Failed to POST to Site API: ${err}`);
    return {
      ok: false,
      failure: { status: null, message: truncateFailureMessage(String(err)) },
    };
  }
}

export type PreviousRunResult =
  | { kind: "found"; run: PreviousRun }
  | { kind: "not-found" }
  | { kind: "error"; reason: string };

export interface FetchPreviousRunOptions {
  /** Retry attempts after the first, on transient failures only. */
  retries?: number;
  /** Backoff before each retry. Pass 0 in tests. */
  retryDelayMs?: number;
}

const delay = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Fetch the baseline run for a branch, distinguishing three outcomes:
 * `found`, a genuine `not-found` (404), and a transient `error`.
 *
 * The baseline fetch pulls a multi-MB payload under a 10s timeout, so a brief
 * latency blip times out and used to report "no baseline" on a baseline that
 * demonstrably exists (Site#3287). Retry transient failures — timeout, network,
 * or 5xx — before giving up; a genuine 404 (no baseline) and other 4xx are
 * returned immediately and never retried.
 */
export async function fetchPreviousRun(
  endpoint: string,
  repo: string,
  branch?: string,
  excludeId?: string,
  options: FetchPreviousRunOptions = {},
): Promise<PreviousRunResult> {
  const { retries = 2, retryDelayMs = 500 } = options;
  const params = new URLSearchParams({ repo });
  if (branch) params.set("branch", branch);
  if (excludeId) params.set("excludeId", excludeId);
  const url = `${endpoint.replace(/\/$/, "")}/ci/runs/latest?${params}`;
  console.log(`Fetching previous run from ${url}`);

  let lastReason = "unknown";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`Retrying baseline fetch (attempt ${attempt + 1}/${retries + 1})`);
      await delay(retryDelayMs);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404) {
        console.log("No previous run found");
        return { kind: "not-found" };
      }
      if (response.ok) {
        return { kind: "found", run: (await response.json()) as PreviousRun };
      }
      // 5xx is transient (retry); other non-ok statuses (e.g. 4xx) won't fix
      // themselves on a retry, so fail fast.
      lastReason = `HTTP ${response.status}`;
      console.warn(`Failed to fetch previous run: ${response.status}`);
      if (response.status < 500) {
        return { kind: "error", reason: lastReason };
      }
    } catch (err) {
      // Timeout / network error — transient, keep retrying.
      lastReason = `${err}`;
      console.warn(`Failed to fetch previous run: ${err}`);
    }
  }
  return { kind: "error", reason: lastReason };
}
