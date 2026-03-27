import { test, expect, vi, afterEach } from "vitest";
import { fetchAnalyzerConfig, DEFAULT_CONFIG } from "./config.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("returns parsed config from successful response", async () => {
  const config = {
    minimumCost: 100,
    regressionThreshold: 0.5,
    ignoredQueryHashes: ["abc123"],
    acknowledgedQueryHashes: [],
    comparisonBranch: undefined,
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(config, { status: 200 }),
  );

  const result = await fetchAnalyzerConfig("https://api.example.com", "my/repo");
  expect(result).toEqual(config);
});

test("returns defaults when response is not ok", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Not Found", { status: 404 }),
  );

  const result = await fetchAnalyzerConfig("https://api.example.com", "my/repo");
  expect(result).toEqual(DEFAULT_CONFIG);
});

test("returns defaults when fetch throws", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

  const result = await fetchAnalyzerConfig("https://api.example.com", "my/repo");
  expect(result).toEqual(DEFAULT_CONFIG);
});

test("constructs correct URL with trailing slash stripped", async () => {
  const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(DEFAULT_CONFIG, { status: 200 }),
  );

  await fetchAnalyzerConfig("https://api.example.com/", "org/repo");
  expect(mockFetch).toHaveBeenCalledWith(
    "https://api.example.com/ci/repos/org%2Frepo/config",
    expect.any(Object),
  );
});

test("encodes repo name in URL", async () => {
  const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(DEFAULT_CONFIG, { status: 200 }),
  );

  await fetchAnalyzerConfig("https://api.example.com", "org/repo with spaces");
  expect(mockFetch).toHaveBeenCalledWith(
    "https://api.example.com/ci/repos/org%2Frepo%20with%20spaces/config",
    expect.any(Object),
  );
});

test("passes through partial response with missing optional fields", async () => {
  const partial = {
    minimumCost: 50,
    regressionThreshold: 0.1,
    ignoredQueryHashes: [],
    // all required fields present
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(partial, { status: 200 }),
  );

  const result = await fetchAnalyzerConfig("https://api.example.com", "my/repo");
  expect(result.minimumCost).toBe(50);
  expect(result.regressionThreshold).toBe(0.1);
  expect(result.ignoredQueryHashes).toEqual([]);
});
