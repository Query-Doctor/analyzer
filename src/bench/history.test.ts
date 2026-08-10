import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommitRecord,
  HARNESS_VERSION,
  currentEnv,
  dependencyKey,
  readRecords,
  recordPath,
  toShapeRecord,
  writeRecord,
} from "./history.ts";
import type { ShapeMeasurement } from "./measure.ts";
import type { ShapePayload } from "./report.ts";

const root = () => mkdtempSync(join(tmpdir(), "bench-history-"));

const record = (
  commit: string,
  committedAt: string,
  extra: Partial<CommitRecord> = {},
): CommitRecord => ({
  commit,
  committedAt,
  subject: "some change",
  harnessVersion: HARNESS_VERSION,
  measuredAt: "2026-08-10T12:00:00.000Z",
  env: currentEnv("postgres:17"),
  shapes: [],
  ...extra,
});

describe("history records", () => {
  it("files a record under the month the commit landed", () => {
    const dir = root();
    const path = recordPath(dir, record("abc123def456789", "2026-07-04T10:00:00Z"));
    expect(path).toContain(join("data", "2026-07"));
    expect(path).toContain("abc123def456.json");
  });

  it("round-trips a record", () => {
    const dir = root();
    const written = record("abc123def456789", "2026-07-04T10:00:00Z");
    writeRecord(dir, written);
    expect(readRecords(dir)).toStrictEqual([written]);
  });

  it("orders by when the commit landed, not when it was measured", () => {
    // A backfill measures an old commit today. It belongs at its own place in
    // the series, not at the end.
    const dir = root();
    writeRecord(
      dir,
      record("newer0000000", "2026-08-01T00:00:00Z", {
        measuredAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    writeRecord(
      dir,
      record("older0000000", "2026-07-01T00:00:00Z", {
        measuredAt: "2026-08-10T00:00:00.000Z",
      }),
    );
    expect(readRecords(dir).map((r) => r.commit)).toStrictEqual([
      "older0000000",
      "newer0000000",
    ]);
  });

  it("skips a half-written record rather than failing the read", () => {
    const dir = root();
    writeRecord(dir, record("good00000000", "2026-07-04T10:00:00Z"));
    mkdirSync(join(dir, "data", "2026-07"), { recursive: true });
    writeFileSync(join(dir, "data", "2026-07", "truncated.json"), "{ \"comm");
    expect(readRecords(dir)).toHaveLength(1);
  });

  it("returns nothing for a history that does not exist yet", () => {
    expect(readRecords(join(tmpdir(), "definitely-not-here"))).toStrictEqual([]);
  });

  it("marks a record whose dependencies were resolved rather than locked", () => {
    const env = currentEnv("postgres:17", true);
    expect(env.dependenciesResolved).toBe(true);
    expect(currentEnv("postgres:17").dependenciesResolved).toBeUndefined();
  });
});

describe("toShapeRecord", () => {
  it("keeps the distribution and drops the per-query series", () => {
    // The series is large and only useful while comparing two runs. What a
    // history needs is the shape of the distribution.
    const perQueryMs = Array.from({ length: 100 }, (_, i) => 10 + i);
    const measurement: ShapeMeasurement<ShapePayload> = {
      shape: "breadth",
      outcome: "ok",
      wallMs: 9500,
      cpuMs: 1800,
      maxRssMb: 1024,
      exitCode: 0,
      signal: null,
      payload: {
        perQueryMs,
        workloadVersion: 2,
        phases: { vacuum: { totalMs: 3090, calls: 16 } },
        counts: { maxCandidatesPerTable: 2 },
      },
    };
    const rec = toShapeRecord(measurement);

    expect(rec.queries).toBe(100);
    expect(rec.timings?.p50).toBe(60);
    expect(rec.phases?.vacuum.totalMs).toBe(3090);
    expect(rec.workloadVersion).toBe(2);
    expect(JSON.stringify(rec)).not.toContain("perQueryMs");
  });

  it("records a shape that died, with no distribution to report", () => {
    const rec = toShapeRecord({
      shape: "depth-11",
      outcome: "killed",
      wallMs: 41000,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(rec.outcome).toBe("killed");
    expect(rec.timings).toBeUndefined();
  });
});

describe("dependencyKey", () => {
  const manifest = (core: string) =>
    JSON.stringify({ dependencies: { "@query-doctor/core": core } });

  it("is stable for the same lockfile and manifest", () => {
    expect(dependencyKey("lock", manifest("^0.15.0"))).toBe(
      dependencyKey("lock", manifest("^0.15.0")),
    );
    expect(dependencyKey("lock", manifest("^0.15.0"))).toHaveLength(16);
  });

  it("differs when the lockfile differs", () => {
    expect(dependencyKey("lock", manifest("^0.15.0"))).not.toBe(
      dependencyKey("other", manifest("^0.15.0")),
    );
  });

  it("differs when only the manifest moved", () => {
    // The case that measured a commit against the wrong tree: package.json
    // asked for ^0.16.0, the lockfile still pinned 0.15.0, and on the lockfile
    // alone the cache handed back the previous commit's node_modules.
    expect(dependencyKey("same-lock", manifest("^0.15.0"))).not.toBe(
      dependencyKey("same-lock", manifest("^0.16.0")),
    );
  });

  it("ignores manifest fields that do not affect the tree", () => {
    const a = JSON.stringify({ version: "1.0.0", dependencies: { x: "^1" } });
    const b = JSON.stringify({ version: "2.0.0", dependencies: { x: "^1" } });
    expect(dependencyKey("lock", a)).toBe(dependencyKey("lock", b));
  });
});
