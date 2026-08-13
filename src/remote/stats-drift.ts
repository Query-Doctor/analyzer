import type { ExportedStats, FullSchema } from "@query-doctor/core";

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
 * Every comparison here is presence-only, and in one direction: the source has
 * something the snapshot lacks.
 *
 * Presence-only because the two sides don't speak the same dialect anywhere
 * else. A column's type reaches the schema through `format_type` (`character
 * varying(255)`) and the snapshot through `pg_type.typname` (`varchar`), so
 * comparing types would call every column changed on every poll. Catching a
 * type change needs the dump to export `format_type` first.
 *
 * One direction because a relation the snapshot covers and the source has
 * dropped costs nothing: the restore matches the snapshot to the live database
 * by name, so the extra entry matches nothing. Spending a full dump to delete
 * rows no query reads is the noise this signal exists to avoid.
 *
 * Indexes are deliberately not compared, though the snapshot carries their
 * names. `DUMP_STATS_SQL` collects them in a CTE filtered by
 * `relname NOT LIKE 'pg_%'` — where `_` is a wildcard, so a table called
 * `pgmigrations` or `pgbench_accounts` is exported with its columns and an
 * empty index list. That table's indexes would read as uncovered after the very
 * dump that was meant to cover them, which is a full dump every 60 seconds
 * forever. The same CTE groups by `relname` alone, so same-named tables in
 * different schemas share one index list and a genuinely new index is masked
 * anyway. Both are fixable only in the dump.
 */

/** A table's identity in a dump, as `"schema.table"`. */
export type TableKey = string;

export interface StatsBaseline {
  /** Tables the last pushed dump covered. */
  tables: Set<TableKey>;
  /** Their `reltuples` at that moment, for the Size Drift comparison. */
  reltuples: Map<TableKey, number>;
  /** The column names it covered on each of them, unquoted. */
  columns: Map<TableKey, Set<string>>;
}

/** The current cheap reading from the source, for comparison against a baseline. */
export interface SourceReading {
  reltuples: Map<TableKey, number>;
  /**
   * The live schema from the same poll tick, which carries the columns
   * `reltuples` alone can't see. Optional: a caller that has no schema yet gets
   * the table and size checks and skips the rest, rather than reading an absent
   * schema as an empty database.
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
  const tables = new Set<TableKey>();
  const reltuples = new Map<TableKey, number>();
  const columns = new Map<TableKey, Set<string>>();
  for (const table of stats) {
    const key = tableKey(table.schemaName, table.tableName);
    tables.add(key);
    reltuples.set(key, table.reltuples);
    // Every live column, whether or not Postgres has analyzed it — the dump
    // reads `pg_attribute` and left-joins `pg_statistic`. So a column that has
    // never been analyzed still lands here, and asking for a dump on its
    // account would ask forever.
    //
    // Defended rather than trusted: a seeded baseline is whatever the server
    // stored, which for an old enough capture may carry no columns key at all.
    // Reading that as "covers no columns" earns one re-dump and then converges,
    // where trusting the type throws inside the poll and no refresh ever runs.
    columns.set(
      key,
      new Set((table.columns ?? []).map((c) => unquote(c.columnName))),
    );
  }
  return { tables, reltuples, columns };
}

export function tableKey(
  schemaName: string | { toString(): string },
  tableName: string | { toString(): string },
): TableKey {
  return `${unquote(String(schemaName))}.${unquote(String(tableName))}`;
}

/**
 * Undo `quote_ident`, collapsing escaped quotes until the name stops changing.
 *
 * The two sides of a comparison reach us in different dialects. The statistics
 * dump reads `pg_attribute` raw; the schema poll runs `quote_ident` and then
 * `PgIdentifier` escapes that result a second time, so a column named `we"ird`
 * arrives as `"we""""ird"` against a raw `we"ird`. Undoing one level leaves
 * them unequal, and a name that never matches asks for a full dump on every
 * poll, forever.
 *
 * Collapsing to a fixed point lands both dialects on the raw name. It also
 * makes two names that differ only in how many quotes they contain compare
 * equal, so a deliberately hostile identifier can read as covered when it
 * isn't. That costs one missed refresh; the loop it replaces costs a full dump
 * every 60 seconds.
 */
function unquote(identifier: string): string {
  if (
    identifier.length < 2 || !identifier.startsWith('"') ||
    !identifier.endsWith('"')
  ) {
    return identifier;
  }
  let value = identifier.slice(1, -1);
  while (value.includes('""')) {
    value = value.replaceAll('""', '"');
  }
  return value;
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
  if (added.length > 0) {
    return {
      drifted: true,
      kind: "shape",
      reason: `${added.length} table(s) not covered by the snapshot: ${
        summarize(added)
      }`,
    };
  }

  const dropped: TableKey[] = [];
  for (const key of baseline.tables) {
    if (!current.reltuples.has(key)) dropped.push(key);
  }
  if (dropped.length > 0) {
    return {
      drifted: true,
      kind: "shape",
      reason: `${dropped.length} table(s) in the snapshot no longer exist: ${
        summarize(dropped)
      }`,
    };
  }

  const uncovered = uncoveredColumns(baseline, current.schema);
  if (uncovered) {
    return { drifted: true, kind: "shape", reason: uncovered };
  }

  let closest: { table: TableKey; ratio: number } | undefined;
  for (const [key, now] of current.reltuples) {
    const before = baseline.reltuples.get(key);
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

/**
 * Columns the live schema has on a table the snapshot covers, and the snapshot
 * doesn't. Returns the reason to re-dump, or undefined for none.
 *
 * Tables the snapshot doesn't cover at all are skipped: the checks above own
 * them, and they read the `pg_class` probe rather than the schema. The two
 * disagree on purpose — the probe is `relkind = 'r'`, while the schema also
 * carries materialized views, which no statistics dump will ever cover.
 * Reporting those here would ask for a dump that cannot satisfy it.
 */
function uncoveredColumns(
  baseline: StatsBaseline,
  schema: FullSchema | undefined,
): string | undefined {
  if (!schema) return undefined;

  const columns: string[] = [];
  for (const table of schema.tables) {
    const key = tableKey(table.schemaName, table.tableName);
    const covered = baseline.columns.get(key);
    if (!covered) continue;
    for (const column of table.columns) {
      // Belt and braces: both dumps filter `attisdropped` today, so a dropped
      // column reaches neither side. Left in because the schema carries the
      // flag, and a column that is missing by construction would never stop
      // asking for a dump.
      if (column.dropped) continue;
      const name = unquote(String(column.name));
      if (!covered.has(name)) columns.push(`${key}.${name}`);
    }
  }
  if (columns.length === 0) return undefined;

  return `${columns.length} column(s) not covered by the snapshot: ${
    summarize(columns)
  }`;
}

function summarize(keys: TableKey[]): string {
  const shown = keys.slice(0, 5);
  const rest = keys.length - shown.length;
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
