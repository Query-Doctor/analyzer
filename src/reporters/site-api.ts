import * as github from "@actions/github";
import type { IndexRecommendation, Nudge, SQLCommenterTag, TableReference } from "@query-doctor/core";
import { DEFAULT_CONFIG, type AnalyzerConfig } from "../config.ts";
import type { OptimizedQuery } from "../sql/recent-query.ts";

interface CiRunPayload {
  repo: string;
  branch: string;
  commitSha: string;
  commitMessage?: string;
  prNumber?: number;
  runId: string;
  queries: CiQueryPayload[];
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

export interface RunComparison {
  previousRunId: string;
  previousBranch: string;
  previousCommitSha: string;
  regressed: RegressedQuery[];
  acknowledgedRegressed: RegressedQuery[];
  improved: ImprovedQuery[];
  newQueries: CiQueryPayload[];
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

  for (const current of currentQueries) {
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
    disappearedHashes,
  };
}

export async function postToSiteApi(
  endpoint: string,
  queries: CiQueryPayload[],
): Promise<string | null> {
  const payload: CiRunPayload = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "",
    commitSha: process.env.GITHUB_SHA ?? "",
    prNumber: github.context.payload.pull_request?.number,
    runId: process.env.GITHUB_RUN_ID ?? "",
    queries,
  };

  const url = `${endpoint.replace(/\/$/, "")}/ci/runs`;
  console.log(`Posting CI run to ${url} (${queries.length} queries)`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Site API responded with ${response.status}: ${text}`);
      return null;
    }
    const body = (await response.json()) as { id: string };
    console.log(`Site API ingestion successful: ${JSON.stringify(body)}`);
    return body.id;
  } catch (err) {
    console.warn(`Failed to POST to Site API: ${err}`);
    return null;
  }
}

export async function fetchPreviousRun(
  endpoint: string,
  repo: string,
  branch?: string,
  excludeId?: string,
): Promise<PreviousRun | null> {
  const params = new URLSearchParams({ repo });
  if (branch) params.set("branch", branch);
  if (excludeId) params.set("excludeId", excludeId);
  const url = `${endpoint.replace(/\/$/, "")}/ci/runs/latest?${params}`;
  console.log(`Fetching previous run from ${url}`);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) {
      console.log("No previous run found");
      return null;
    }
    if (!response.ok) {
      console.warn(`Failed to fetch previous run: ${response.status}`);
      return null;
    }
    return (await response.json()) as PreviousRun;
  } catch (err) {
    console.warn(`Failed to fetch previous run: ${err}`);
    return null;
  }
}
