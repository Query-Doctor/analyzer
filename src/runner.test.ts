import { test, expect, describe } from "vitest";
import type { ExportedStats } from "@query-doctor/core";
import { buildQueries } from "./reporters/site-api.ts";
import { Runner } from "./runner.ts";
import type { OptimizedQuery } from "./sql/recent-query.ts";

function fakeQuery(hash: string, state: string): OptimizedQuery {
  return {
    hash,
    query: "",
    formattedQuery: "",
    nudges: [],
    tags: [],
    tableReferences: [],
    optimization: { state },
  } as unknown as OptimizedQuery;
}

describe("queryStats.analyzed source of truth", () => {
  test("buildQueries().length counts exactly the queries reported to the site", () => {
    const results = [
      fakeQuery("a", "improvements_available"),
      fakeQuery("b", "no_improvement_found"),
      fakeQuery("c", "error"),
      fakeQuery("d", "not_supported"),
      fakeQuery("e", "timeout"),
      fakeQuery("f", "waiting"),
      fakeQuery("g", "optimizing"),
    ];
    expect(buildQueries(results).length).toBe(3);
  });
});

describe("Runner.determineStatsMode precedence", () => {
  const TABLE: ExportedStats = {
    tableName: "users",
    schemaName: "public",
    relpages: 10,
    reltuples: 166_000,
    relallvisible: 8,
    columns: [],
    indexes: [],
  };

  const exportMode = {
    type: "static",
    stats: {
      kind: "fromStatisticsExport",
      source: { kind: "inline" },
      stats: [TABLE],
    },
  };

  const syntheticMode = {
    type: "static",
    stats: { kind: "fromAssumption", reltuples: 10_000_000 },
  };

  test("costs against the production stats export when production stats are provided", async () => {
    expect(await Runner.determineStatsMode(undefined, [TABLE])).toEqual(
      exportMode,
    );
  });

  test("production stats take precedence over a stats file path", async () => {
    // The path is never read because production stats win — proven by the
    // absence of a filesystem error for this non-existent path.
    expect(
      await Runner.determineStatsMode("/nonexistent/stats.json", [TABLE]),
    ).toEqual(exportMode);
  });

  test("falls back to synthetic assumption when production stats are empty", async () => {
    expect(await Runner.determineStatsMode(undefined, [])).toEqual(
      syntheticMode,
    );
  });

  test("falls back to synthetic assumption when no stats source is provided", async () => {
    expect(await Runner.determineStatsMode()).toEqual(syntheticMode);
  });
});

describe("Runner.determineStatsMode at a configured scale", () => {
  const TABLE: ExportedStats = {
    tableName: "users",
    schemaName: "public",
    relpages: 10,
    reltuples: 166_000,
    relallvisible: 8,
    columns: [],
    indexes: [],
  };

  /** CI always resolves a static mode; this narrows the union to read it. */
  async function staticMode(
    productionStats?: ExportedStats[],
    scale?: number,
  ) {
    const strategy = await Runner.determineStatsMode(
      undefined,
      productionStats,
      scale,
    );
    if (strategy.type !== "static") {
      throw new Error(`expected a static stats mode, got ${strategy.type}`);
    }
    return strategy.stats;
  }

  test("models production stats at the repo's scale", async () => {
    const stats = await staticMode([TABLE], 10);

    expect(stats.kind).toBe("fromStatisticsExport");
    expect(stats.scale).toBe(10);
  });

  test("models the synthetic assumption at the repo's scale", async () => {
    const stats = await staticMode(undefined, 1000);

    expect(stats.kind).toBe("fromAssumption");
    expect(stats.scale).toBe(1000);
  });

  test("leaves the mode unscaled when the repo is configured at 1x", async () => {
    expect((await staticMode([TABLE], 1)).scale).toBeUndefined();
  });

  test("leaves the mode unscaled when no scale is configured", async () => {
    expect((await staticMode([TABLE])).scale).toBeUndefined();
  });
});
