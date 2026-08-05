import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import n from "nunjucks";
import { formatCost, queryPreview, buildViewModel, callSite } from "./github.ts";
import { isQueryLong, renderExplain, type ReportContext } from "../reporter.ts";
import type { CiRunMetadata, RunComparison } from "../site-api.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const successTemplate = readFileSync(join(__dirname, "success.md.j2"), "utf-8");

n.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true });

function renderTemplate(ctx: ReportContext) {
  const viewModel = buildViewModel(ctx);
  return n.renderString(successTemplate, {
    ...ctx,
    ...viewModel,
    isQueryLong,
    renderExplain,
    formatCost,
  });
}

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

  test("inlines all lines of multiline query", () => {
    const query = `SELECT
  "id",
  "name"
FROM
  "users"
WHERE
  "users"."id" = $1`;
    expect(queryPreview(query)).toBe(
      'SELECT "id", "name" FROM "users" WHERE "users"."id" = $1',
    );
  });

  test("truncates at 200 chars", () => {
    const longQuery =
      'SELECT "id", "user_id", "widget_id", "lesson_id", "module_id", "type", "data", "completed", "state", "extra_column_one", "extra_column_two", "extra_column_three", "extra_column_four", "extra_column_five" FROM "user_widgets" WHERE "user_id" = $1';
    const result = queryPreview(longQuery);
    expect(result.length).toBeLessThanOrEqual(200);
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
    statisticsMode: { kind: "fromAssumption", reltuples: 10000 },
    recommendations: [],
    queriesPastThreshold: [],
    queryStats: { analyzed: 28, matched: 10, optimized: 2, errored: 0 },
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
    testOriginExcluded: [],
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
            nudges: [], tags: [], tableReferences: [],
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

  test("test-origin excluded queries get their own auditable section (#3199)", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        testOriginExcluded: [
          {
            hash: "test-query-1",
            query: "SELECT * FROM t",
            formattedQuery: "SELECT * FROM t",
            nudges: [], tags: [{ key: "file", value: "tests/db.test.ts" }], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 99, indexesUsed: [] },
          },
        ],
      }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayTestOriginExcluded).toHaveLength(1);
    expect(vm.displayTestOriginExcluded[0].queryPreview).toBe("SELECT * FROM t");
  });

  test("new query without a recommendation is still listed (Site#3287 follow-up)", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-covered",
            query: 'SELECT "id" FROM "matches"',
            formattedQuery: 'SELECT "id" FROM "matches"',
            nudges: [], tags: [], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 42, indexesUsed: ["matches_pkey"] },
          },
        ],
      }),
      recommendations: [],
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayNewQueries).toHaveLength(1);
    expect(vm.displayNewQueries[0].queryPreview).toBe('SELECT "id" FROM "matches"');
    expect(vm.displayNewQueries[0].costLabel).toBe("cost 42");
  });

  test("a new query with a recommendation is not double-listed in displayNewQueries", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-with-rec",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            nudges: [], tags: [], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
        ],
      }),
      recommendations: [makeRecommendation({ fingerprint: "new-with-rec" })],
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayRecommendations.map((r) => r.fingerprint)).toContain(
      "new-with-rec",
    );
    expect(vm.displayNewQueries).toHaveLength(0);
  });

  test("a new query with a below-threshold recommendation is surfaced as a recommendation, not 'no index suggestion'", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "cheap-new",
            query: 'SELECT "id" FROM "projects"',
            formattedQuery: 'SELECT "id" FROM "projects"',
            nudges: [], tags: [], tableReferences: [],
            optimization: {
              state: "improvements_available",
              cost: 13,
              optimizedCost: 9,
              costReductionPercentage: 30,
              indexRecommendations: [
                {
                  schema: "public",
                  table: "projects",
                  columns: [{ schema: "public", table: "projects", column: "team_id" }],
                  definition: "CREATE INDEX ON projects (team_id)",
                },
              ],
              indexesUsed: [],
            },
          },
        ],
      }),
      recommendations: [],
      belowThresholdRecommendations: [
        makeRecommendation({
          fingerprint: "cheap-new",
          formattedQuery: 'SELECT "id" FROM "projects"',
          baseCost: 13,
          optimizedCost: 9,
        }),
      ],
    });
    const vm = buildViewModel(ctx);

    expect(vm.displayNewQueries).toHaveLength(0);
    expect(vm.displayRecommendations.map((r) => r.fingerprint)).toEqual([
      "cheap-new",
    ]);
    expect(vm.displayRecommendations[0].belowThreshold).toBe(true);
  });

  test("regressions surface in displayRegressed", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [
          {
            hash: "regressed-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            tags: [],
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

  test("improvements surface in displayImproved with indexesChanged true", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        improved: [
          {
            hash: "improved-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            tags: [],
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
    expect(vm.displayImproved[0].indexesChanged).toBe(true);
  });

  test("improvements with identical indexes have indexesChanged false", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        improved: [
          {
            hash: "improved-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            tags: [],
            previousCost: 500,
            currentCost: 100,
            improvementPercentage: 80,
            previousIndexes: ["users_pkey"],
            currentIndexes: ["users_pkey"],
          },
        ],
      }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.displayImproved).toHaveLength(1);
    expect(vm.displayImproved[0].indexesChanged).toBe(false);
  });

  test("filters recommendations to only new queries", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-1",
            query: "SELECT 1",
            formattedQuery: "SELECT 1",
            nudges: [], tags: [], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 10, indexesUsed: [] },
          },
          {
            hash: "new-2",
            query: "SELECT 2",
            formattedQuery: "SELECT 2",
            nudges: [], tags: [], tableReferences: [],
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
            nudges: [], tags: [], tableReferences: [],
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

describe("template rendering", () => {
  test("renders queryStats.analyzed as the query count", () => {
    const ctx = makeContext({
      queryStats: { analyzed: 5, matched: 3, optimized: 1, errored: 0 },
      comparison: makeComparison(),
    });
    const output = renderTemplate(ctx);
    expect(output).not.toContain("5 queries analyzed");
  });

  test("renders queryStats.analyzed in no-comparison mode", () => {
    const ctx = makeContext({
      queryStats: { analyzed: 3, matched: 1, optimized: 0, errored: 0 },
    });
    const output = renderTemplate(ctx);
    expect(output).not.toContain("3 queries analyzed");
  });

  test("renders a rejected-ingest banner with status and details", () => {
    const ctx = makeContext({
      ingestError: {
        kind: "rejected",
        status: 400,
        message: "ZodError: invalid constraintType",
      },
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("Query Doctor couldn't record this run");
    expect(output).toContain("HTTP 400");
    expect(output).toContain("re-running won't help");
    expect(output).toContain("ZodError: invalid constraintType");
  });

  test("renders auth-specific copy for an auth-kind ingest failure", () => {
    const ctx = makeContext({
      ingestError: { kind: "auth", status: 401, message: "Unauthorized" },
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("authentication failed");
    expect(output).toContain("Set a valid `TOKEN`");
  });

  test("renders retry copy for a transient ingest failure", () => {
    const ctx = makeContext({
      ingestError: { kind: "transient", status: null, message: "network down" },
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("re-run the check to retry");
  });

  test("renders payload-too-large copy for a too_large ingest failure", () => {
    const ctx = makeContext({
      ingestError: {
        kind: "too_large",
        status: 413,
        message: '{"statusCode":413,"message":"request entity too large"}',
      },
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("The submission was too large");
    expect(output).toContain("HTTP 413");
    expect(output).toContain("size limit on our side");
    expect(output).not.toContain("out of sync");
    expect(output).toContain("request entity too large");
  });

  test("omits the failure banner when ingestion succeeded", () => {
    const ctx = makeContext({
      queryStats: { analyzed: 3, matched: 1, optimized: 0, errored: 0 },
    });
    const output = renderTemplate(ctx);
    expect(output).not.toContain("Query Doctor couldn't record this run");
  });
});

function makeMetadata(overrides: Partial<CiRunMetadata> = {}): CiRunMetadata {
  return {
    rollup: { regressed: 2, improved: 1, new: 3, removed: 0 },
    rollupText: "2 regressed · 1 improved · 3 new · 0 removed",
    footer: 'More detail → get_ci_run({ runId: "9f3a1c20" })',
    docsUrl: "https://docs.querydoctor.com",
    signalKeys: {
      new: "signal.new",
      regressed: "signal.regressed",
      improved: "signal.improved",
      index: "signal.index",
    },
    queries: [
      { hash: "regressed-1", link: "https://app.querydoctor.com/alice/proj/ci/9f3a1c20/regressed-1" },
      { hash: "improved-1", link: "https://app.querydoctor.com/alice/proj/ci/9f3a1c20/improved-1" },
    ],
    ...overrides,
  };
}

describe("CI-signal metadata parity (analyzer#141)", () => {
  const regressedComparison = makeComparison({
    regressed: [
      {
        hash: "regressed-1",
        query: "SELECT 1",
        formattedQuery: "SELECT 1",
        tags: [],
        previousCost: 120,
        currentCost: 170,
        regressionPercentage: 42,
      },
    ],
    improved: [
      {
        hash: "improved-1",
        query: "SELECT 2",
        formattedQuery: "SELECT 2",
        tags: [],
        previousCost: 500,
        currentCost: 100,
        improvementPercentage: 80,
        previousIndexes: [],
        currentIndexes: [],
      },
    ],
  });

  test("linked repo: renders rollup line, per-query links, footer, run link, and docs link", () => {
    const ctx = makeContext({
      comparison: regressedComparison,
      runUrl: "https://app.querydoctor.com/alice/proj/ci/9f3a1c20",
      runMetadata: makeMetadata(),
    });
    const output = renderTemplate(ctx);

    // Roll-up line rendered verbatim (single source of truth — no re-derived grammar).
    // Footer rendered verbatim.
    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    expect(output).not.toContain("/ixr/");
    // Run link and small docs link in the meta row.
    expect(output).toContain('<a href="https://app.querydoctor.com/alice/proj/ci/9f3a1c20">view run</a>');
    expect(output).toContain('<a href="https://docs.querydoctor.com">docs</a>');
    // Per-signal icons aren't rendered yet (assets pending Site follow-up).
    expect(output).not.toContain("<img");

    expect(output).toMatchSnapshot();
  });

  test("unlinked repo: rollup + footer + docs only, no run link, no per-query links", () => {
    const ctx = makeContext({
      comparison: regressedComparison,
      runUrl: undefined,
      runMetadata: makeMetadata({ queries: [] }),
    });
    const output = renderTemplate(ctx);

    // Shared elements still present.
    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    expect(output).toContain('<a href="https://docs.querydoctor.com">docs</a>');
    // No run link, no per-query links when the repo isn't linked.
    expect(output).not.toContain("view run");
    expect(output).not.toContain("https://app.querydoctor.com/alice/proj/ci");
    // Query previews still render, just without anchors.

    expect(output).toMatchSnapshot();
  });

  test("no metadata (degraded API response): no rollup or footer row", () => {
    const ctx = makeContext({
      comparison: regressedComparison,
      runMetadata: undefined,
    });
    const output = renderTemplate(ctx);

    expect(output).not.toContain("regressed · ");
    expect(output).not.toContain("get_ci_run");
    expect(output).not.toContain("docs</a>");
  });

  test("null docsUrl: docs link omitted, footer still rendered", () => {
    const ctx = makeContext({
      comparison: regressedComparison,
      runUrl: "https://app.querydoctor.com/alice/proj/ci/9f3a1c20",
      runMetadata: makeMetadata({ docsUrl: null }),
    });
    const output = renderTemplate(ctx);

    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    expect(output).not.toContain(">docs</a>");
  });

  test("degraded baseline (null rollup): roll-up line omitted, footer still rendered", () => {
    // The Site API nulls rollup/rollupText when the comparison baseline read
    // fails, but the baseline-independent footer/docs still ship. Omit the
    // roll-up line entirely rather than render a blank line or "null".
    const ctx = makeContext({
      comparison: regressedComparison,
      runUrl: "https://app.querydoctor.com/alice/proj/ci/9f3a1c20",
      runMetadata: makeMetadata({ rollup: null, rollupText: null }),
    });
    const output = renderTemplate(ctx);

    expect(output).not.toContain("regressed · ");
    expect(output).not.toContain("null");
    // Footer and run link are baseline-independent — they still render.
    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    expect(output).toContain(
      '<a href="https://app.querydoctor.com/alice/proj/ci/9f3a1c20">view run</a>',
    );
  });
});

describe("baseline absent vs. temporarily unavailable (Site#3287)", () => {
  test("genuine missing baseline renders the no-baseline / push-trigger copy", () => {
    const ctx = makeContext({ comparisonBranch: "staging" });
    const output = renderTemplate(ctx);

    expect(output).toContain("No baseline on `staging`");
    // Still points at the push trigger, now as a condition rather than an
    // instruction, because a correctly configured first run lands here too.
    expect(output).toContain("`push` trigger");
    expect(output).not.toContain("temporarily unavailable");
  });

  // "" is what a first push run on a project with no configured branch actually
  // produces: main.ts resolves the configured branch, then the PR base, then the
  // current branch, and on that path all three can be absent.
  test.each([
    ["absent", {}],
    ["empty", { comparisonBranch: "" }],
  ])("never names a branch it does not have: %s", (_case, overrides) => {
    const output = renderTemplate(makeContext(overrides));

    // An empty inline code span is the shape of the bug — `{{ comparisonBranch }}`
    // interpolated to nothing, leaving "No baseline on ``" above instructions
    // for a branch that was never named.
    expect(output).not.toMatch(/``/);
    // "is set", not just "No comparison branch": the unset-baseline warning
    // lower in the template opens "No comparison branch configured", so the
    // looser string would pass on the wrong block.
    expect(output).toContain("No comparison branch is set");
  });

  test("names the branch and keeps the push-trigger guidance when it has one", () => {
    const output = renderTemplate(makeContext({ comparisonBranch: "staging" }));

    expect(output).toContain("No baseline on `staging`");
    expect(output).toContain("`push` trigger");
  });

  test("transient fetch failure renders a re-run message, not the no-baseline copy", () => {
    const ctx = makeContext({
      comparisonBranch: "staging",
      comparisonUnavailable: true,
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("Comparison temporarily unavailable");
    expect(output).toContain("re-run the check");
    // Must not tell the user to add a trigger that is already in place.
    expect(output).not.toContain("No baseline on `staging`");
    expect(output).not.toContain("`push` trigger");
  });
});

describe("unset-baseline callout (Site #3297 / #3312)", () => {
  const unsetBaseline = {
    comparisonBranchConfigured: false,
    resolvedBranch: "feature-x",
    headVsHead: true,
    unset: true,
    mcpCall: 'get_repo_config({ repo: "owner/repo" })',
  };

  test("warns when the baseline is unset, even though a comparison was produced", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({ baseline: unsetBaseline }),
    });
    const output = renderTemplate(ctx);

    // Rendered as a GFM warning alert.
    expect(output).toContain("> [!WARNING]");
    expect(output).toContain("No comparison branch configured");
    // Names the fallback branch and the acute head-vs-head consequence...
    expect(output).toContain("`feature-x`");
    expect(output).toContain("this PR's own branch");
    expect(output).toContain('0 new');
    // ...and surfaces the MCP call to inspect/fix it.
    expect(output).toContain('get_repo_config({ repo: "owner/repo" })');
  });

  test("frames a base-branch fallback as a divergence/non-PR risk, not head-vs-head", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({
        baseline: { ...unsetBaseline, resolvedBranch: "main", headVsHead: false },
      }),
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("No comparison branch configured");
    expect(output).toContain("`main`");
    expect(output).toContain("breaks on non-PR runs");
    expect(output).not.toContain("this PR's own branch");
  });

  test("renders no callout when a comparison branch is configured", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({
        baseline: {
          comparisonBranchConfigured: true,
          resolvedBranch: "staging",
          headVsHead: false,
          unset: false,
          mcpCall: 'get_repo_config({ repo: "owner/repo" })',
        },
      }),
    });
    const output = renderTemplate(ctx);

    expect(output).not.toContain("No comparison branch configured");
  });

  test("renders no callout when the baseline state is absent (older API / degraded read)", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({ baseline: null }),
    });
    const output = renderTemplate(ctx);

    expect(output).not.toContain("No comparison branch configured");
  });
});

describe("schema change section", () => {
  const addedTableOp = {
    op: "add" as const,
    path: "/tables/0",
    value: { type: "table", oid: 1, schemaName: "public", tableName: "orders", columns: [] },
  };
  const droppedIndexOp = { op: "remove" as const, path: "/indexes/3" };

  test("buildViewModel surfaces a non-rendering view when metadata has no schemaChange", () => {
    const ctx = makeContext({ comparison: makeComparison(), runMetadata: makeMetadata() });
    const vm = buildViewModel(ctx);
    expect(vm.schemaChange.hasChanges).toBe(false);
  });

  test("buildViewModel ignores schemaChange when changed is false", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({ schemaChange: { changed: false, operations: [addedTableOp] } }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.schemaChange.hasChanges).toBe(false);
  });

  test("buildViewModel treats null schemaChange (degraded read) as no change", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({ schemaChange: null }),
    });
    const vm = buildViewModel(ctx);
    expect(vm.schemaChange.hasChanges).toBe(false);
  });

  test("template renders schema changes vs the comparison branch", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      comparisonBranch: "main",
      gates: [{ condition: "schema-drift", label: "Schema drift", fired: true, conclusion: "failure", found: "The schema changed against the baseline" }],
      runMetadata: makeMetadata({
        schemaChange: { changed: true, operations: [addedTableOp, droppedIndexOp] },
      }),
    });
    const output = renderTemplate(ctx);

    // Each line states its own kind, so the block needs no heading above it.
    expect(output).toContain("<sub>Added table public.orders</sub>");
    expect(output).toContain("<sub>Removed index</sub>");
    expect(output).not.toContain("**Added**");
    expect(output).not.toContain("**Removed**");
  });

  test("closes the schema list so the gates after it are not nested inside it", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      gates: [
        { condition: "schema-drift", label: "Schema drift", fired: true, conclusion: "failure", found: "The schema changed against the baseline" },
        { condition: "high-value-nudge", label: "High-value nudge", fired: false, conclusion: "success", found: "No index or rewrite past the threshold" },
      ],
      runMetadata: makeMetadata({
        schemaChange: { changed: true, operations: [addedTableOp] },
      }),
    });
    const lines = renderTemplate(ctx).split("\n");
    const gateRow = lines.findIndex((l) => l.includes("**Schema drift**"));
    const entries = lines.filter((l) => l.startsWith("<sub>"));

    // Every expansion sits tight under its gate row, the way the regression and
    // recommendation blocks do. A blank line here would drop the block further
    // than any other caption in the comment.
    expect(lines[gateRow + 1]).toBe(entries[0]);

    // But the block must close, or the roster's leading is computed against a
    // 12px line box and the next gate row is pulled up tighter than the rest.
    const lastEntry = lines.lastIndexOf(entries.at(-1)!);
    expect(lines[lastEntry + 1]).toBe("");

    // Caption size, not body size — otherwise the detail reads as loud as the
    // gate rows it sits beneath.
    expect(entries.every((l) => l.endsWith("</sub>"))).toBe(true);
  });

  // The patch locates this change at /tables/12/columns/17, which is all the
  // reporter could print from it. The API now names it, so the position never
  // reaches the comment.
  test("renders the API's named changes rather than the patch path", () => {
    const addedColumnOp = {
      op: "add" as const,
      path: "/tables/12/columns/17",
      value: { type: "column", name: "statistics_payload_id", order: 18 },
    };
    const ctx = makeContext({
      comparison: makeComparison(),
      comparisonBranch: "main",
      gates: [{ condition: "schema-drift", label: "Schema drift", fired: true, conclusion: "failure", found: "The schema changed against the baseline" }],
      runMetadata: makeMetadata({
        schemaChange: {
          changed: true,
          operations: [addedColumnOp],
          changes: [
            { kind: "added" as const, object: "column", name: "public.ci_runs.statistics_payload_id" },
          ],
        },
      }),
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("<sub>Added column public.ci_runs.statistics_payload_id</sub>");
    expect(output).not.toContain("columns.17");
  });

  test("template renders no schema section when unchanged", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      runMetadata: makeMetadata({ schemaChange: { changed: false, operations: [] } }),
    });
    const output = renderTemplate(ctx);
    expect(output).not.toContain("schema change");
  });

  test("singular wording for a single schema change", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      comparisonBranch: "main",
      gates: [{ condition: "schema-drift", label: "Schema drift", fired: true, conclusion: "failure", found: "The schema changed against the baseline" }],
      runMetadata: makeMetadata({
        schemaChange: { changed: true, operations: [addedTableOp] },
      }),
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("<sub>Added table public.orders</sub>");
  });
});

describe("test-presence verdict rendering", () => {
  const verdict = {
    condition: "untested-data-access" as const,
    verdictClass: "uncertain-conservative-flag" as const,
    reason: "This PR changes data-access code but could not verify it.",
    nextStep: "Add a repository/integration test that exercises it.",
    triageHint: "Note why on the PR if no test is needed.",
    dataAccessFiles: [
      {
        path: "apps/api/src/users/user.repository.ts",
        evidence: { rule: "db-query-method", line: 1, matched: "db.insert" },
      },
    ],
  };

  test("renders a blocking caution block, reason, next step, and flagged file — never a Warning heading", () => {
    const output = renderTemplate(
      makeContext({
        testPresenceVerdict: verdict,
        testPresenceConclusion: "failure",
      }),
    );
    expect(output).toContain("[!CAUTION]");
    expect(output).not.toContain("[!WARNING]");
    expect(output).toContain(
      "Could not verify — this PR changes queries with no related data-layer test.",
    );
    expect(output).toContain(verdict.reason);
    expect(output).toContain(verdict.nextStep);
    expect(output).toContain("`apps/api/src/users/user.repository.ts`");
    expect(output).toContain(verdict.triageHint);
  });

  test("renders a non-blocking note block when the policy softened the verdict to neutral", () => {
    const output = renderTemplate(
      makeContext({
        testPresenceVerdict: verdict,
        testPresenceConclusion: "neutral",
      }),
    );
    expect(output).toContain("[!NOTE]");
    expect(output).not.toContain("[!CAUTION]");
    expect(output).not.toContain("[!WARNING]");
    expect(output).toContain(verdict.reason);
  });

  test("omits the block entirely when there is no verdict", () => {
    const output = renderTemplate(makeContext());
    expect(output).not.toContain(
      "Could not verify — this PR changes queries",
    );
  });
});

describe("modeled-tables notice (Site#3420)", () => {
  const MODELED_SENTENCE = "aren't covered by the statistics you loaded";

  test("builds the notice on the comparison path", () => {
    const vm = buildViewModel(
      makeContext({
        comparison: makeComparison(),
        modeledTables: ["public.invoices"],
      }),
    );
    expect(vm.modeledTablesNotice).toEqual({
      count: 1,
      list: "`public.invoices`",
    });
  });

  // The no-baseline run is the one that matters: buildViewModel returns early
  // for it from a separate object literal, so a field added only to the other
  // return vanishes here — silently, and exactly where an unverified cost is
  // most likely to read as a clean pass.
  test("builds the notice on the non-comparison path too", () => {
    const vm = buildViewModel(
      makeContext({ modeledTables: ["public.invoices"] }),
    );
    expect(vm.hasComparison).toBe(false);
    expect(vm.modeledTablesNotice).toEqual({
      count: 1,
      list: "`public.invoices`",
    });
  });

  test("caps the list at ten names and counts the rest", () => {
    const tables = Array.from({ length: 13 }, (_, i) => `public.t${i}`);
    const vm = buildViewModel(makeContext({ modeledTables: tables }));
    expect(vm.modeledTablesNotice?.count).toBe(13);
    expect(vm.modeledTablesNotice?.list).toBe(
      "`public.t0`, `public.t1`, `public.t2`, `public.t3`, `public.t4`, `public.t5`, `public.t6`, `public.t7`, `public.t8`, `public.t9`, and 3 more",
    );
  });

  test("is null when the snapshot covers the whole schema", () => {
    expect(buildViewModel(makeContext({ modeledTables: [] })).modeledTablesNotice).toBeNull();
  });

  test("is null when the run carries no modeled-tables list at all", () => {
    expect(buildViewModel(makeContext()).modeledTablesNotice).toBeNull();
  });

  test("renders a non-blocking note naming the tables", () => {
    const output = renderTemplate(
      makeContext({
        comparison: makeComparison(),
        modeledTables: ["public.invoices", "public.line_items"],
      }),
    );
    expect(output).toContain("[!NOTE]");
    expect(output).not.toContain("[!CAUTION]");
    expect(output).not.toContain("[!WARNING]");
    expect(output).toContain(
      "**2 table(s) in your schema aren't covered by the statistics you loaded**",
    );
    expect(output).toContain("`public.invoices`, `public.line_items`");
    expect(output).toContain("A query touching one isn't a clean pass.");
  });

  test("renders the note on a run with no baseline", () => {
    const output = renderTemplate(
      makeContext({ modeledTables: ["public.invoices"] }),
    );
    expect(output).toContain(MODELED_SENTENCE);
    expect(output).toContain("`public.invoices`");
  });

  test("renders nothing when there are no modeled tables", () => {
    expect(renderTemplate(makeContext({ modeledTables: [] }))).not.toContain(
      MODELED_SENTENCE,
    );
    expect(renderTemplate(makeContext())).not.toContain(MODELED_SENTENCE);
  });
});

describe("gates-first comment (ADR-0009)", () => {
  test("leads with the roster counts, not the query count", () => {
    const ctx = makeContext({
      gates: [
        { condition: "new-query-index", label: "New query with index recommendation", fired: true, conclusion: "failure", found: "2 new queries ship a high-impact index recommendation" },
        { condition: "regression-beyond-threshold", label: "Cost regression", fired: false, conclusion: "success", found: "No query got more expensive than the threshold allows" },
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
      ],
    });

    expect(renderTemplate(ctx)).toContain("1 failing and 2 successful checks");
  });

  test("names every condition, whether or not it fired", () => {
    const ctx = makeContext({
      gates: [
        { condition: "new-query-index", label: "New query with index recommendation", fired: true, conclusion: "failure", found: "2 new queries ship a high-impact index recommendation" },
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("New query with index recommendation");
    expect(output).toContain("Schema drift");
  });
});

describe("gate detail expands only when a gate fired (ADR-0009)", () => {
  test("a passing gate contributes no detail", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      gates: [
        { condition: "regression-beyond-threshold", label: "Cost regression", fired: false, conclusion: "success", found: "No query got more expensive than the threshold allows" },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("Cost regression");
    expect(output).not.toContain("CREATE INDEX");
  });

  test("the footer carries the run link and the MCP call", () => {
    const ctx = makeContext({
      gates: [
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
      ],
      runUrl: "https://app.querydoctor.com/query-doctor/site/ci/abc",
      runMetadata: {
        footer: 'get_ci_run({ runId: "abc" })',
        rollupText: "",
        docsUrl: "https://docs.querydoctor.com",
        queries: [],
        signalKeys: [],
        runId: "abc",
      } as never,
    });
    const output = renderTemplate(ctx);

    expect(output).toContain('get_ci_run({ runId: "abc" })');
    expect(output).toContain('<a href="https://app.querydoctor.com/query-doctor/site/ci/abc">view run</a>');
  });
});

describe("heading wording", () => {
  test("drops the failing half when nothing failed", () => {
    const ctx = makeContext({
      gates: [
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
        { condition: "new-query", label: "New query", fired: false, conclusion: "success", found: "No new queries" },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("Query Doctor — 2 successful checks");
    expect(output).not.toContain("0 failing");
  });

  test("keeps both halves when something failed", () => {
    const ctx = makeContext({
      gates: [
        { condition: "new-query-index", label: "New query with index recommendation", fired: true, conclusion: "failure", found: "2 new queries ship a high-impact index recommendation" },
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
      ],
    });

    expect(renderTemplate(ctx)).toContain("Query Doctor — 1 failing and 1 successful check");
  });
});

describe("callSite", () => {
  test("names a query by its function and file", () => {
    expect(
      callSite([
        { key: "func_name", value: "CiRepository.findLatest" },
        { key: "file", value: "/home/runner/work/Site/Site/apps/api/src/ci/ci.repository.ts:210:8" },
      ]),
    ).toEqual({
      name: "CiRepository.findLatest",
      file: "apps/api/src/ci/ci.repository.ts:210:8",
    });
  });

  test("falls back to the file when the function is missing", () => {
    expect(
      callSite([{ key: "file", value: "apps/api/src/ci/ci.repository.ts:12:3" }]),
    ).toEqual({ name: "apps/api/src/ci/ci.repository.ts:12:3", file: undefined });
  });

  test("returns nothing when the run carries no tags", () => {
    expect(callSite([])).toBeUndefined();
  });
});

describe("cost regression detail", () => {
  test("a fired regression gate lists the queries that got more expensive", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [
          { hash: "h1", query: "q", formattedQuery: "SELECT 1", tags: [],
            previousCost: 1211, currentCost: 1289, regressionPercentage: 6.4 },
        ],
      }),
      gates: [
        { condition: "regression-beyond-threshold", label: "Cost regression", fired: true, conclusion: "failure", found: "1 query got more expensive" },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("1,211");
    expect(output).toContain("1,289");
  });
});

describe("regression rows carry the call site", () => {
  test("names the function instead of the SQL preview", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [{ hash: "h1", query: "q", formattedQuery: "SELECT 1",
          tags: [{ key: "func_name", value: "DashboardRepository.findFunnelCounts" }],
          previousCost: 20965, currentCost: 37205, regressionPercentage: 77 }],
      }),
      gates: [{ condition: "regression-beyond-threshold", label: "Cost regression", fired: true, conclusion: "failure", found: "1 query got more expensive" }],
    });

    expect(renderTemplate(ctx)).toContain("DashboardRepository.findFunnelCounts");
  });
});

describe("gate icons", () => {
  test("wraps each glyph so GitHub does not turn it into a link", () => {
    const ctx = makeContext({
      gates: [
        { condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("<picture><img src=");
    expect(output).toContain("</picture>");
  });
});

describe("table growth explains a regression", () => {
  test("names the table that grew under a fired regression gate", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [{ hash: "h1", query: "q", formattedQuery: "SELECT 1", tags: [],
          previousCost: 20965, currentCost: 37205, regressionPercentage: 77 }],
      }),
      gates: [{ condition: "regression-beyond-threshold", label: "Cost regression", fired: true, conclusion: "failure", found: "1 query went up more than 10%" }],
      tableGrowth: [{ table: "project_queries", before: 3503, after: 6290, percent: 80 }],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("project_queries");
    expect(output).toContain("80%");
  });

  test("says nothing when no table grew", () => {
    const ctx = makeContext({
      comparison: makeComparison(),
      gates: [{ condition: "regression-beyond-threshold", label: "Cost regression", fired: true, conclusion: "failure", found: "1 query went up more than 10%" }],
      tableGrowth: [],
    });

    expect(renderTemplate(ctx)).not.toContain("grew");
  });
});

describe("branding", () => {
  test("names Query Doctor in the heading", () => {
    const ctx = makeContext({
      gates: [{ condition: "schema-drift", label: "Schema drift", fired: false, conclusion: "success", found: "No schema changes" }],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("Query Doctor");
    expect(output).toContain("assets/brand/mark.svg");
  });
});

describe("table growth is capped", () => {
  test("names the three biggest and counts the rest", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        regressed: [{ hash: "h1", query: "q", formattedQuery: "SELECT 1", tags: [],
          previousCost: 200, currentCost: 400, regressionPercentage: 100 }],
      }),
      gates: [{ condition: "regression-beyond-threshold", label: "Cost regression", fired: true, conclusion: "failure", found: "1 query went up" }],
      tableGrowth: [
        { table: "project_queries", before: 3503, after: 6290, percent: 80 },
        { table: "oauth_tokens", before: 111, after: 142, percent: 28 },
        { table: "sessions", before: 12, after: 15, percent: 25 },
        { table: "project_schemas", before: 584, after: 693, percent: 19 },
      ],
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("project_queries");
    expect(output).not.toContain("project_schemas");
    expect(output).toContain("1 more");
  });
});
