import { test, expect, describe } from "vitest";
import { buildQueries } from "./reporters/site-api.ts";
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
