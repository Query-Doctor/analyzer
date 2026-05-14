export interface AnalyzerConfig {
  minimumCost: number;
  regressionThreshold: number;
  ignoredQueryHashes: string[];
  acknowledgedQueryHashes: string[];
  comparisonBranch?: string;
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  minimumCost: 0,
  regressionThreshold: 0,
  ignoredQueryHashes: [],
  acknowledgedQueryHashes: [],
};
