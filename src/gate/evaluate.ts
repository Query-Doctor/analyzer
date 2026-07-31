// One roster of every gate condition, resolved before the report renders.
//
// The per-condition gates (`gateRegression`, `gateNewQuery`, `gateSchemaChange`)
// each answer "does this block?" and return `null` otherwise, which is enough to
// set the check but not to describe the run: a condition that found nothing is
// indistinguishable from one that is switched off. The comment needs both, and it
// needs them *before* it renders — today gating happens after `runner.report`, so
// the comment cannot state its own check result.
//
// This produces the full roster instead, so the comment and the check read the
// same array and cannot disagree.

import { policyFor, type CiConclusion, type RepoPolicyConfig } from "@query-doctor/core";
import { resolveVerdict } from "./policy.ts";

/**
 * The conditions a run reports on, in the order the dashboard's Gate Policies
 * screen lists them.
 *
 * DUPLICATED from `CI_CONDITIONS` in @query-doctor/types, which the dashboard
 * renders. The analyzer cannot depend on that Site package, so these labels are
 * copied rather than shared, and the two can drift — a condition renamed in the
 * settings screen keeps its old name in the PR comment until this is edited too.
 * Collapse into one catalogue when the analyzer merges into the Site repo.
 */
export const GATE_CONDITIONS = [
  { condition: "regression-beyond-threshold", label: "Cost regression" },
  { condition: "untested-data-access", label: "Untested data access" },
  { condition: "new-query", label: "New query" },
  { condition: "new-query-index", label: "New query with index recommendation" },
  { condition: "schema-drift", label: "Schema drift" },
  { condition: "high-value-nudge", label: "High-value nudge" },
] as const;

export type GateCondition = (typeof GATE_CONDITIONS)[number]["condition"];

export interface GateOutcome {
  condition: GateCondition;
  /** The condition's name as the Gate Policies screen shows it. */
  label: string;
  /** True when the condition found something, whatever the policy then does with it. */
  fired: boolean;
  /** `failure` blocks the check, `neutral` surfaces it, `success` is a clean pass. */
  conclusion: CiConclusion;
  /** What the condition found, or that it found nothing. Rendered verbatim. */
  found: string;
}

/** The facts each condition is decided from. Absent members mean "found nothing". */
export interface GateFacts {
  /** Untriaged regressions already past the repo's threshold (`comparison.regressed`). */
  regressedCount?: number;
  /** Queries with no baseline on the comparison branch. */
  newQueryCount?: number;
  /** The subset of those carrying a beyond-threshold index recommendation. */
  indexedNewQueryCount?: number;
  /** The API's schema diff reported a change against the comparison branch. */
  schemaChanged?: boolean;
  /** Changed data-access files with no data-layer test alongside them. */
  untestedDataAccessFileCount?: number;
  /** Queries carrying a high-value rewrite or index nudge. */
  highValueNudgeCount?: number;
  /** The repo's regression threshold, as a percentage. Named in the gate's line. */
  regressionThreshold?: number;
  /** The repo's cost floor. A regression under it on both sides is ignored. */
  minimumCost?: number;
}


const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What each condition found. Held to the `writing` skill: a fact and a count. */
function describe(condition: GateCondition, facts: GateFacts): string {
  const regressed = facts.regressedCount ?? 0;
  const newQueries = facts.newQueryCount ?? 0;
  const indexed = facts.indexedNewQueryCount ?? 0;
  const untested = facts.untestedDataAccessFileCount ?? 0;
  const nudges = facts.highValueNudgeCount ?? 0;

  switch (condition) {
    case "regression-beyond-threshold": {
      // Name the rule, not just the count: the run page reports every increase,
      // so a bare number here reads as a contradiction of it.
      const pct = facts.regressionThreshold;
      const bar = pct === undefined ? "" : ` more than ${pct}%`;
      const floor =
        facts.minimumCost && facts.minimumCost > 0
          ? `, where either cost is at least ${facts.minimumCost}`
          : "";
      return regressed > 0
        ? `${regressed} ${plural(regressed, "query went up", "queries went up")}${bar}${floor}`
        : `No query went up${bar}`;
    }
    case "untested-data-access":
      return untested > 0
        ? `${untested} changed data-access ${plural(untested, "file ships", "files ship")} with no related test`
        : "No changed data-access file without a test";
    case "new-query":
      return newQueries > 0
        ? plural(newQueries, "1 new query, with no prior baseline", `${newQueries} new queries, none with a prior baseline`)
        : "No new queries";
    case "new-query-index":
      return indexed > 0
        ? `${indexed} new ${plural(indexed, "query ships", "queries ship")} a high-impact index recommendation`
        : "No new query ships an index recommendation";
    case "schema-drift":
      return facts.schemaChanged ? "The schema changed against the baseline" : "No schema changes";
    case "high-value-nudge":
      return nudges > 0
        ? `${nudges} ${plural(nudges, "query carries", "queries carry")} a rewrite worth making`
        : "No index or rewrite past the threshold";
  }
}

export interface GateSummary {
  /** Conditions that blocked the check. */
  failing: number;
  /** Conditions that found nothing. */
  successful: number;
  /** Conditions that fired but were capped at non-blocking by a `warn` policy. */
  neutral: number;
  /** The run's conclusion: the most severe outcome on the roster. */
  conclusion: CiConclusion;
}

/**
 * Roll the roster up for the comment heading. Derived from the same array the
 * check reads, so "1 failing and 5 successful checks" cannot contradict the
 * check it sits above.
 */
export function summarizeGates(gates: GateOutcome[]): GateSummary {
  const count = (c: CiConclusion) =>
    gates.filter((g) => g.conclusion === c).length;
  const failing = count("failure");
  return {
    failing,
    successful: count("success"),
    neutral: count("neutral"),
    conclusion: failing > 0 ? "failure" : count("neutral") > 0 ? "neutral" : "success",
  };
}

export function evaluateGates(
  facts: GateFacts,
  config: RepoPolicyConfig = {},
): GateOutcome[] {
  const fired: Record<GateCondition, boolean> = {
    "regression-beyond-threshold": (facts.regressedCount ?? 0) > 0,
    "untested-data-access": (facts.untestedDataAccessFileCount ?? 0) > 0,
    "new-query": (facts.newQueryCount ?? 0) > 0,
    "new-query-index": (facts.indexedNewQueryCount ?? 0) > 0,
    "schema-drift": facts.schemaChanged === true,
    "high-value-nudge": (facts.highValueNudgeCount ?? 0) > 0,
  };

  return GATE_CONDITIONS.flatMap<GateOutcome>(({ condition, label }) => {
    // `off` suppresses the condition everywhere, not just in the check — a repo
    // that switched it off should not read about it in the comment either.
    if (policyFor(condition, config) === "off") return [];

    if (!fired[condition]) {
      return [{ condition, label, fired: false, conclusion: "success", found: describe(condition, facts) }];
    }
    const { conclusion } = resolveVerdict(
      { condition, verdictClass: "finding" },
      config,
    );
    return [{ condition, label, fired: true, conclusion, found: describe(condition, facts) }];
  });
}
