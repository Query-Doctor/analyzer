// The cost-regression gate. `compareRuns` already produces the untriaged,
// beyond-threshold regression set (`comparison.regressed`, filtered by
// `acknowledgedQueryHashes` and `regressionThreshold`); this gate only decides
// the check outcome from its size and the repo policy. It blocks by default —
// unchanged from the old inline path — but now routes through the shared policy
// engine (#3500), so a repo can soften it to `warn` or `off` the way it can for
// untested-data-access and schema-drift. Detection is not this gate's job.

import type { RepoPolicyConfig } from "@query-doctor/core";
import { resolveVerdict } from "./policy.ts";

export interface RegressionGateResult {
  /** `failure` blocks the check; `neutral` is a surfaced, non-blocking warning. */
  conclusion: "failure" | "neutral";
}

/**
 * Decide the regression gate from the untriaged regression count and the repo
 * policy. Returns the check outcome when there are regressions and the policy
 * surfaces them, or `null` when there are none or the policy is `off`.
 *
 * `regression-beyond-threshold` is a `finding` in the shared taxonomy (concludes
 * `failure`) and defaults to `fail`, so a repo that sets nothing blocks exactly
 * as before. This is a second, repo-wide override layer on top of per-query
 * triage: `off` suppresses the condition regardless of triage, `warn` surfaces
 * every untriaged regression without blocking, `fail` blocks them as today.
 */
export function gateRegression(
  regressedCount: number,
  config: RepoPolicyConfig = {},
): RegressionGateResult | null {
  if (regressedCount <= 0) return null;
  const { conclusion, surfaced } = resolveVerdict(
    { condition: "regression-beyond-threshold", verdictClass: "finding" },
    config,
  );
  if (!surfaced || conclusion === "success") return null;
  return { conclusion };
}
