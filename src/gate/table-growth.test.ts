import { describe, expect, it } from "vitest";
import { tableGrowth } from "./table-growth.ts";

const stats = (rows: [string, number][]) => ({
  reltuples: rows.map(([relname, reltuples]) => ({
    relname, reltuples, schema_name: "public", relpages: 1, relallvisible: 1,
  })),
});

describe("tableGrowth", () => {
  it("names the table that grew most between the baseline and this run", () => {
    const grown = tableGrowth(
      stats([["project_queries", 3503], ["users", 121]]),
      stats([["project_queries", 6290], ["users", 125]]),
    );

    expect(grown[0]).toEqual({
      table: "project_queries",
      before: 3503,
      after: 6290,
      percent: 80,
    });
  });

  it("ignores a table that barely moved", () => {
    const grown = tableGrowth(
      stats([["users", 121]]),
      stats([["users", 125]]),
    );

    expect(grown).toEqual([]);
  });

  it("returns nothing when either side has no statistics", () => {
    expect(tableGrowth(undefined, stats([["users", 1]]))).toEqual([]);
  });
});
