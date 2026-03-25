import * as github from "@actions/github";
import type { IndexRecommendation, Nudge } from "@query-doctor/core";
import { DEFAULT_CONFIG, type AnalyzerConfig } from "../config.ts";
import type { QueryProcessResult } from "../runner.ts";

interface CiRunPayload {
  repo: string;
  branch: string;
  commitSha: string;
  commitMessage?: string;
  prNumber?: number;
  runId: string;
  queries: CiQueryPayload[];
}

interface CiQueryPayload {
  hash: string;
  query: string;
  formattedQuery: string;
  optimization: CiOptimization;
  nudges: Nudge[];
}

type CiOptimization =
  | {
      state: "improvements_available";
      cost: number;
      optimizedCost: number;
      costReductionPercentage: number;
      indexRecommendations: CiIndexRecommendation[];
      indexesUsed: string[];
    }
  | {
      state: "no_improvement_found";
      cost: number;
      indexesUsed: string[];
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

function mapResultToQuery(result: QueryProcessResult): CiQueryPayload | null {
  switch (result.kind) {
    case "recommendation":
      return {
        hash: result.recommendation.fingerprint,
        query: result.rawQuery,
        formattedQuery: result.recommendation.formattedQuery,
        nudges: result.nudges,
        optimization: {
          state: "improvements_available",
          cost: result.recommendation.baseCost,
          optimizedCost: result.recommendation.optimizedCost,
          costReductionPercentage:
            result.recommendation.baseCost > 0
              ? ((result.recommendation.baseCost - result.recommendation.optimizedCost) /
                  result.recommendation.baseCost) *
                100
              : 0,
          indexRecommendations: result.indexRecommendations.map(mapIndexRecommendation),
          indexesUsed: result.recommendation.existingIndexes,
        },
      };

    case "no_improvement":
      return {
        hash: result.fingerprint,
        query: result.rawQuery,
        formattedQuery: result.formattedQuery,
        nudges: result.nudges,
        optimization: {
          state: "no_improvement_found",
          cost: result.cost,
          indexesUsed: result.existingIndexes,
        },
      };

    case "zero_cost_plan":
      return {
        hash: result.fingerprint,
        query: result.rawQuery,
        formattedQuery: result.formattedQuery,
        nudges: result.nudges,
        optimization: {
          state: "no_improvement_found",
          cost: 0,
          indexesUsed: [],
        },
      };

    case "error":
      return {
        hash: result.fingerprint,
        query: result.rawQuery,
        formattedQuery: result.formattedQuery,
        nudges: result.nudges,
        optimization: {
          state: "error",
          error: result.error.message,
        },
      };

    case "cost_past_threshold":
      return {
        hash: result.warning.fingerprint,
        query: result.rawQuery,
        formattedQuery: result.warning.formattedQuery,
        nudges: result.nudges,
        optimization: result.warning.optimization
          ? {
              state: "no_improvement_found",
              cost: result.warning.baseCost,
              indexesUsed: result.warning.optimization.existingIndexes,
            }
          : {
              state: "no_improvement_found",
              cost: result.warning.baseCost,
              indexesUsed: [],
            },
      };

    case "invalid":
      return null;
  }
}

export async function postToSiteApi(
  endpoint: string,
  results: QueryProcessResult[],
  config: AnalyzerConfig = DEFAULT_CONFIG,
): Promise<void> {
  const ignoredSet = new Set(config.ignoredQueryHashes);
  const queries = results
    .map(mapResultToQuery)
    .filter((q): q is CiQueryPayload => q !== null)
    .filter((q) => !ignoredSet.has(q.hash));

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
    } else {
      const body = await response.json();
      console.log(`Site API ingestion successful: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.warn(`Failed to POST to Site API: ${err}`);
  }
}
