import { test, expect, describe } from "vitest";
import { formatCost, queryPreview, buildViewModel } from "./github.ts";
import type { ReportContext } from "../reporter.ts";
import type { RunComparison } from "../site-api.ts";

describe("formatCost", () => {
  test("formats small numbers without commas", () => {
    expect(formatCost(9)).toBe("9");
    expect(formatCost(126)).toBe("126");
    expect(formatCost(999)).toBe("999");
  });

  test("formats thousands with commas", () => {
    expect(formatCost(1000)).toBe("1,000");
    expect(formatCost(15922)).toBe("15,922");
    expect(formatCost(1638.53)).toBe("1,639");
  });

  test("formats large numbers", () => {
    expect(formatCost(1000000)).toBe("1,000,000");
    expect(formatCost(29544.03)).toBe("29,544");
  });

  test("rounds decimals", () => {
    expect(formatCost(8.33)).toBe("8");
    expect(formatCost(292.09)).toBe("292");
  });
});

describe("queryPreview", () => {
  test("returns short query as-is", () => {
    expect(queryPreview('SELECT "id" FROM "users"')).toBe(
      'SELECT "id" FROM "users"',
    );
  });

  test("joins first three lines of multiline query", () => {
    const query = `SELECT
  "id",
  "name"
FROM
  "users"
WHERE
  "users"."id" = $1`;
    expect(queryPreview(query)).toBe('SELECT "id", "name"');
  });

  test("truncates long lines at 120 chars", () => {
    const longQuery =
      'SELECT "id", "user_id", "widget_id", "lesson_id", "module_id", "type", "data", "completed", "state", "extra_column_one", "extra_column_two" FROM "user_widgets"';
    const result = queryPreview(longQuery);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toMatch(/\.\.\.$/);
  });

  test("skips empty lines", () => {
    const query = `

SELECT "id"
FROM "users"

`;
    expect(queryPreview(query)).toBe('SELECT "id" FROM "users"');
  });
});

function makeRecommendation(overrides: {
  fingerprint?: string;
  formattedQuery?: string;
  baseCost?: number;
  optimizedCost?: number;
}) {
  return {
    fingerprint: overrides.fingerprint ?? "abc123",
    formattedQuery: overrides.formattedQuery ?? 'SELECT "id" FROM "users"',
    baseCost: overrides.baseCost ?? 1000,
    baseExplainPlan: {},
    optimizedCost: overrides.optimizedCost ?? 100,
    existingIndexes: [],
    proposedIndexes: ['users("id")'],
    explainPlan: {},
  };
}

function makeContext(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    statisticsMode: { kind: "fromAssumption", reltuples: 10000, relpages: 1000 },
    recommendations: [],
    queriesPastThreshold: [],
    queryStats: { total: 28, matched: 10, optimized: 2, errored: 0 },
    statistics: [],
    metadata: { logSize: 1000, timeElapsed: 5000 },
    ...overrides,
  };
}

function makeComparison(overrides: Partial<RunComparison> = {}): RunComparison {
  return {
    previousRunId: "prev-run-1",
    previousBranch: "main",
    previousCommitSha: "abc123",
    regressed: [],
    acknowledgedRegressed: [],
    improved: [],
    newQueries: [],
    disappearedHashes: [],
    ...overrides,
  };
}

describe("buildViewModel", () => {
  test("no comparison: shows all recommendations, no comparison data", () => {
    const ctx = makeContext({
      recommendations: [makeRecommendation({})],
    });
    const vm = buildViewModel(ctx);
    expect(vm.hasComparison).toBe(false);
    expect(vm.displayRecommendations).toHaveLength(1);
    expect(vm.displayRecommendations[0].queryPreview).toBe(
      'SELECT "id" FROM "users"',
    );
    expect(vm.displayRegressed).toHaveLength(0);
    expect(vm.displayImproved).toHaveLength(0);
  });

  test("comparison with no changes: empty sections", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      recommendations: [
        makeRecommendation({ fingerprint: "existing-query" }),
      ],
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayRecommendations).toHaveLength(0);
    expect(vm.displayRegressed).toHaveLength(0);
    expect(vm.displayImproved).toHaveLength(0);
    expect(vm.preExistingRecommendations).toHaveLength(1);
  });

  test("new queries with recommendations", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-query-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
        ],
      }),
      recommendations: [
        makeRecommendation({ fingerprint: "new-query-1" }),
        makeRecommendation({ fingerprint: "existing-query" }),
      ],
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayRecommendations).toHaveLength(1);
    expect(vm.displayRecommendations[0].fingerprint).toBe("new-query-1");
    expect(vm.newQueryCount).toBe(1);
  });

  test("regressions surface in displayRegressed", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [
          {
            hash: "regressed-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            previousCost: 100,
            currentCost: 500,
            regressionPercentage: 400,
          },
        ],
      }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayRegressed).toHaveLength(1);
    expect(vm.displayRegressed[0].queryPreview).toBe("SELECT 1");
    expect(vm.displayRecommendations).toHaveLength(0);
  });

  test("improvements surface in displayImproved", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        improved: [
          {
            hash: "improved-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            previousCost: 500,
            currentCost: 100,
            improvementPercentage: 80,
            previousIndexes: ["users_pkey"],
            currentIndexes: ["users_pkey", "users_email_idx"],
          },
        ],
      }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayImproved).toHaveLength(1);
    expect(vm.displayImproved[0].queryPreview).toBe("SELECT 1");
    expect(vm.displayImproved[0].previousIndexes).toEqual(["users_pkey"]);
    expect(vm.displayImproved[0].currentIndexes).toEqual(["users_pkey", "users_email_idx"]);
  });

  test("filters recommendations to only new queries", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
          {
            hash: "new-2",
            query: "SELECT 2",
            formattedQuery: "SELECT 2",
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
        ],
      }),
      recommendations: [
        makeRecommendation({ fingerprint: "new-1" }),
        makeRecommendation({ fingerprint: "existing-1" }),
        makeRecommendation({ fingerprint: "existing-2" }),
        makeRecommendation({ fingerprint: "new-2" }),
      ],
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayRecommendations).toHaveLength(2);
    expect(vm.displayRecommendations.map((r) => r.fingerprint)).toEqual([
      "new-1",
      "new-2",
    ]);
  });

  test("preExistingRecommendations contains non-new-query recommendations", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
        ],
      }),
      recommendations: [
        makeRecommendation({ fingerprint: "new-1" }),
        makeRecommendation({ fingerprint: "existing-1", formattedQuery: 'SELECT "name" FROM "products"' }),
        makeRecommendation({ fingerprint: "existing-2", formattedQuery: 'UPDATE "orders" SET "status" = $1' }),
      ],
    });
    const vm = buildViewModel(ctx);
    expect(vm.preExistingRecommendations).toHaveLength(2);
    expect(vm.preExistingRecommendations.map((r) => r.fingerprint)).toEqual([
      "existing-1",
      "existing-2",
    ]);
  });

  test("no comparison: preExistingRecommendations is empty", () => {
    const ctx = makeContext({
      recommendations: [makeRecommendation({})],
    });
    const vm = buildViewModel(ctx);
    expect(vm.preExistingRecommendations).toHaveLength(0);
  });
});
