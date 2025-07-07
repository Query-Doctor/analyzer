export interface Reporter {
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
  return Array.from(indexUsage.entries()).sort((a, b) =>
    b[1].usageCount - a[1].usageCount
  );
}

export type ReportMetadata = {
  logSize: number;
  timeElapsed: number;
};

declare const s: unique symbol;
export type IndexIdentifier = string & { [s]: never };

export interface ReportContext {
  recommendations: ReportIndexRecommendation[];
  statistics: [IndexIdentifier, IndexStatistic][];
  metadata: ReportMetadata;
  queriesMatched: number;
  queriesSeen: number;
  error?: Error;
}

export interface IndexStatistic {
  usageCount: number;
}

export interface ReportIndexRecommendation {
  fingerprint: number;
  formattedQuery: string;
  baseCost: number;
  optimizedCost: number;
  existingIndexes: string[];
  proposedIndexes: IndexIdentifier[];
  explainPlan: object;
}
