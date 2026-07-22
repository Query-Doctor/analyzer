import type { ComputedStats, IndexIdentifier, StatisticsMode } from "@query-doctor/core";
import type {
  CiRunMetadata,
  IngestFailureKind,
  RunComparison,
} from "./site-api.ts";
import type { TestPresenceVerdict } from "../gate/test-presence.ts";

export interface Reporter {
  provider(): string;
  report(ctx: ReportContext): Promise<void>;
}

export function isQueryLong(query: string): boolean {
  if (query.length > 100) {
    return true;
  }
  const lines = query.split(/\n/g).length;

  return lines > 10;
}

function walkExplain(explainPlan: object, callback: (node: object) => void) {
  if (typeof explainPlan === "object" && explainPlan !== null) {
    callback(explainPlan);
    for (const key in explainPlan) {
      walkExplain(explainPlan[key as keyof typeof explainPlan], callback);
    }
  }
}

export function renderExplain(explainPlan: object): string {
  walkExplain(explainPlan, (node) => {
    if (node && "Output" in node && Array.isArray(node.Output)) {
      const output = node.Output as string[];
      if (output.length > 4) {
        output[3] = `... ${output.length - 4} selected columns omitted ...`;
      }
      node.Output = output.slice(0, 4);
    }
  });
  return JSON.stringify(explainPlan, null, 2);
}

export function deriveIndexStatistics(indexes: ReportIndexRecommendation[]) {
  const indexUsage = new Map<IndexIdentifier, IndexStatistic>();
  for (const index of indexes) {
    for (const proposedIndex of index.proposedIndexes) {
      const existing = indexUsage.get(proposedIndex);
      if (existing) {
        existing.usageCount++;
      } else {
        indexUsage.set(proposedIndex, { usageCount: 1 });
      }
    }
  }
  return Array.from(indexUsage.entries()).sort(
    (a, b) => b[1].usageCount - a[1].usageCount,
  );
}

export type ReportMetadata = {
  logSize: number;
  timeElapsed: number;
};

declare const s: unique symbol;

export interface ReportStatistics {
  /** Number of unique queries analyzed and uploaded to the site */
  analyzed: number;
  /** Number of queries that matched the query pattern */
  matched: number;
  /** Number of queries that had an index recommendation */
  optimized: number;
  /** Number of queries that errored out and were skipped */
  errored: number;
}

export interface ReportContext {
  statisticsMode: StatisticsMode;
  computedStats?: ComputedStats;
  recommendations: ReportIndexRecommendation[];
  queriesPastThreshold: ReportQueryCostWarning[];
  queryStats: Readonly<ReportStatistics>;
  statistics: [IndexIdentifier, IndexStatistic][];
  metadata: ReportMetadata;
  error?: Error;
  comparison?: RunComparison;
  comparisonBranch?: string;
  /**
   * The baseline fetch failed transiently (timeout/5xx) after retries, so the
   * comparison was skipped this run — distinct from a genuine missing baseline.
   * Drives a "temporarily unavailable, re-run" message instead of the
   * "no baseline / add a push trigger" copy (Site#3287).
   */
  comparisonUnavailable?: boolean;
  /**
   * `POST /ci/runs` failed, so the run wasn't saved to the dashboard. Drives a
   * prominent failure banner in the comment so the run doesn't silently vanish;
   * `kind` tailors the copy (transient → retry, auth → fix token, too_large →
   * payload over the size limit, rejected → our bug).
   */
  ingestError?: {
    kind: IngestFailureKind;
    status: number | null;
    message: string;
  };
  /** The run page link (`metadata.url` from `POST /ci/runs`). Absent when the repo isn't linked. */
  runUrl?: string;
  /** Unified CI-signal metadata: roll-up line, footer, per-query links, docs link, icon keys. */
  runMetadata?: CiRunMetadata;
  /**
   * The crude test-presence gate (#3496) flagged this PR: data-access code
   * changed with no data-layer test alongside it. Rendered as a conservative
   * "could not verify" banner in the comment; also fails the check in `main`.
   * A pure diff heuristic — independent of the baseline comparison.
   */
  testPresenceVerdict?: TestPresenceVerdict;
  /**
   * Tables ("schema.table") in the analyzed schema the production snapshot
   * doesn't cover, so their costs were modeled by the synthesizer rather than
   * verified against real data. Empty when the snapshot covers the whole schema.
   * Not yet rendered in the comment — plumbed for the surfacing that follows.
   */
  modeledTables?: string[];
}

export interface IndexStatistic {
  usageCount: number;
}

export interface ReportIndexRecommendation {
  fingerprint: string;
  formattedQuery: string;
  baseCost: number;
  baseExplainPlan: object;
  optimizedCost: number;
  existingIndexes: string[];
  proposedIndexes: IndexIdentifier[];
  explainPlan: object;
}

export interface ReportQueryCostWarning {
  fingerprint: string;
  formattedQuery: string;
  baseCost: number;
  explainPlan: object;
  maxCost: number;
  /** if the query was optimized */
  optimization?: {
    newCost: number;
    existingIndexes: string[];
    proposedIndexes: IndexIdentifier[];
  };
}
