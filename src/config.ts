export interface AnalyzerConfig {
  minimumCost: number;
  regressionThreshold: number;
  ignoredQueryHashes: string[];
  /**
   * an undefined array means last seen queries
   * should not be applicable. Otherwise every single
   * query would be marked as new.
   */
  lastSeenQueries?: string[];
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  minimumCost: 0,
  regressionThreshold: 0,
  ignoredQueryHashes: [],
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
    const data = (await response.json()) as AnalyzerConfig;
    console.log(
      `Config loaded: minimumCost=${data.minimumCost}, regressionThreshold=${data.regressionThreshold}, ignoredHashes=${data.ignoredQueryHashes?.length ?? 0}`,
    );
    return {
      minimumCost: data.minimumCost,
      regressionThreshold: data.regressionThreshold,
      ignoredQueryHashes: data.ignoredQueryHashes,
      lastSeenQueries: data.lastSeenQueries,
    };
  } catch (err) {
    console.warn(`Failed to fetch config: ${err}. Using defaults`);
    return DEFAULT_CONFIG;
  }
}
