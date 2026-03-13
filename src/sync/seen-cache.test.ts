import { test, expect, vi } from "vitest";
import { QueryCache } from "./seen-cache.ts";
import type { RawRecentQuery } from "../sql/recent-query.ts";

function makeRawQuery(query: string): RawRecentQuery {
  return {
    username: "test",
    query,
    formattedQuery: query,
    meanTime: 1,
    calls: "1",
    rows: "1",
    topLevel: true,
  };
}

test("sync skips unparseable queries and returns parseable ones", async () => {
  const cache = new QueryCache();

  const validQuery = makeRawQuery("SELECT 1");
  // DEALLOCATE $1 is a utility statement that the pg parser rejects
  const invalidQuery = makeRawQuery("DEALLOCATE $1");

  const results = await cache.sync([validQuery, invalidQuery]);

  expect(results).toHaveLength(1);
  expect(results[0].query).toContain("SELECT");
});

test("sync returns empty array when all queries fail", async () => {
  const cache = new QueryCache();

  const invalidQuery1 = makeRawQuery("DEALLOCATE $1");
  const invalidQuery2 = makeRawQuery("not valid sql !!!");

  const results = await cache.sync([invalidQuery1, invalidQuery2]);

  expect(results).toHaveLength(0);
});

test("sync bounds concurrency to MAX_CONCURRENCY", async () => {
  const cache = new QueryCache();

  let peakConcurrent = 0;
  let currentConcurrent = 0;

  const originalAnalyze = (await import("../sql/recent-query.ts")).RecentQuery.analyze;
  const { RecentQuery } = await import("../sql/recent-query.ts");
  vi.spyOn(RecentQuery, "analyze").mockImplementation(async (...args) => {
    currentConcurrent++;
    peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
    // Yield to allow other tasks to start if concurrency is unbounded
    await new Promise((r) => setTimeout(r, 10));
    currentConcurrent--;
    return originalAnalyze.call(RecentQuery, ...args);
  });

  // 30 queries — with unbounded concurrency all 30 would run simultaneously,
  // with Sema(10) peak should be capped at 10
  const queries = Array.from({ length: 30 }, (_, i) =>
    makeRawQuery(`SELECT ${i + 1}`),
  );

  await cache.sync(queries);

  expect(peakConcurrent).toBeLessThanOrEqual(10);
  expect(peakConcurrent).toBeGreaterThan(1); // verify some concurrency exists

  vi.restoreAllMocks();
});
