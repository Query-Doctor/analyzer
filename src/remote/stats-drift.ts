import type { ExportedStats } from "@query-doctor/core";

/**
 * Decides when the production-statistics snapshot the server holds has fallen
 * far enough behind the source database to be worth re-dumping (ADR 0007 §2).
 *
 * The full `DUMP_STATS_SQL` is expensive, so it is earned by detected change
 * rather than run on a timer. Two signals, both cheap:
 *
 * - **Shape Drift** — the source has tables the last pushed dump doesn't cover,
 *   or has dropped tables it did. Free: the analyzer already polls the schema
 *   every 60s, so this is a set comparison with no extra query.
 * - **Size Drift** — per-table `reltuples` have moved past a threshold. Costs
 *   one `pg_class` read; never touches `pg_statistic`.
 *
 * Shape Drift is the one that matters most in practice: a table added by a
 * migration has no stats at all, so every query touching it is costed by the
 * synthesizer instead of real data until the snapshot catches up.
 */

/** A table's identity in a dump, as `"schema.table"`. */
export type TableKey = string;

export interface StatsBaseline {
  /** Tables the last pushed dump covered. */
  tables: Set<TableKey>;
  /** Their `reltuples` at that moment, for the Size Drift comparison. */
  reltuples: Map<TableKey, number>;
}

/** The current cheap reading from the source, for comparison against a baseline. */
export interface SourceReltuples {
  reltuples: Map<TableKey, number>;
}

export type DriftVerdict =
  | { drifted: false }
  | { drifted: true; kind: "shape" | "size"; reason: string };

/**
 * Ratio a table's `reltuples` must move by before Size Drift fires. 0.5 means
 * the table has to halve or grow by 50%; below that the planner's choices are
 * unlikely to change enough to be worth a full dump.
 */
export const DEFAULT_SIZE_DRIFT_RATIO = 0.5;

/**
 * Tables smaller than this are exempt from Size Drift. A table going from 2 to
 * 4 rows is a 100% move and means nothing to the planner; without this floor a
 * nearly-empty table would trigger a dump on every poll.
 */
export const SIZE_DRIFT_MIN_ROWS = 1_000;

export function baselineFromDump(stats: ExportedStats[]): StatsBaseline {
  const tables = new Set<TableKey>();
  const reltuples = new Map<TableKey, number>();
  for (const table of stats) {
    const key = tableKey(table.schemaName, table.tableName);
    tables.add(key);
    reltuples.set(key, table.reltuples);
  }
  return { tables, reltuples };
}

export function tableKey(
  schemaName: string | { toString(): string },
  tableName: string | { toString(): string },
): TableKey {
  return `${unquote(String(schemaName))}.${unquote(String(tableName))}`;
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1)
    : identifier;
}

/**
 * Compares the source's current table set and row counts against the last dump
 * that was pushed. Shape Drift is checked first: it's free, and a table with no
 * stats at all is a worse problem than one whose count moved.
 */
export function detectDrift(
  baseline: StatsBaseline,
  current: SourceReltuples,
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
  }

  return { drifted: false };
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
