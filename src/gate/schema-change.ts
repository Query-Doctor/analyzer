// The schema-change gate (Site#3289). The API already computes the real schema
// diff between the PR and the baseline (`runMetadata.schemaChange`); this gate
// only decides the check outcome from it. It blocks by default so a person
// validates the migration before merge — the value is a human eyeball on every
// schema change, independent of any cost delta. A repo softens it to `warn` or
// `off` via the schema-drift policy (#3500). Detection is not this gate's job.

import type { RepoPolicyConfig } from "@query-doctor/core";
import { resolveVerdict } from "./policy.ts";

/** The schema diff the API returns on a run (`runMetadata.schemaChange`). */
export interface SchemaChangeSignal {
  changed: boolean;
}

export interface SchemaGateResult {
  /** `failure` blocks the check; `neutral` is a surfaced, non-blocking warning. */
  conclusion: "failure" | "neutral";
  message: string;
}

const MESSAGE =
  "This PR changes the database schema — validate the migration before merge. " +
  "To stop schema changes from blocking this repo, set the schema-drift check " +
  "to warn or off in CI settings.";

/**
 * Decide the schema-change gate from the API's schema diff and the repo policy.
 * Returns the check outcome when the PR changes the schema and the policy
 * surfaces it, or `null` when there is no change or the policy is `off`.
 */
export function gateSchemaChange(
  schemaChange: SchemaChangeSignal | null | undefined,
  config: RepoPolicyConfig = {},
): SchemaGateResult | null {
  if (!schemaChange?.changed) return null;
  const { conclusion, surfaced } = resolveVerdict(
    { condition: "schema-drift", verdictClass: "finding" },
    config,
  );
  if (!surfaced || conclusion === "success") return null;
  return { conclusion, message: MESSAGE };
}
