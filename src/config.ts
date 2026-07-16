import type { RepoPolicyConfig } from "@query-doctor/core";

export interface AnalyzerConfig {
  minimumCost: number;
  regressionThreshold: number;
  ignoredQueryHashes: string[];
  acknowledgedQueryHashes: string[];
  comparisonBranch?: string;
  /**
   * Per-condition CI policy overrides (#3500): condition key → `fail | warn | off`.
   * Absent keys fall back to core's safe defaults, so `untested-data-access` blocks
   * unless a repo softens it. Optional and empty until the Site repo config plumbs
   * it through `getRepoConfig`; the gate honours it the moment it arrives.
   */
  conditionPolicies?: RepoPolicyConfig;
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  minimumCost: 0,
  regressionThreshold: 0,
  ignoredQueryHashes: [],
  acknowledgedQueryHashes: [],
};
