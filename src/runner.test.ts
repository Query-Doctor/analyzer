import { test, expect, describe } from "vitest";
import { countUploadableQueries, UPLOADABLE_STATES } from "./runner.ts";
import { buildQueries } from "./reporters/site-api.ts";
import type { OptimizedQuery } from "./sql/recent-query.ts";

function fakeQuery(state: string): OptimizedQuery {
  return {
    optimization: { state },
  } as OptimizedQuery;
}

describe("countUploadableQueries", () => {
  test("counts improvements_available, no_improvement_found, and error", () => {
    const results = [
      fakeQuery("improvements_available"),
      fakeQuery("no_improvement_found"),
      fakeQuery("error"),
    ];
    expect(countUploadableQueries(results)).toBe(3);
  });

  test("excludes not_supported, timeout, waiting, optimizing", () => {
    const results = [
      fakeQuery("not_supported"),
      fakeQuery("timeout"),
      fakeQuery("waiting"),
      fakeQuery("optimizing"),
    ];
    expect(countUploadableQueries(results)).toBe(0);
  });

  test("counts only uploadable in a mixed set", () => {
    const results = [
      fakeQuery("improvements_available"),
      fakeQuery("not_supported"),
      fakeQuery("no_improvement_found"),
      fakeQuery("timeout"),
      fakeQuery("error"),
      fakeQuery("waiting"),
    ];
    expect(countUploadableQueries(results)).toBe(3);
  });
});

describe("UPLOADABLE_STATES matches buildQueries filter", () => {
  test("buildQueries keeps exactly the same states as UPLOADABLE_STATES", () => {
    const allStates = [
      "improvements_available",
      "no_improvement_found",
      "error",
      "not_supported",
      "timeout",
      "waiting",
      "optimizing",
    ];

    for (const state of allStates) {
      const results = [fakeQuery(state)];
      const uploaded = buildQueries(results).length;
      const counted = countUploadableQueries(results);
      expect(counted, `state "${state}"`).toBe(uploaded);
    }
  });
});
