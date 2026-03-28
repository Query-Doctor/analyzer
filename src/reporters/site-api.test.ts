import { test, expect, describe } from "vitest";
import {
  buildQueries,
  compareRuns,
  type CiQueryPayload,
  type PreviousRun,
} from "./site-api.ts";
import type { QueryProcessResult } from "../runner.ts";

function makeQuery(hash: string, cost: number = 100): CiQueryPayload {
  return {
    hash,
    query: `SELECT * FROM t WHERE id = $1`,
    formattedQuery: `SELECT *\nFROM t\nWHERE id = $1`,
    optimization: {
      state: "no_improvement_found",
      cost,
      indexesUsed: [],
    },
    nudges: [],
    tags: [],
    tableReferences: [],
  };
}

function makePreviousRun(queries: CiQueryPayload[]): PreviousRun {
  return {
    id: "prev-run-1",
    repo: "test/repo",
    branch: "main",
    commitSha: "abc123",
    queries,
  };
}

describe("buildQueries", () => {
  test("filters out invalid results", () => {
    const results: QueryProcessResult[] = [
      {
        kind: "no_improvement",
        fingerprint: "hash-a",
        rawQuery: "SELECT 1",
        formattedQuery: "SELECT 1",
        cost: 10,
        existingIndexes: [],
        nudges: [],
        tags: [],
        referencedTables: [],
      },
      { kind: "invalid" },
      {
        kind: "no_improvement",
        fingerprint: "hash-b",
        rawQuery: "SELECT 2",
        formattedQuery: "SELECT 2",
        cost: 20,
        existingIndexes: [],
        nudges: [],
        tags: [],
        referencedTables: [],
      },
    ];

    const queries = buildQueries(results);
    expect(queries).toHaveLength(2);
    expect(queries.map((q) => q.hash)).toEqual(["hash-a", "hash-b"]);
  });

  test("filters out ignored query hashes", () => {
    const results: QueryProcessResult[] = [
      {
        kind: "no_improvement",
        fingerprint: "hash-a",
        rawQuery: "SELECT 1",
        formattedQuery: "SELECT 1",
        cost: 10,
        existingIndexes: [],
        nudges: [],
        tags: [],
        referencedTables: [],
      },
      {
        kind: "no_improvement",
        fingerprint: "hash-b",
        rawQuery: "SELECT 2",
        formattedQuery: "SELECT 2",
        cost: 20,
        existingIndexes: [],
        nudges: [],
        tags: [],
        referencedTables: [],
      },
    ];

    const queries = buildQueries(results, {
      ignoredQueryHashes: ["hash-a"],
      acknowledgedQueryHashes: [],
      regressionThreshold: 10,
      minimumCost: 0,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].hash).toBe("hash-b");
  });

  test("count reflects deduplicated output, not raw input length", () => {
    const results: QueryProcessResult[] = [
      {
        kind: "no_improvement",
        fingerprint: "hash-a",
        rawQuery: "SELECT 1",
        formattedQuery: "SELECT 1",
        cost: 10,
        existingIndexes: [],
        nudges: [],
        tags: [],
        referencedTables: [],
      },
      { kind: "invalid" },
      { kind: "invalid" },
      { kind: "invalid" },
    ];

    const queries = buildQueries(results);
    // 4 results in, but only 1 valid query out
    expect(queries).toHaveLength(1);
  });
});

describe("compareRuns", () => {
  describe("new query detection via previousRun", () => {
    test("when previousRun has no queries, all current queries are new", () => {
      const queries = [makeQuery("hash-a"), makeQuery("hash-b")];
      const previousRun = makePreviousRun([]);

      const result = compareRuns(queries, previousRun, 10);

      expect(result.newQueries).toHaveLength(2);
      expect(result.newQueries.map((q) => q.hash)).toEqual([
        "hash-a",
        "hash-b",
      ]);
      expect(result.regressed).toHaveLength(0);
      expect(result.improved).toHaveLength(0);
    });

    test("when previousRun contains hashes, only non-seen queries are new", () => {
      const queries = [
        makeQuery("hash-a"),
        makeQuery("hash-b"),
        makeQuery("hash-c"),
      ];
      const previousRun = makePreviousRun([
        makeQuery("hash-a"),
        makeQuery("hash-c"),
      ]);

      const result = compareRuns(queries, previousRun, 10);

      expect(result.newQueries).toHaveLength(1);
      expect(result.newQueries[0].hash).toBe("hash-b");
    });

    test("query in previousRun with increased cost is flagged as regression", () => {
      const currentQueries = [makeQuery("hash-a", 500)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = compareRuns(currentQueries, previousRun, 10);

      expect(result.newQueries).toHaveLength(0);
      expect(result.regressed).toHaveLength(1);
      expect(result.regressed[0].hash).toBe("hash-a");
      expect(result.regressed[0].previousCost).toBe(100);
      expect(result.regressed[0].currentCost).toBe(500);
      expect(result.regressed[0].regressionPercentage).toBe(400);
    });
  });

  describe("regression threshold", () => {
    test("cost change within threshold is not flagged", () => {
      const currentQueries = [makeQuery("hash-a", 115)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = compareRuns(currentQueries, previousRun, 20);

      expect(result.regressed).toHaveLength(0);
      expect(result.improved).toHaveLength(0);
      expect(result.newQueries).toHaveLength(0);
    });

    test("cost decrease beyond threshold is flagged as improved", () => {
      const currentQueries = [makeQuery("hash-a", 30)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = compareRuns(currentQueries, previousRun, 10);

      expect(result.improved).toHaveLength(1);
      expect(result.improved[0].hash).toBe("hash-a");
      expect(result.improved[0].previousCost).toBe(100);
      expect(result.improved[0].currentCost).toBe(30);
    });

    test("acknowledged regression goes to acknowledgedRegressed, not regressed", () => {
      const currentQueries = [makeQuery("hash-a", 500)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = compareRuns(
        currentQueries,
        previousRun,
        10,
        0,
        ["hash-a"],
      );

      expect(result.regressed).toHaveLength(0);
      expect(result.acknowledgedRegressed).toHaveLength(1);
      expect(result.acknowledgedRegressed[0].hash).toBe("hash-a");
    });
  });

  describe("minimumCost filtering", () => {
    test("regression where both costs are below minimumCost is skipped", () => {
      const currentQueries = [makeQuery("hash-a", 8)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 2)]);

      const result = compareRuns(currentQueries, previousRun, 10, 50);

      expect(result.regressed).toHaveLength(0);
    });

    test("regression where current cost exceeds minimumCost is reported", () => {
      const currentQueries = [makeQuery("hash-a", 200)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 10)]);

      const result = compareRuns(currentQueries, previousRun, 10, 50);

      expect(result.regressed).toHaveLength(1);
    });
  });

  describe("disappeared queries", () => {
    test("queries in previousRun but not in current are disappeared", () => {
      const currentQueries = [makeQuery("hash-a")];
      const previousRun = makePreviousRun([
        makeQuery("hash-a"),
        makeQuery("hash-b"),
        makeQuery("hash-c"),
      ]);

      const result = compareRuns(currentQueries, previousRun, 10);

      expect(result.disappearedHashes).toEqual(["hash-b", "hash-c"]);
    });
  });

  describe("mixed scenarios", () => {
    test("new, regressed, improved, and disappeared queries together", () => {
      const currentQueries = [
        makeQuery("hash-a", 500), // regressed (was 100)
        makeQuery("hash-b", 30),  // improved (was 100)
        makeQuery("hash-c", 100), // unchanged
        makeQuery("hash-d", 200), // new
      ];
      const previousRun = makePreviousRun([
        makeQuery("hash-a", 100),
        makeQuery("hash-b", 100),
        makeQuery("hash-c", 100),
        makeQuery("hash-e", 100), // disappeared
      ]);

      const result = compareRuns(currentQueries, previousRun, 10);

      expect(result.newQueries).toHaveLength(1);
      expect(result.newQueries[0].hash).toBe("hash-d");
      expect(result.regressed).toHaveLength(1);
      expect(result.regressed[0].hash).toBe("hash-a");
      expect(result.improved).toHaveLength(1);
      expect(result.improved[0].hash).toBe("hash-b");
      expect(result.disappearedHashes).toEqual(["hash-e"]);
    });
  });
});
