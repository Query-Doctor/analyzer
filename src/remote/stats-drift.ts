import type { ExportedStats, FullSchema } from "@query-doctor/core";
import { PgIdentifier } from "@query-doctor/core";

/**
 * Decides when the production-statistics snapshot the server holds has fallen
 * far enough behind the source database to be worth re-dumping (ADR 0007 §2).
 *
 * The full `DUMP_STATS_SQL` is expensive, so it is earned by detected change
 * rather than run on a timer. Two signals, both cheap:
 *
 * - **Shape Drift** — the source holds a relation the last pushed dump doesn't
 *   cover: a table, or a column on a table it does cover. Free: the analyzer
 *   already polls the schema every 60s, so this is a set comparison with no
 *   extra query.
 * - **Size Drift** — per-table `reltuples` have moved past a threshold. Costs
 *   one `pg_class` read; never touches `pg_statistic`.
 *
 * Shape Drift is the one that matters most in practice. Anything the snapshot
 * doesn't cover is costed on estimates rather than measurements: a whole table
 * goes to the synthesizer, and a column on a covered table goes to the
 * planner's no-statistics defaults, which nothing synthesizes and nothing
 * reports.
 *
 * Columns are compared on presence, never on type. A column's type reaches the
 * schema through `format_type` (`character varying(255)`) and the snapshot
 * through `pg_type.typname` (`varchar`), so comparing types would call every
 * column changed on every poll. Catching a type change needs the dump to export
 * `format_type` first.
 *
 * A dropped column is not drift, where a dropped table is. Restore matches the
 * snapshot to the live database by name, so a column the source no longer has
 * matches nothing and costs nothing, and spending a full dump to delete rows no
 * query reads is the noise this signal exists to avoid. A dropped table is
 * cheap to notice and rare enough to be worth a dump.
 *
 * Indexes are not compared, though the snapshot carries their names, because
 * `DUMP_STATS_SQL`'s index list is not a sound baseline: its CTE filters
 * `relname NOT LIKE 'pg_%'`, where `_` is a wildcard, and groups by `relname`
 * alone. See Query-Doctor/Site#4005 and Query-Doctor/Site#3959.
 */

/** A table's identity in a dump, as `"schema.table"`. */
export type TableKey = string;

export interface StatsBaseline {
  /** What the last pushed dump covered, per table it covered. */
  tables: Map<TableKey, CoveredTable>;
}

interface CoveredTable {
  /** Its `reltuples` at that moment, for the Size Drift comparison. */
  reltuples: number;
  /** Its column names, as Postgres reports them. */
  columns: Set<string>;
}

/** The current cheap reading from the source, for comparison against a baseline. */
export interface SourceReading {
  reltuples: Map<TableKey, number>;
  /**
   * The live schema from the same poll tick, which carries the columns
   * `reltuples` alone can't see. Omit it to run only the table and size checks;
   * an absent schema is never read as an empty database.
   */
  schema?: FullSchema;
}

export type DriftVerdict =
  /**
   * `closest` is the table that came nearest to the ratio without reaching it,
   * absent when no table was eligible. A refresh that never fires looks the
   * same from outside whether nothing moved or one table sat just under the
   * threshold, and those call for opposite fixes.
   */
  | { drifted: false; closest?: { table: TableKey; ratio: number } }
  | { drifted: true; kind: "shape" | "size"; reason: string };

/**
 * Ratio a table's `reltuples` must move by before Size Drift fires. 0.2 means
 * the table has to grow or shrink by a fifth.
 *
 * The floor under this number is the resolution of the signal it reads.
 * `pg_class.reltuples` is only rewritten when autovacuum analyzes the table,
 * which by default happens once it has changed by `autovacuum_analyze_scale_
 * factor` — 10%. A threshold below that would be reading sampling noise rather
 * than the data moving.
 *
 * The ceiling is how wrong a cost may be before it stops being worth
 * reporting. At the old 0.5 a table could sit half again its snapshot size and
 * still be called current, so every query against it was costed a third light
 * — a bigger error than most of what we flag.
 */
export const DEFAULT_SIZE_DRIFT_RATIO = 0.2;

/**
 * Tables smaller than this are exempt from Size Drift. A table going from 2 to
 * 4 rows is a 100% move and means nothing to the planner; without this floor a
 * nearly-empty table would trigger a dump on every poll.
 */
export const SIZE_DRIFT_MIN_ROWS = 1_000;

export function baselineFromDump(stats: ExportedStats[]): StatsBaseline {
  const tables = new Map<TableKey, CoveredTable>();
  for (const table of stats) {
    // Every live column, whether or not Postgres has analyzed it — the dump
    // reads `pg_attribute` and left-joins `pg_statistic`. So a column that has
    // never been analyzed still lands here, and asking for a dump on its
    // account would ask forever.
    //
    // Defended rather than trusted: a seeded baseline is whatever the server
    // stored, which for an old enough capture may carry no columns key at all.
    // Reading that as "covers no columns" earns one re-dump and then converges,
    // where trusting the type throws inside the poll and no refresh ever runs.
    tables.set(tableKey(table.schemaName, table.tableName), {
      reltuples: table.reltuples,
      columns: new Set((table.columns ?? []).map((c) => c.columnName)),
    });
  }
  return { tables };
}

function tableKey(
  schemaName: string | PgIdentifier,
  tableName: string | PgIdentifier,
): TableKey {
  return `${rawName(schemaName)}.${rawName(tableName)}`;
}

/**
 * The raw name Postgres reports, from either side of the comparison.
 *
 * The capture reads `pg_attribute` and `pg_class` directly, so its identifiers
 * are already raw strings. The schema poll's went through `quote_ident` before
 * `PgIdentifier` wrapped them, and `unquoted()` returns the value as
 * `fromString` recorded it, which leaves that one level of doubling in place.
 * A name compared in the wrong dialect never matches, and a relation that never
 * matches asks for a full dump on every poll, forever.
 *
 * Same pairing, for the same reason, as `parentTableKey` in core's
 * `sql/foreign-keys.ts`.
 */
function rawName(identifier: string | PgIdentifier): string {
  return identifier instanceof PgIdentifier
    ? identifier.unquoted().replaceAll('""', '"')
    : identifier;
}

/**
 * Compares the source's current shape and row counts against the last dump that
 * was pushed. Shape Drift is checked first: it's free, and a relation with no
 * stats at all is a worse problem than one whose count moved. Within it, whole
 * tables come before columns — a new table's columns are all missing at once,
 * and "one table is uncovered" is the reason a reader can act on.
 */
export function detectDrift(
  baseline: StatsBaseline,
  current: SourceReading,
  options?: { sizeDriftRatio?: number; minRows?: number },
): DriftVerdict {
  const ratio = options?.sizeDriftRatio ?? DEFAULT_SIZE_DRIFT_RATIO;
  const minRows = options?.minRows ?? SIZE_DRIFT_MIN_ROWS;

  const added: TableKey[] = [];
  for (const key of current.reltuples.keys()) {
    if (!baseline.tables.has(key)) added.push(key);
  }

  const dropped: TableKey[] = [];
  for (const key of baseline.tables.keys()) {
    if (!current.reltuples.has(key)) dropped.push(key);
  }

  const shapeDrift = shape(added, "table(s) not covered by the snapshot") ??
    shape(dropped, "table(s) in the snapshot no longer exist") ??
    shape(
      uncoveredColumns(baseline, current.schema),
      "column(s) not covered by the snapshot",
    );
  if (shapeDrift) return shapeDrift;

  let closest: { table: TableKey; ratio: number } | undefined;
  for (const [key, now] of current.reltuples) {
    const before = baseline.tables.get(key)?.reltuples;
    if (before === undefined) continue;
    // Exempt tables that are small on both sides. A table that grew past the
    // floor is a real change even if it started tiny.
    if (before < minRows && now < minRows) continue;
    const denominator = Math.max(before, 1);
    const moved = Math.abs(now - before) / denominator;
    if (moved >= ratio) {
      return {
        drifted: true,
        kind: "size",
        reason: `${key} moved from ${before} to ${now} rows (${
          Math.round(moved * 100)
        }%)`,
      };
    }
    if (!closest || moved > closest.ratio) {
      closest = { table: key, ratio: moved };
    }
  }

  return { drifted: false, closest };
}

/** A Shape Drift verdict over whatever was found missing, or undefined if none was. */
function shape(items: string[], phrase: string): DriftVerdict | undefined {
  if (items.length === 0) return undefined;
  return {
    drifted: true,
    kind: "shape",
    reason: `${items.length} ${phrase}: ${summarize(items)}`,
  };
}

/**
 * Columns the live schema has on a table the snapshot covers, and the snapshot
 * doesn't, as `schema.table.column`.
 *
 * Tables the snapshot doesn't cover at all are skipped: the checks above own
 * them, and they read the `pg_class` probe rather than the schema. The two
 * disagree on purpose. The probe is `relkind = 'r'`; the schema is
 * `relkind in ('r','m') AND relispartition = false`, so it adds materialized
 * views, which no statistics dump will ever cover, and omits every partition of
 * a partitioned table, which get no column check at all today.
 */
function uncoveredColumns(
  baseline: StatsBaseline,
  schema: FullSchema | undefined,
): string[] {
  if (!schema) return [];

  const columns: string[] = [];
  for (const table of schema.tables) {
    const key = tableKey(table.schemaName, table.tableName);
    const covered = baseline.tables.get(key)?.columns;
    if (!covered) continue;
    for (const column of table.columns) {
      // Belt and braces: both dumps filter `attisdropped` today, so a dropped
      // column reaches neither side. Left in because the schema carries the
      // flag, and a column that is missing by construction would never stop
      // asking for a dump.
      if (column.dropped) continue;
      const name = rawName(column.name);
      if (!covered.has(name)) columns.push(`${key}.${name}`);
    }
  }
  return columns;
}

function summarize(items: string[]): string {
  const shown = items.slice(0, 5);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

/**
 * How long a snapshot may stand without a re-dump, regardless of drift.
 *
 * Shape Drift and Size Drift both watch structure and row counts. Neither sees
 * a database whose tables and sizes hold steady while the *distribution* of its
 * data moves: histograms, most-common-value lists and correlation all age with
 * the values, not the row count. A floor bounds how wrong those can get.
 */
export const DEFAULT_REFRESH_FLOOR_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the last push is old enough to earn a re-dump on its own.
 *
 * Never true before a first push: with no baseline there is nothing to compare
 * against, and dumping on a timer for an analyzer that has never pushed would
 * publish statistics for a database the server may not expect.
 */
export function isPastRefreshFloor(
  lastPushedAt: number | undefined,
  now: number,
  floorMs: number = DEFAULT_REFRESH_FLOOR_MS,
): boolean {
  if (lastPushedAt === undefined) {
    return false;
  }
  return now - lastPushedAt >= floorMs;
}
