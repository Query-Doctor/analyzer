import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import n from "nunjucks";
import { formatCost, queryPreview, buildViewModel } from "./github.ts";
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

  test("template lists a new query that has no index suggestion", () => {
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
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("This PR introduces new queries");
    expect(output).toContain('SELECT "id" FROM "matches"');
    expect(output).toContain("cost 42 · no index suggestion");
  });

  test("renders multiple new queries as separate list items (#158)", () => {
    const ctx = makeContext({
      comparison: makeComparison({
        newQueries: [
          {
            hash: "new-sessions",
            query: 'SELECT "id" FROM "sessions"',
            formattedQuery: 'SELECT "id" FROM "sessions"',
            nudges: [], tags: [], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 1, indexesUsed: ["sessions_pkey"] },
          },
          {
            hash: "new-item-watches",
            query: 'SELECT "id" FROM "item_watches"',
            formattedQuery: 'SELECT "id" FROM "item_watches"',
            nudges: [], tags: [], tableReferences: [],
            optimization: { state: "no_improvement_found", cost: 1, indexesUsed: ["item_watches_pkey"] },
          },
        ],
      }),
    });
    const output = renderTemplate(ctx);
    // trimBlocks strips the newline after a trailing block tag, which used to
    // glue consecutive bullets together (`… no index suggestion- SELECT …`).
    expect(output).not.toMatch(/no index suggestion-\s*<code>/);
    expect(output).toContain(
      'no index suggestion\n- <code>SELECT "id" FROM "item_watches"</code>',
    );
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

  test("improvements surface in displayImproved with indexesChanged true", () => {
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
    expect(output).toContain("5 queries analyzed");
  });

  test("renders queryStats.analyzed in no-comparison mode", () => {
    const ctx = makeContext({
      queryStats: { analyzed: 3, matched: 1, optimized: 0, errored: 0 },
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("3 queries analyzed");
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
    expect(output).toContain("2 regressed · 1 improved · 3 new · 0 removed");
    // Footer rendered verbatim.
    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    // Per-query rows link via metadata.queries, not a re-derived /ixr/ route.
    expect(output).toContain("https://app.querydoctor.com/alice/proj/ci/9f3a1c20/regressed-1");
    expect(output).toContain("https://app.querydoctor.com/alice/proj/ci/9f3a1c20/improved-1");
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
    expect(output).toContain("2 regressed · 1 improved · 3 new · 0 removed");
    expect(output).toContain('More detail → get_ci_run({ runId: "9f3a1c20" })');
    expect(output).toContain('<a href="https://docs.querydoctor.com">docs</a>');
    // No run link, no per-query links when the repo isn't linked.
    expect(output).not.toContain("view run");
    expect(output).not.toContain("https://app.querydoctor.com/alice/proj/ci");
    // Query previews still render, just without anchors.
    expect(output).toContain("<code>SELECT 1</code>");

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
    expect(output).toContain("add a `push` trigger");
    expect(output).not.toContain("temporarily unavailable");
  });

  test("transient fetch failure renders a re-run message, not the no-baseline copy", () => {
    const ctx = makeContext({
      comparisonBranch: "staging",
      comparisonUnavailable: true,
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("comparison temporarily unavailable");
    expect(output).toContain("re-run the check");
    // Must not tell the user to add a trigger that is already in place.
    expect(output).not.toContain("No baseline on `staging`");
    expect(output).not.toContain("add a `push` trigger");
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
      runMetadata: makeMetadata({
        schemaChange: { changed: true, operations: [addedTableOp, droppedIndexOp] },
      }),
    });
    const output = renderTemplate(ctx);

    expect(output).toContain("2 schema changes vs <code>main</code>");
    expect(output).toContain("**Added**");
    expect(output).toContain("table public.orders");
    expect(output).toContain("**Removed**");
    expect(output).toContain("index (removed)");
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
      runMetadata: makeMetadata({
        schemaChange: { changed: true, operations: [addedTableOp] },
      }),
    });
    const output = renderTemplate(ctx);
    expect(output).toContain("1 schema change vs <code>main</code>");
    expect(output).not.toContain("1 schema changes");
  });
});

describe("test-presence verdict rendering", () => {
  const verdict = {
    condition: "untested-data-access" as const,
    verdictClass: "uncertain-conservative-flag" as const,
    reason: "This PR changes data-access code but could not verify it.",
    nextStep: "Add a repository/integration test that exercises it.",
    triageHint: "Note why on the PR if no test is needed.",
    dataAccessFiles: ["apps/api/src/users/user.repository.ts"],
  };

  test("renders the unverified banner, reason, next step, and flagged file", () => {
    const output = renderTemplate(makeContext({ testPresenceVerdict: verdict }));
    expect(output).toContain("[!WARNING]");
    expect(output).toContain(
      "Unverified — this PR changes data-access code with no data-layer test.",
    );
    expect(output).toContain(verdict.reason);
    expect(output).toContain(verdict.nextStep);
    expect(output).toContain("`apps/api/src/users/user.repository.ts`");
    expect(output).toContain(verdict.triageHint);
  });

  test("omits the banner entirely when there is no verdict", () => {
    const output = renderTemplate(makeContext());
    expect(output).not.toContain("Unverified — this PR changes data-access code");
  });
});
