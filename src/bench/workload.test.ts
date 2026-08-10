import { describe, expect, it } from "vitest";
import { generateDepthQueries } from "./workload.ts";

describe("generateDepthQueries", () => {
  it("filters on as many columns as asked", () => {
    // Candidates per table is the number the optimizer's cost is a factorial
    // of, so this is the lever that decides whether a shape reaches the
    // expensive path at all.
    for (const width of [2, 4, 6]) {
      const [query] = generateDepthQueries(1, 1, width);
      expect(query.match(/\$\d+/g)).toHaveLength(width);
    }
  });

  it("never repeats a column within one query", () => {
    const [query] = generateDepthQueries(1, 1, 6);
    const columns = [...query.matchAll(/(\w+) [=>]/g)].map((m) => m[1]);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("stops at the columns the schema actually has", () => {
    const [query] = generateDepthQueries(1, 1, 99);
    expect(query.match(/\$\d+/g)!.length).toBeLessThanOrEqual(6);
  });

  it("spreads queries across the tables it was given", () => {
    const queries = generateDepthQueries(3, 6, 2);
    expect(new Set(queries.map((q) => q.match(/FROM (\w+)/)![1])).size).toBe(3);
  });
});
