// The new-query gate. `gateEligibleNewQueries` already produces the actionable
// set — new, diff-introduced queries that ship with a beyond-threshold index
// recommendation and aren't acknowledged; this gate only decides the check
// outcome from its size and the repo policy. It blocks by default — unchanged
// from the old inline path — but now routes through the shared policy engine
// (#3500), so a repo can soften it to `warn` or `off` the way it can for
// regressions and untested-data-access. Detection is not this gate's job.

import type { RepoPolicyConfig } from "@query-doctor/core";
import { resolveVerdict } from "./policy.ts";

export interface NewQueryGateResult {
  /** `failure` blocks the check; `neutral` is a surfaced, non-blocking warning. */
  conclusion: "failure" | "neutral";
}

/**
 * Decide the new-query gate from the eligible-new-query count and the repo
 * policy. Returns the check outcome when there are eligible new queries and the
 * policy surfaces them, or `null` when there are none or the policy is `off`.
 *
 * A plain new query is informational (`new-query` defaults to `warn`), but a new
 * query carrying a high-impact index recommendation is actionable while it's
 * still a one-line fix, so it routes under its own `new-query-index` key, a
 * `finding` in the shared taxonomy that defaults to `fail`. A repo that sets
 * nothing blocks exactly as the old inline path did.
 */
export function gateNewQuery(
  eligibleCount: number,
  config: RepoPolicyConfig = {},
): NewQueryGateResult | null {
  if (eligibleCount <= 0) return null;
  const { conclusion, surfaced } = resolveVerdict(
    { condition: "new-query-index", verdictClass: "finding" },
    config,
  );
  if (!surfaced || conclusion === "success") return null;
  return { conclusion };
}
