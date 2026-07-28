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
  /**
   * The multiple of the current data the repo asks its queries to be planned
   * against (#3119). 1 is the current size, which is what a repo gets until
   * someone raises it in CI settings.
   */
  statisticsScale?: number;
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  minimumCost: 0,
  regressionThreshold: 0,
  ignoredQueryHashes: [],
  acknowledgedQueryHashes: [],
  statisticsScale: 1,
};

/**
 * The scale a repo is configured at, read off whatever the relay returned.
 *
 * The Site has sent `statisticsScale` on the repo config since #3115, but
 * core's `RepoConfig` type does not declare it, so the read is defensive and
 * lives in this one place. A missing, non-numeric, or sub-1 value means the
 * current data size: an analyzer talking to an older Site keeps working, and a
 * nonsense value never reaches the planner. Drop the cast once core ships the
 * field on `RepoConfig`.
 */
export function configuredStatisticsScale(config: unknown): number {
  const scale = (config as { statisticsScale?: unknown } | null | undefined)
    ?.statisticsScale;
  return typeof scale === "number" && scale >= 1 ? scale : 1;
}
