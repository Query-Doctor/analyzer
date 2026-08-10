import { describe, expect, it } from "vitest";
import { alignTimings, instrument, permutationCount } from "./instrument.ts";

/**
 * A stand-in with the same two method names as the optimizer. The point of
 * these tests is that the patching survives out-of-order completion and missing
 * methods, neither of which needs a real optimizer or a database to exercise.
 */
class FakeOptimizer {
  public calls: string[] = [];

  private getPotentialIndexCandidates(
    _statistics: unknown,
    recent: { hash: string; candidates?: { schema: string; table: string }[] },
  ) {
    return recent.candidates ?? [];
  }

  private async optimizeQuery(
    recent: {
      hash: string;
      delayMs?: number;
      candidates?: { schema: string; table: string }[];
    },
    _target: unknown,
    _options: unknown,
  ) {
    // Mirrors the real call: candidates are derived inside the timed method.
    (this as unknown as Record<string, Function>).getPotentialIndexCandidates(
      null,
      recent,
    );
    await new Promise((resolve) => setTimeout(resolve, recent.delayMs ?? 0));
    this.calls.push(recent.hash);
    return { hash: recent.hash };
  }

  run(
    queries: {
      hash: string;
      delayMs?: number;
      candidates?: { schema: string; table: string }[];
    }[],
  ) {
    return Promise.all(
      queries.map((query) =>
        (this as unknown as Record<string, Function>).optimizeQuery(
          query,
          null,
          null,
        ),
      ),
    );
  }
}

const col = (table: string) => ({ schema: "public", table });

describe("instrument", () => {
  it("keys timings by query, not by the order they finished", async () => {
    const optimizer = new FakeOptimizer();
    const recording = instrument(FakeOptimizer);
    try {
      // `slow` starts first and finishes last, exactly as the semaphore lets
      // happen in the real optimizer.
      await optimizer.run([
        { hash: "slow", delayMs: 60 },
        { hash: "fast", delayMs: 1 },
      ]);
    } finally {
      recording.restore();
    }

    expect(optimizer.calls).toStrictEqual(["fast", "slow"]);
    expect(recording.timings.get("slow")!).toBeGreaterThan(
      recording.timings.get("fast")!,
    );
  });

  it("counts candidates per query and the worst table", async () => {
    const optimizer = new FakeOptimizer();
    const recording = instrument(FakeOptimizer);
    try {
      await optimizer.run([
        { hash: "a", candidates: [col("users"), col("users"), col("posts")] },
        {
          hash: "b",
          candidates: [
            col("orders"),
            col("orders"),
            col("orders"),
            col("orders"),
          ],
        },
      ]);
    } finally {
      recording.restore();
    }

    expect(recording.candidates.get("a")).toBe(3);
    expect(recording.candidates.get("b")).toBe(4);
    // Two on users, one on posts, four on orders.
    expect(recording.maxCandidatesPerTable).toBe(4);
  });

  it("puts the prototype back exactly as it was", async () => {
    const before = Object.getOwnPropertyNames(FakeOptimizer.prototype).map(
      (name) => [
        name,
        (FakeOptimizer.prototype as unknown as Record<string, unknown>)[name],
      ],
    );
    const recording = instrument(FakeOptimizer);
    await new FakeOptimizer().run([{ hash: "a" }]);
    recording.restore();

    for (const [name, original] of before) {
      expect(
        (FakeOptimizer.prototype as unknown as Record<string, unknown>)[
        name as string
      ],
      ).toBe(original);
    }
  });

  it("names methods it could not find rather than reporting zero", () => {
    class Older {
      // Neither method exists under the expected names.
      async optimise() {}
    }
    const recording = instrument(Older);
    expect(recording.missing).toStrictEqual([
      "optimizeQuery",
      "getPotentialIndexCandidates",
    ]);
    recording.restore();
  });

  it("still times queries when only the candidate method is missing", async () => {
    class Partial {
      private async optimizeQuery(recent: { hash: string }) {
        return recent.hash;
      }
      run(hash: string) {
        return (this as unknown as Record<string, Function>).optimizeQuery({
          hash,
        });
      }
    }
    const recording = instrument(Partial);
    await new Partial().run("only-timed");
    recording.restore();

    expect(recording.missing).toStrictEqual(["getPotentialIndexCandidates"]);
    expect(recording.timings.has("only-timed")).toBe(true);
  });
});

describe("alignTimings", () => {
  it("keeps only queries both sides measured, in a stable order", () => {
    const control = new Map([
      ["b", 2],
      ["a", 1],
      ["gone", 9],
    ]);
    const experiment = new Map([
      ["a", 10],
      ["b", 20],
      ["new", 30],
    ]);
    const aligned = alignTimings(control, experiment);

    expect(aligned.hashes).toStrictEqual(["a", "b"]);
    expect(aligned.control).toStrictEqual([1, 2]);
    expect(aligned.experiment).toStrictEqual([10, 20]);
  });

  it("returns nothing when the two runs share no query", () => {
    const aligned = alignTimings(new Map([["a", 1]]), new Map([["b", 2]]));
    expect(aligned.hashes).toStrictEqual([]);
  });
});

describe("permutationCount", () => {
  it("matches the counts the optimizer would build", () => {
    // Ordered subsets: sum over k of n!/(n-k)!
    expect(permutationCount(1)).toBe(1);
    expect(permutationCount(3)).toBe(15);
    expect(permutationCount(6)).toBe(1956);
    expect(permutationCount(7)).toBe(13699);
    expect(permutationCount(11)).toBe(108505111);
  });
});

describe("the real optimizer", () => {
  it("still has the methods the recording depends on", async () => {
    // The whole approach rests on these two names being on the prototype. When
    // one is renamed, every backfilled commit after the rename silently
    // measures nothing, so this is the test that says so out loud.
    const { QueryOptimizer } = await import("../remote/query-optimizer.ts");
    const prototype = QueryOptimizer.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(typeof prototype.optimizeQuery).toBe("function");
    expect(typeof prototype.getPotentialIndexCandidates).toBe("function");
  });

  it("reports no missing methods against the real class", async () => {
    const { QueryOptimizer } = await import("../remote/query-optimizer.ts");
    const recording = instrument(QueryOptimizer);
    recording.restore();
    expect(recording.missing).toStrictEqual([]);
  });
});
