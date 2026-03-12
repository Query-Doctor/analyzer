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

export async function fetchAnalyzerConfig(
  endpoint: string,
  repo: string,
): Promise<AnalyzerConfig> {
  const url = `${endpoint.replace(/\/$/, "")}/ci/repos/${encodeURIComponent(repo)}/config`;
  console.log(`Fetching config from ${url}`);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`Config fetch returned ${response.status}, using defaults`);
      return DEFAULT_CONFIG;
    }
    const data = (await response.json()) as Partial<AnalyzerConfig>;
    console.log(
      `Config loaded: minimumCost=${data.minimumCost}, regressionThreshold=${data.regressionThreshold}, ignoredHashes=${data.ignoredQueryHashes?.length ?? 0}, acknowledgedHashes=${data.acknowledgedQueryHashes?.length ?? 0}, comparisonBranch=${data.comparisonBranch ?? "(same branch)"}`,
    );
    return {
      minimumCost: data.minimumCost ?? 0,
      regressionThreshold: data.regressionThreshold ?? 0,
      ignoredQueryHashes: data.ignoredQueryHashes ?? [],
      acknowledgedQueryHashes: data.acknowledgedQueryHashes ?? [],
      comparisonBranch: data.comparisonBranch,
    };
  } catch (err) {
    console.warn(`Failed to fetch config: ${err}. Using defaults`);
    return DEFAULT_CONFIG;
  }
}
