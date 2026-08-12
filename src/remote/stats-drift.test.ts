import { describe, expect, it } from "vitest";
import type { ExportedStats } from "@query-doctor/core";
import {
  baselineFromDump,
  detectDrift,
  isPastRefreshFloor,
  SIZE_DRIFT_MIN_ROWS,
} from "./stats-drift.ts";

function table(name: string, reltuples: number): ExportedStats {
  return {
    schemaName: "public",
    tableName: name,
    reltuples,
    relpages: Math.max(1, Math.round(reltuples / 100)),
    relallvisible: 0,
    columns: [],
    indexes: [],
  } as unknown as ExportedStats;
}

function reltuples(entries: Record<string, number>): Map<string, number> {
  return new Map(
    Object.entries(entries).map(([name, rows]) => [`public.${name}`, rows]),
  );
}

const BIG = SIZE_DRIFT_MIN_ROWS * 10;

describe("detectDrift — Shape Drift", () => {
  it("fires when the source has a table the snapshot doesn't cover", () => {
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG, teams: 0 }),
    });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("shape");
    expect(verdict.reason).toContain("public.teams");
  });

  it("fires for a brand-new empty table — the case a migration creates", () => {
    // The table has 0 rows, so Size Drift would never see it. This is the
    // exact miss that left six tables uncovered for six weeks.
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG, oauth_tokens: 0 }),
    });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("shape");
  });

  it("fires when a covered table is dropped", () => {
    const baseline = baselineFromDump([
      table("users", BIG),
      table("legacy", BIG),
    ]);

    const verdict = detectDrift(baseline, { reltuples: reltuples({ users: BIG }) });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("shape");
    expect(verdict.reason).toContain("public.legacy");
  });

  it("takes precedence over a simultaneous size change", () => {
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG * 10, teams: 0 }),
    });

    if (!verdict.drifted) throw new Error("expected drift");
    expect(verdict.kind).toBe("shape");
  });
});

describe("detectDrift — Size Drift", () => {
  it("fires when a table grows past the ratio", () => {
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG * 2 }),
    });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("size");
    expect(verdict.reason).toContain("public.users");
  });

  it("fires when a table shrinks past the ratio", () => {
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG / 4 }),
    });

    expect(verdict.drifted).toBe(true);
  });

  it("ignores a move below the ratio", () => {
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: Math.round(BIG * 1.2) }),
    });

    expect(verdict.drifted).toBe(false);
  });

  it("ignores large ratios on tables that are tiny on both sides", () => {
    // 2 -> 8 rows is +300% and means nothing to the planner. Without the floor
    // this would re-dump on essentially every poll.
    const baseline = baselineFromDump([table("flags", 2)]);

    const verdict = detectDrift(baseline, { reltuples: reltuples({ flags: 8 }) });

    expect(verdict.drifted).toBe(false);
  });

  it("still fires when a small table grows past the floor", () => {
    const baseline = baselineFromDump([table("events", 10)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ events: BIG }),
    });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("size");
  });

  it("does not fire on an unchanged database", () => {
    const baseline = baselineFromDump([
      table("users", BIG),
      table("orders", BIG * 3),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG, orders: BIG * 3 }),
    });

    expect(verdict.drifted).toBe(false);
  });
});

describe("isPastRefreshFloor", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("is false before the analyzer has ever pushed", () => {
    // Nothing to compare against, and dumping on a timer for an analyzer with
    // no baseline would publish statistics the server never asked for.
    expect(isPastRefreshFloor(undefined, NOW)).toBe(false);
  });

  it("is false while the last push is recent", () => {
    expect(isPastRefreshFloor(NOW - DAY / 2, NOW)).toBe(false);
  });

  it("is true once a full day has passed", () => {
    expect(isPastRefreshFloor(NOW - DAY, NOW)).toBe(true);
  });

  it("is true well past the floor", () => {
    expect(isPastRefreshFloor(NOW - DAY * 40, NOW)).toBe(true);
  });

  it("honours a custom floor", () => {
    expect(isPastRefreshFloor(NOW - 5_000, NOW, 1_000)).toBe(true);
    expect(isPastRefreshFloor(NOW - 500, NOW, 1_000)).toBe(false);
  });
});

/**
 * A refresh that never fires reads the same from outside whether the database
 * is quiet or one table is sitting just under the ratio. The first calls for
 * patience and the second for a different threshold, so the verdict carries the
 * near miss.
 */
describe("detectDrift — the closest table that did not drift", () => {
  it("names the table nearest the ratio, and how far it moved", () => {
    const baseline = baselineFromDump([table("users", BIG), table("teams", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG * 0.6, teams: BIG * 0.95 }),
    });

    expect(verdict.drifted).toBe(false);
    // users moved 40%, teams 5%. The threshold is 50%, so neither fires.
    expect(verdict.drifted === false && verdict.closest).toEqual({
      table: "public.users",
      ratio: expect.closeTo(0.4, 5),
    });
  });

  it("reports no closest table when none was eligible", () => {
    // Both sides below the row floor, so Size Drift never considers them.
    const baseline = baselineFromDump([table("tiny", 10)]);

    const verdict = detectDrift(baseline, { reltuples: reltuples({ tiny: 900 }) });

    expect(verdict.drifted === false && verdict.closest).toBeUndefined();
  });
});
