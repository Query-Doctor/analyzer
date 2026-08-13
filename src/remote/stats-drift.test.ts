import { describe, expect, it } from "vitest";
import type { ExportedStats, FullSchema } from "@query-doctor/core";
import { PgIdentifier } from "@query-doctor/core";
import {
  baselineFromDump,
  detectDrift,
  isPastRefreshFloor,
  SIZE_DRIFT_MIN_ROWS,
} from "./stats-drift.ts";

function table(
  name: string,
  reltuples: number,
  covers?: { columns?: string[] },
): ExportedStats {
  return {
    schemaName: "public",
    tableName: name,
    reltuples,
    relpages: Math.max(1, Math.round(reltuples / 100)),
    relallvisible: 0,
    // `DUMP_STATS_SQL` reads these from `pg_attribute`, unquoted.
    columns: (covers?.columns ?? []).map((columnName) => ({ columnName })),
    indexes: [],
  } as unknown as ExportedStats;
}

/**
 * A live schema as the 60s poll delivers it: names go through the same
 * `quote_ident` → `PgIdentifier` path the real dump uses, so a test written
 * with a raw name exercises whatever escaping that path applies.
 */
function schema(
  tables: {
    name: string;
    columns?: (string | { name: string; dropped: boolean })[];
  }[],
): FullSchema {
  const identifier = (raw: string) =>
    PgIdentifier.fromString(quoteIdent(raw)) as unknown as string;
  return {
    tables: tables.map((t) => ({
      type: "table",
      schemaName: identifier("public"),
      tableName: identifier(t.name),
      columns: (t.columns ?? []).map((column) =>
        typeof column === "string"
          ? { type: "column", name: identifier(column), dropped: false }
          : {
            type: "column",
            name: identifier(column.name),
            dropped: column.dropped,
          }
      ),
    })),
    indexes: [],
  } as unknown as FullSchema;
}

/** `quote_ident`, as the schema dump applies it before we ever see the name. */
function quoteIdent(raw: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(raw)
    ? raw
    : `"${raw.replaceAll('"', '""')}"`;
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

/**
 * A migration that adds a column leaves the table set and every `reltuples`
 * untouched, so neither of the original two signals sees it. The added column
 * has no `pg_statistic` row in the snapshot, and nothing synthesizes one for a
 * table the snapshot already covers — it is costed on the planner's
 * no-statistics defaults instead.
 */
describe("detectDrift — Shape Drift on columns", () => {
  it("fires when the live schema has a column the snapshot doesn't cover", () => {
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id", "email"] }),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG }),
      schema: schema([{ name: "users", columns: ["id", "email", "last_seen_at"] }]),
    });

    expect(verdict.drifted).toBe(true);
    if (!verdict.drifted) return;
    expect(verdict.kind).toBe("shape");
    expect(verdict.reason).toContain("public.users.last_seen_at");
  });

  it("does not fire once the snapshot covers everything the schema has", () => {
    // The steady state, and the one that has to hold: a signal that stays lit
    // after the dump it asked for would re-dump on every 60s poll forever.
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id", "email"] }),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG }),
      schema: schema([{ name: "users", columns: ["id", "email"] }]),
    });

    expect(verdict.drifted).toBe(false);
  });

  it.each([
    ["camelCase", "lastSeenAt"],
    ["a reserved word", "user"],
    ["an embedded double quote", 'we"ird'],
  ])(
    "converges on a name needing quotes: %s",
    (_case, columnName) => {
      // The snapshot reads `pg_attribute` raw; the schema runs the name through
      // `quote_ident` and then `PgIdentifier`, which escapes it again. Any name
      // the two sides can't agree on is a full dump every 60 seconds, forever.
      const baseline = baselineFromDump([
        table("users", BIG, { columns: ["id", columnName] }),
      ]);

      const verdict = detectDrift(baseline, {
        reltuples: reltuples({ users: BIG }),
        schema: schema([{ name: "users", columns: ["id", columnName] }]),
      });

      expect(verdict.drifted).toBe(false);
    },
  );

  it("ignores a column flagged dropped, whichever side filters it", () => {
    // Both dumps filter `attisdropped` today, so this state does not reach us
    // in practice. The schema carries the flag, and a column missing by
    // construction would ask for a dump it can never be satisfied by.
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id"] }),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG }),
      schema: schema([
        { name: "users", columns: ["id", { name: "legacy", dropped: true }] },
      ]),
    });

    expect(verdict.drifted).toBe(false);
  });

  it("ignores columns on a relation the snapshot never covered", () => {
    // The table checks own an uncovered table, and they read the `pg_class`
    // probe rather than the schema. The two disagree on materialized views:
    // the schema carries them, the probe and the statistics dump don't. Firing
    // here would ask for a dump that can never satisfy it.
    const baseline = baselineFromDump([table("users", BIG, { columns: ["id"] })]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG }),
      schema: schema([
        { name: "users", columns: ["id"] },
        { name: "mv_active_users", columns: ["id", "last_seen_at"] },
      ]),
    });

    expect(verdict.drifted).toBe(false);
  });

  it("does not fire when a column is dropped from a covered table", () => {
    // Deliberate. Restore matches the snapshot against the live relation by
    // name, so a column that no longer exists matches nothing and costs
    // nothing. Spending a full dump to delete unread rows is the noise this
    // signal exists to avoid.
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id", "email", "legacy_flag"] }),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG }),
      schema: schema([{ name: "users", columns: ["id", "email"] }]),
    });

    expect(verdict.drifted).toBe(false);
  });

  it("takes precedence over a simultaneous size change", () => {
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id"] }),
    ]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG * 10 }),
      schema: schema([{ name: "users", columns: ["id", "email"] }]),
    });

    if (!verdict.drifted) throw new Error("expected drift");
    expect(verdict.kind).toBe("shape");
  });

  it("reports an uncovered table ahead of an uncovered column", () => {
    // Both are true at once: `teams` is new, and `users` gained a column. Only
    // an order that checks tables first can report the table, so this pins the
    // order rather than restating it.
    const baseline = baselineFromDump([table("users", BIG, { columns: ["id"] })]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: BIG, teams: 0 }),
      schema: schema([
        { name: "users", columns: ["id", "email"] },
        { name: "teams", columns: ["id", "name"] },
      ]),
    });

    if (!verdict.drifted) throw new Error("expected drift");
    expect(verdict.reason).toContain("table(s)");
    expect(verdict.reason).toContain("public.teams");
    expect(verdict.reason).not.toContain("public.users.email");
  });

  it("checks nothing when the poll has produced no schema yet", () => {
    const baseline = baselineFromDump([
      table("users", BIG, { columns: ["id", "email"] }),
    ]);

    const verdict = detectDrift(baseline, { reltuples: reltuples({ users: BIG }) });

    expect(verdict.drifted).toBe(false);
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

  it("fires on a quarter-sized move", () => {
    // A table a quarter bigger than the snapshot has every query against it
    // costed a quarter light, which is well past what a planner shrugs off.
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: Math.round(BIG * 1.25) }),
    });

    expect(verdict.drifted).toBe(true);
  });

  it("ignores a move below the ratio", () => {
    // One autoanalyze tick. `pg_class.reltuples` only moves when autovacuum
    // analyzes the table, so a move this size is as likely to be the sampling
    // catching up as the data actually growing.
    const baseline = baselineFromDump([table("users", BIG)]);

    const verdict = detectDrift(baseline, {
      reltuples: reltuples({ users: Math.round(BIG * 1.1) }),
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
      reltuples: reltuples({ users: BIG * 0.85, teams: BIG * 0.95 }),
    });

    expect(verdict.drifted).toBe(false);
    // users moved 15%, teams 5%. The threshold is 20%, so neither fires.
    expect(verdict.drifted === false && verdict.closest).toEqual({
      table: "public.users",
      ratio: expect.closeTo(0.15, 5),
    });
  });

  it("reports no closest table when none was eligible", () => {
    // Both sides below the row floor, so Size Drift never considers them.
    const baseline = baselineFromDump([table("tiny", 10)]);

    const verdict = detectDrift(baseline, { reltuples: reltuples({ tiny: 900 }) });

    expect(verdict.drifted === false && verdict.closest).toBeUndefined();
  });
});
