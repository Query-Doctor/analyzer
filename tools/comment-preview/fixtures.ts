// Every shape the PR comment can take, as view models the template consumes.
//
// These are `buildViewModel` output, not `ReportContext` input — the point is to
// iterate on `success.md.j2` without a CI run, so the fixtures start where the
// template does. A change to `buildViewModel` itself will not show up here.

import { formatCost } from "../../src/reporters/github/github.ts";
import { schemaChangeLabel } from "../../src/reporters/github/schema-change.ts";

const ASSETS = "https://raw.githubusercontent.com/Query-Doctor/analyzer/main/assets";

/** Fields every fixture shares. Individual fixtures override what they exercise. */
const base = {
  brandMark: `${ASSETS}/brand/mark.svg`,
  gateIconBase: `${ASSETS}/gate`,
  formatCost,
  schemaChangeLabel,
  queryLinks: {},
  displayRecommendations: [],
  displayRegressed: [],
  tableGrowth: [],
  schemaChange: { hasChanges: false, groups: [] },
  hasComparison: true,
  comparisonBranch: "staging",
  runUrl: "https://app.querydoctor.com/query-doctor/site/ci/019faf39",
  queryStats: { analyzed: 103 },
  statisticsMode: { kind: "fromStatisticsExport" },
  runMetadata: {
    footer: 'More detail → get_ci_run(runId: "019faf39")',
    docsUrl: "https://docs.querydoctor.com",
  },
};

const gate = (
  condition: string,
  label: string,
  conclusion: "failure" | "neutral" | "success",
  found: string,
  fired: boolean,
) => ({ condition, label, conclusion, found, fired });

const PASSING = {
  regression: gate("regression-beyond-threshold", "Cost regression", "success", "No query went up more than 10%", false),
  untested: gate("untested-data-access", "Untested data access", "success", "No changed data-access file without a test", false),
  newQuery: gate("new-query", "New query", "success", "No new queries", false),
  newQueryIndex: gate("new-query-index", "New query with index recommendation", "success", "No new query ships an index recommendation", false),
  schema: gate("schema-drift", "Schema drift", "success", "No schema changes", false),
  nudge: gate("high-value-nudge", "High-value nudge", "success", "No index or rewrite past the threshold", false),
};

const allPassing = () => Object.values(PASSING);

const site = (name: string, file: string) => ({ name, file });

const regressedQuery = (
  hash: string,
  name: string,
  file: string,
  previousCost: number,
  currentCost: number,
  regressionPercentage: number,
) => ({ hash, queryPreview: "select …", site: site(name, file), previousCost, currentCost, regressionPercentage });

const recommendation = (
  fingerprint: string,
  name: string,
  file: string,
  baseCost: number,
  optimizedCost: number,
  proposedIndexes: string[],
) => ({ fingerprint, queryPreview: "select …", site: site(name, file), baseCost, optimizedCost, proposedIndexes });

const entry = (kind: string, object: string, name: string, detail?: string) => ({ kind, object, name, detail });

const REGRESSED = [
  regressedQuery("a1", "ProjectQueriesRepository.search", "apps/api/src/projects/project-queries.repository.ts", 1245, 1876, 50.7),
  regressedQuery("b2", "CiRepository.findRunsByProject", "apps/api/src/ci/ci.repository.ts", 880, 1190, 35.2),
];

const RECOMMENDATIONS = [
  recommendation("f1", "DashboardRepository.findFunnelCounts", "apps/api/src/dashboard/dashboard.repository.ts", 4820, 312, [
    "project_queries (project_id, last_seen_at)",
  ]),
  recommendation("f2", "StatisticsRepository.latestSnapshot", "apps/api/src/statistics/statistics.repository.ts", 2100, 640, [
    "statistics_snapshots (project_id, captured_at)",
    "statistics_payloads (project_id)",
  ]),
];

const SCHEMA_GROUPS = [
  {
    kind: "added",
    entries: [
      entry("added", "table", "public.project_table_statistics"),
      entry("added", "table", "public.statistics_payloads"),
      entry("added", "table", "public.statistics_snapshots"),
      entry("added", "index", "statistics_payloads.statistics_payloads_project_id_hash_idx"),
      entry("added", "constraint", "statistics_snapshots.statistics_snapshots_pkey"),
    ],
  },
  { kind: "changed", entries: [entry("changed", "index", "", "isUnique")] },
  { kind: "removed", entries: [entry("removed", "index", "")] },
];

const GROWTH = [
  { table: "project_queries", before: 3503, after: 6290, percent: 80 },
  { table: "ci_runs_queries", before: 41200, after: 52800, percent: 28 },
];

export interface Fixture {
  name: string;
  /** What a reader should be checking in this render. */
  note: string;
  view: Record<string, unknown>;
}

export const fixtures: Fixture[] = [
  {
    name: "clean run",
    note: "The common case. Six lines, no detail, nothing to act on.",
    view: { ...base, gateSummary: { failing: 0, successful: 6, neutral: 0 }, gates: allPassing() },
  },
  {
    name: "cost regression, with table growth",
    note: "The growth note is a caption on the gate row, so it sits tight beneath it.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 5, neutral: 0 },
      tableGrowth: GROWTH,
      displayRegressed: REGRESSED,
      gates: [
        gate("regression-beyond-threshold", "Cost regression", "failure", "2 queries went up more than 10%, where either cost is at least 100", true),
        PASSING.untested, PASSING.newQuery, PASSING.newQueryIndex, PASSING.schema, PASSING.nudge,
      ],
    },
  },
  {
    name: "cost regression, no table growth",
    note: "Same gate with nothing to attribute the move to. The first query still starts where the growth note would.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 5, neutral: 0 },
      displayRegressed: REGRESSED,
      gates: [
        gate("regression-beyond-threshold", "Cost regression", "failure", "2 queries went up more than 10%, where either cost is at least 100", true),
        PASSING.untested, PASSING.newQuery, PASSING.newQueryIndex, PASSING.schema, PASSING.nudge,
      ],
    },
  },
  {
    name: "new query with index recommendation",
    note: "Each recommendation is a name, a caption, and the DDL that clears it.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 4, neutral: 1 },
      displayRecommendations: RECOMMENDATIONS,
      gates: [
        gate("new-query-index", "New query with index recommendation", "failure", "2 new queries ship a high-impact index recommendation", true),
        gate("new-query", "New query", "neutral", "6 new queries, none with a prior baseline", true),
        PASSING.regression, PASSING.untested, PASSING.schema, PASSING.nudge,
      ],
    },
  },
  {
    name: "schema drift",
    note: "Added, Changed and Removed entries. Check the leading in and out of the block.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 5, neutral: 0 },
      schemaChange: { hasChanges: true, groups: SCHEMA_GROUPS },
      gates: [
        gate("schema-drift", "Schema drift", "failure", "The schema changed against the baseline", true),
        PASSING.regression, PASSING.untested, PASSING.newQuery, PASSING.newQueryIndex, PASSING.nudge,
      ],
    },
  },
  {
    name: "everything fires",
    note: "The worst realistic case: three expansions stacked, roster split across them.",
    view: {
      ...base,
      gateSummary: { failing: 3, successful: 2, neutral: 1 },
      tableGrowth: GROWTH,
      displayRegressed: REGRESSED,
      displayRecommendations: RECOMMENDATIONS,
      schemaChange: { hasChanges: true, groups: SCHEMA_GROUPS },
      gates: [
        gate("regression-beyond-threshold", "Cost regression", "failure", "2 queries went up more than 10%, where either cost is at least 100", true),
        gate("new-query-index", "New query with index recommendation", "failure", "2 new queries ship a high-impact index recommendation", true),
        gate("schema-drift", "Schema drift", "failure", "The schema changed against the baseline", true),
        gate("new-query", "New query", "neutral", "6 new queries, none with a prior baseline", true),
        PASSING.untested, PASSING.nudge,
      ],
    },
  },
  {
    name: "volume stress — 12 regressions",
    note: "Where the expansion stops being scannable. Check whether the roster is still findable.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 5, neutral: 0 },
      tableGrowth: GROWTH,
      displayRegressed: Array.from({ length: 12 }, (_, i) =>
        regressedQuery(`h${i}`, `Repository.method${i}`, `apps/api/src/module${i}/module${i}.repository.ts`, 900 + i * 40, 1400 + i * 90, 30 + i * 3),
      ),
      gates: [
        gate("regression-beyond-threshold", "Cost regression", "failure", "12 queries went up more than 10%, where either cost is at least 100", true),
        PASSING.untested, PASSING.newQuery, PASSING.newQueryIndex, PASSING.schema, PASSING.nudge,
      ],
    },
  },
  {
    name: "single of everything",
    note: "Singular wording. Every count is 1.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 4, neutral: 1 },
      displayRegressed: [REGRESSED[0]],
      schemaChange: { hasChanges: true, groups: [{ kind: "added", entries: [entry("added", "table", "public.statistics_snapshots")] }] },
      gates: [
        gate("regression-beyond-threshold", "Cost regression", "failure", "1 query went up more than 10%, where either cost is at least 100", true),
        gate("new-query", "New query", "neutral", "1 new query, with no prior baseline", true),
        PASSING.untested, PASSING.newQueryIndex, PASSING.schema, PASSING.nudge,
      ],
    },
  },
  {
    name: "assumed statistics",
    note: "No production stats loaded. The footer says so instead of claiming a measured run.",
    view: {
      ...base,
      gateSummary: { failing: 0, successful: 6, neutral: 0 },
      statisticsMode: { kind: "fromAssumption", reltuples: 10000000 },
      gates: allPassing(),
    },
  },
  {
    name: "no baseline",
    note: "Nothing to compare against. No gate roster at all.",
    view: { ...base, gateSummary: null, hasComparison: false, comparisonUnavailable: false },
  },
  {
    name: "comparison unavailable",
    note: "Baseline exists but could not be read this run. Must read as temporary.",
    view: { ...base, gateSummary: null, hasComparison: false, comparisonUnavailable: true },
  },
  {
    name: "comparison branch unset",
    note: "Warning callout above the roster.",
    view: {
      ...base,
      gateSummary: { failing: 0, successful: 6, neutral: 0 },
      gates: allPassing(),
      runMetadata: {
        ...base.runMetadata,
        baseline: { unset: true, resolvedBranch: "main", headVsHead: false, mcpCall: 'get_repo_config(repo: "query-doctor/site")' },
      },
    },
  },
  {
    name: "ingest failed — auth",
    note: "Nothing was saved. The reader has to know the numbers below are not on the dashboard.",
    view: {
      ...base,
      gateSummary: { failing: 0, successful: 6, neutral: 0 },
      gates: allPassing(),
      ingestError: { kind: "auth", status: 401 },
    },
  },
  {
    name: "ingest failed — payload too large",
    note: "Re-running will not help. Includes the details disclosure.",
    view: {
      ...base,
      gateSummary: { failing: 0, successful: 6, neutral: 0 },
      gates: allPassing(),
      ingestError: { kind: "too_large", status: 413, message: "payload exceeds 6 MB" },
    },
  },
  {
    name: "untested data access",
    note: "The test-presence callout with its file list.",
    view: {
      ...base,
      gateSummary: { failing: 1, successful: 5, neutral: 0 },
      gates: [
        gate("untested-data-access", "Untested data access", "failure", "2 changed data-access files ship with no related test", true),
        PASSING.regression, PASSING.newQuery, PASSING.newQueryIndex, PASSING.schema, PASSING.nudge,
      ],
      testPresenceVerdict: {
        reason: "Two repository files changed and neither has a data-layer test beside it.",
        nextStep: "Add a test that exercises the changed query against a real planner.",
        dataAccessFiles: ["apps/api/src/projects/project-queries.repository.ts", "apps/api/src/ci/ci.repository.ts"],
        triageHint: "Triage with triage_query if this is intentional.",
      },
      testPresenceConclusion: "failure",
    },
  },
  {
    name: "modeled tables notice",
    note: "Some tables have no loaded statistics, so their costs are modeled.",
    view: {
      ...base,
      gateSummary: { failing: 0, successful: 6, neutral: 0 },
      gates: allPassing(),
      modeledTablesNotice: { count: 3, list: "`audit_log`, `webhooks`, `sessions`" },
    },
  },
];
