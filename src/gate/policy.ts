// Resolve a gate verdict to the CI conclusion it produces, using the shared
// failure taxonomy (#3498) and policy engine (#3500) from @query-doctor/core
// rather than a severity the analyzer decides for itself.
//
// The taxonomy fixes what a verdict class concludes: `uncertain-conservative-flag`
// concludes `failure`, so a data-access change Query Doctor could not verify
// blocks the check by default — an unverified result gates, framed as "could not
// check this, flagging to be safe", never as "your query is broken". The per-repo
// policy then decides whether this repo lets that condition fail (`fail`), softens
// it to a surfaced-but-non-blocking neutral (`warn`), or suppresses it (`off`).

import {
  conclusionForVerdict,
  policyFor,
  type CiConclusion,
  type ConditionPolicy,
  type RepoPolicyConfig,
  type VerdictClass,
} from "@query-doctor/core";

export interface ResolvedVerdict {
  /** The effective per-repo policy for the condition. */
  policy: ConditionPolicy;
  /** CI conclusion after policy: `failure` blocks the check, `neutral`/`success` don't. */
  conclusion: CiConclusion;
  /** False only when the policy is `off` — the condition is suppressed, not surfaced anywhere. */
  surfaced: boolean;
}

/**
 * Resolve a verdict's effective conclusion. `off` is reported as unsurfaced (the
 * caller drops the condition — no comment block, no check annotation); every other
 * policy surfaces it, with `warn` capping a taxonomy failure at a non-blocking
 * neutral. The cap mirrors core's policy.ts `applyPolicy`, which core keeps private.
 */
export function resolveVerdict(
  verdict: { condition: string; verdictClass: VerdictClass },
  config: RepoPolicyConfig = {},
): ResolvedVerdict {
  const policy = policyFor(verdict.condition, config);
  if (policy === "off") {
    return { policy, conclusion: "success", surfaced: false };
  }
  const base = conclusionForVerdict(verdict);
  const conclusion = policy === "warn" && base === "failure" ? "neutral" : base;
  return { policy, conclusion, surfaced: true };
}
