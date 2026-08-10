import { describe, expect, it } from "vitest";
import type { CommitRecord } from "./history.ts";
import { buildSeries, shapeNames, withinMonths } from "./series.ts";

const record = (
  commit: string,
  committedAt: string,
  opts: {
    p50?: number;
    harness?: number;
    workload?: number;
    outcome?: "ok" | "killed";
    resolved?: boolean;
    vacuumMs?: number;
  } = {},
): CommitRecord => ({
  commit,
  committedAt,
  subject: `commit ${commit}`,
  harnessVersion: opts.harness ?? 1,
  measuredAt: "2026-08-10T00:00:00.000Z",
  env: {
    platform: "linux",
    arch: "x64",
    cpuModel: "test",
    cores: 4,
    memoryGb: 16,
    node: "v24",
    pgImage: "postgres:17",
    ...(opts.resolved ? { dependenciesResolved: true } : {}),
  },
  shapes: [
    {
      shape: "breadth",
      outcome: opts.outcome ?? "ok",
      workloadVersion: opts.workload ?? 2,
      wallMs: 10_000,
      cpuMs: 2000,
      maxRssMb: 1000,
      queries: 100,
      timings:
        opts.outcome === "killed"
          ? undefined
          : {
              min: 5,
              p50: opts.p50 ?? 20,
              p90: 30,
              p99: 40,
              max: 50,
              totalMs: 2000,
            },
      phases: opts.vacuumMs
        ? { vacuum: { totalMs: opts.vacuumMs, calls: 16 } }
        : undefined,
    },
  ],
});

describe("buildSeries", () => {
  it("keeps one segment while the instrument is unchanged", () => {
    const segments = buildSeries(
      [
        record("a", "2026-07-01T00:00:00Z", { p50: 20 }),
        record("b", "2026-07-08T00:00:00Z", { p50: 22 }),
        record("c", "2026-07-15T00:00:00Z", { p50: 21 }),
      ],
      "breadth",
      "p50",
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].points.map((p) => p.value)).toStrictEqual([20, 22, 21]);
  });

  it("breaks the line where the workload changed", () => {
    // Seeding the tables tripled per-query time. Joining these would draw a
    // cliff that looks exactly like a regression and was not one.
    const segments = buildSeries(
      [
        record("a", "2026-07-01T00:00:00Z", { p50: 8, workload: 1 }),
        record("b", "2026-07-08T00:00:00Z", { p50: 8, workload: 1 }),
        record("c", "2026-07-15T00:00:00Z", { p50: 23, workload: 2 }),
      ],
      "breadth",
      "p50",
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].workloadVersion).toBe(1);
    expect(segments[1].workloadVersion).toBe(2);
    expect(segments[1].points).toHaveLength(1);
  });

  it("breaks the line where the harness changed", () => {
    const segments = buildSeries(
      [
        record("a", "2026-07-01T00:00:00Z", { harness: 1 }),
        record("b", "2026-07-08T00:00:00Z", { harness: 2 }),
      ],
      "breadth",
      "p50",
    );
    expect(segments).toHaveLength(2);
  });

  it("plots a shape that died, with no value", () => {
    const segments = buildSeries(
      [
        record("a", "2026-07-01T00:00:00Z"),
        record("b", "2026-07-08T00:00:00Z", { outcome: "killed" }),
      ],
      "breadth",
      "p50",
    );
    const points = segments.flatMap((s) => s.points);
    expect(points[1].outcome).toBe("killed");
    expect(points[1].value).toBeNull();
  });

  it("marks a point whose dependencies were resolved rather than locked", () => {
    const [segment] = buildSeries(
      [record("a", "2026-07-01T00:00:00Z", { resolved: true })],
      "breadth",
      "p50",
    );
    expect(segment.points[0].resolved).toBe(true);
  });

  it("reads a phase as a metric", () => {
    const [segment] = buildSeries(
      [record("a", "2026-07-01T00:00:00Z", { vacuumMs: 3140 })],
      "breadth",
      "vacuumMs",
    );
    expect(segment.points[0].value).toBe(3140);
  });

  it("ignores records that never ran the shape", () => {
    const missing = record("a", "2026-07-01T00:00:00Z");
    missing.shapes = [];
    expect(buildSeries([missing], "breadth", "p50")).toStrictEqual([]);
  });
});

describe("withinMonths", () => {
  it("counts back from the newest record, not from today", () => {
    // A history that stopped six months ago should still render, rather than
    // showing an empty last month.
    const records = [
      record("old", "2026-01-01T00:00:00Z"),
      record("mid", "2026-06-15T00:00:00Z"),
      record("new", "2026-07-01T00:00:00Z"),
    ];
    expect(withinMonths(records, 1).map((r) => r.commit)).toStrictEqual([
      "mid",
      "new",
    ]);
    expect(withinMonths(records, 12)).toHaveLength(3);
  });

  it("handles an empty history", () => {
    expect(withinMonths([], 6)).toStrictEqual([]);
  });
});

describe("shapeNames", () => {
  it("lists every shape any record measured", () => {
    const a = record("a", "2026-07-01T00:00:00Z");
    const b = record("b", "2026-07-08T00:00:00Z");
    b.shapes[0].shape = "depth";
    expect(shapeNames([a, b])).toStrictEqual(["breadth", "depth"]);
  });
});
