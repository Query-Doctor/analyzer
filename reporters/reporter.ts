import type { StatisticsMode } from "../optimizer/statistics.ts";

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

export function renderExplain(explainPlan: object): string {
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
export type IndexIdentifier = string & { [s]: never };

export interface ReportStatistics {
  /** Total number of queries seen in the log */
  total: number;
  /** Number of queries that matched the query pattern */
  matched: number;
  /** Number of queries that had an index recommendation */
  optimized: number;
  /** Number of queries that errored out and were skipped */
  errored: number;
}

export interface ReportContext {
  statisticsMode: StatisticsMode;
  recommendations: ReportIndexRecommendation[];
  queriesPastThreshold: ReportQueryCostWarning[];
  queryStats: Readonly<ReportStatistics>;
  statistics: [IndexIdentifier, IndexStatistic][];
  metadata: ReportMetadata;
  error?: Error;
}

export interface IndexStatistic {
  usageCount: number;
}

export interface ReportIndexRecommendation {
  fingerprint: number;
  formattedQuery: string;
  baseCost: number;
  baseExplainPlan: object;
  optimizedCost: number;
  existingIndexes: string[];
  proposedIndexes: IndexIdentifier[];
  explainPlan: object;
}

export interface ReportQueryCostWarning {
  fingerprint: number;
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
