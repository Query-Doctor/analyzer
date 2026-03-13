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

test("sync marks queries over 50KB as analysisSkipped", async () => {
  const cache = new QueryCache();

  const smallQuery = makeRawQuery("SELECT 1");
  // 60KB of valid SQL — simulates PostGIS extension bootstrap
  const largeQuery = makeRawQuery(
    `INSERT INTO spatial_ref_sys VALUES ${Array.from({ length: 1000 }, (_, i) => `(${i}, 'EPSG', ${i}, '${"x".repeat(50)}', '${"y".repeat(50)}')`).join(", ")}`,
  );

  expect(largeQuery.query.length).toBeGreaterThan(50_000);

  const results = await cache.sync([smallQuery, largeQuery]);

  expect(results).toHaveLength(2);

  const small = results.find((r) => r.query.includes("SELECT"));
  const large = results.find((r) => r.query.includes("spatial_ref_sys"));

  expect(small).toBeDefined();
  expect(small!.analysisSkipped).toBe(false);

  expect(large).toBeDefined();
  expect(large!.analysisSkipped).toBe(true);
  expect(large!.tableReferences).toEqual([]);
  expect(large!.nudges).toEqual([]);
});
