import { describe, expect, it } from "vitest";
import {
  compareRuns,
  percentiles,
  renderReport,
  type ShapePayload,
} from "./report.ts";
import type { ShapeMeasurement } from "./measure.ts";

function shape(
  name: string,
  perQueryMs: number[],
  extra: Partial<ShapeMeasurement<ShapePayload>> = {},
): ShapeMeasurement<ShapePayload> {
  return {
    shape: name,
    outcome: "ok",
    wallMs: perQueryMs.reduce((a, b) => a + b, 0),
    cpuMs: 100,
    maxRssMb: 200,
    exitCode: 0,
    signal: null,
    payload: { perQueryMs },
    ...extra,
  };
}

describe("compareRuns", () => {
  it("pairs per-query timings and reports the median difference", () => {
    const control = [shape("breadth", [10, 11, 12, 13, 14, 15, 16, 17])];
    const experiment = [shape("breadth", [11, 13, 15, 17, 19, 21, 23, 25])];
    const [verdict] = compareRuns(control, experiment);

    expect(verdict.kind).toBe("compared");
    expect(verdict.timing?.n).toBe(8);
    expect(verdict.timing?.medianDifference).toBe(4.5);
    expect(verdict.timing?.p).toBeCloseTo(0.0078125, 10);
  });

  it("refuses to pair runs that covered different numbers of queries", () => {
    // Truncating to the shorter side would produce a confident number about a
    // comparison that was never valid.
    const [verdict] = compareRuns(
      [shape("breadth", [10, 11, 12, 13])],
      [shape("breadth", [10, 11, 12])],
    );
    expect(verdict.kind).toBe("compared");
    expect(verdict.timing).toBeUndefined();
  });

  it("makes a shape that ran out of memory the outcome, not a delta", () => {
    const control = [shape("depth-11", [100, 101, 102])];
    const experiment = [
      shape("depth-11", [], {
        outcome: "killed",
        signal: "SIGKILL",
        exitCode: null,
        payload: undefined,
        cpuMs: undefined,
        maxRssMb: undefined,
      }),
    ];
    const [verdict] = compareRuns(control, experiment);

    expect(verdict.kind).toBe("did-not-finish");
    expect(verdict.incident).toBe("experiment killed");
    expect(verdict.timing).toBeUndefined();
  });

  it("names a shape that only one side ran", () => {
    const verdicts = compareRuns(
      [shape("old", [1, 2, 3])],
      [shape("new", [1, 2, 3])],
    );
    expect(verdicts.find((v) => v.shape === "old")?.kind).toBe("control-only");
    expect(verdicts.find((v) => v.shape === "new")?.kind).toBe(
      "experiment-only",
    );
  });

  it("pairs exact counts alongside the timings", () => {
    const control = [
      shape("depth-7", [10, 11], {
        payload: { perQueryMs: [10, 11], counts: { permutations: 13699 } },
      }),
    ];
    const experiment = [
      shape("depth-7", [10, 11], {
        payload: { perQueryMs: [10, 11], counts: { permutations: 500 } },
      }),
    ];
    const [verdict] = compareRuns(control, experiment);
    expect(verdict.counts?.permutations).toStrictEqual({
      control: 13699,
      experiment: 500,
    });
  });
});

describe("renderReport", () => {
  it("leads with a shape that did not finish", () => {
    const control = [shape("depth-11", [100, 101, 102, 103, 104, 105])];
    const experiment = [
      shape("depth-11", [], {
        outcome: "killed",
        signal: "SIGKILL",
        payload: undefined,
        cpuMs: undefined,
        maxRssMb: 3891,
      }),
    ];
    const report = renderReport(compareRuns(control, experiment));

    expect(report).toContain("Did not finish");
    expect(report).toContain("`depth-11` — experiment killed");
    expect(report).toContain("3891 MiB");
    // It must not appear as a row of percentages next to the shapes that ran.
    expect(report).not.toMatch(/\| `depth-11` \| [+-]/);
  });

  it("says when there were too few pairs to resolve anything", () => {
    const control = [shape("tiny", [10, 11, 12])];
    const experiment = [shape("tiny", [13, 15, 17])];
    const report = renderReport(compareRuns(control, experiment));
    expect(report).toContain("3 pairs — too few to resolve");
    expect(report).not.toContain("p=");
  });

  it("reports a p-value once there are enough pairs", () => {
    const control = [shape("breadth", [10, 11, 12, 13, 14, 15, 16, 17])];
    const experiment = [shape("breadth", [11, 13, 15, 17, 19, 21, 23, 25])];
    const report = renderReport(compareRuns(control, experiment));
    expect(report).toContain("p=0.0078");
    expect(report).toContain("+4.50 ms");
  });

  it("says plainly when nothing moved", () => {
    const timings = [10, 11, 12, 13, 14, 15, 16, 17];
    const report = renderReport(
      compareRuns([shape("breadth", timings)], [shape("breadth", timings)]),
    );
    expect(report).toContain("no query moved");
  });

  it("shows only the counts that changed", () => {
    const control = [
      shape("depth-7", [10, 11], {
        payload: {
          perQueryMs: [10, 11],
          counts: { permutations: 13699, explains: 2 },
        },
      }),
    ];
    const experiment = [
      shape("depth-7", [10, 11], {
        payload: {
          perQueryMs: [10, 11],
          counts: { permutations: 500, explains: 2 },
        },
      }),
    ];
    const report = renderReport(compareRuns(control, experiment));
    expect(report).toContain("Counts that changed");
    expect(report).toContain("13,699");
    expect(report).toContain("500");
    // `explains` did not move, so it is noise in the report.
    expect(report).not.toContain("explains");
  });

  it("reports memory and processor deltas with the numbers behind them", () => {
    const control = [
      shape("breadth", [10, 11, 12, 13, 14, 15, 16, 17], {
        cpuMs: 1000,
        maxRssMb: 400,
      }),
    ];
    const experiment = [
      shape("breadth", [10, 11, 12, 13, 14, 15, 16, 17], {
        cpuMs: 1200,
        maxRssMb: 600,
      }),
    ];
    const report = renderReport(compareRuns(control, experiment));
    expect(report).toContain("+20.0% (1200 ms)");
    expect(report).toContain("+50.0% (600 MiB)");
  });

  it("says so when nothing ran at all", () => {
    expect(renderReport([])).toBe("No shapes ran.");
  });
});

describe("percentiles", () => {
  it("separates the fast band from the tail", () => {
    // 90 fast queries and 10 slow ones: the median says nothing happened, the
    // tail says a tenth of the run is ten times slower.
    const values = [
      ...Array.from({ length: 90 }, () => 7),
      ...Array.from({ length: 10 }, () => 70),
    ];
    const p = percentiles(values)!;
    expect(p.p50).toBe(7);
    expect(p.p90).toBe(70);
    expect(p.max).toBe(70);
    expect(p.totalMs).toBe(90 * 7 + 10 * 70);
  });

  it("returns nothing for an empty run", () => {
    expect(percentiles([])).toBeUndefined();
  });

  it("puts both sides of a comparison in the report", () => {
    const fast = Array.from({ length: 20 }, (_, i) => 7 + i * 0.1);
    const slow = Array.from({ length: 20 }, (_, i) => 9 + i * 0.1);
    const report = renderReport(
      compareRuns([shape("breadth", fast)], [shape("breadth", slow)]),
    );
    expect(report).toContain("Per-query distribution");
    expect(report).toContain("| control |");
    expect(report).toContain("| experiment |");
  });
});

describe("phases and workload versions", () => {
  const withPhases = (
    name: string,
    ms: number[],
    phases: Record<string, { totalMs: number; calls: number }>,
    version = 2,
  ) =>
    shape(name, ms, {
      payload: { perQueryMs: ms, phases, workloadVersion: version },
    });

  it("reports work outside the query loop", () => {
    const ms = [10, 11, 12, 13, 14, 15, 16, 17];
    const report = renderReport(
      compareRuns(
        [withPhases("breadth", ms, { setStatistics: { totalMs: 400, calls: 1 } })],
        [withPhases("breadth", ms, { setStatistics: { totalMs: 600, calls: 1 } })],
      ),
    );
    expect(report).toContain("Outside the query loop");
    expect(report).toContain("setStatistics");
    expect(report).toContain("+50.0%");
  });

  it("refuses to compare across a workload change", () => {
    // Seeding the tables altered the work itself, so a delta would measure the
    // generator rather than the analyzer.
    const ms = [10, 11, 12, 13, 14, 15, 16, 17];
    const [verdict] = compareRuns(
      [withPhases("breadth", ms, {}, 1)],
      [withPhases("breadth", ms, {}, 2)],
    );
    expect(verdict.kind).toBe("did-not-finish");
    expect(verdict.incident).toContain("workload version differs");
    expect(verdict.timing).toBeUndefined();
  });
});
