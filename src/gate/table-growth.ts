// Why a query got more expensive when the diff did not touch it.
//
// A cost comparison sees two numbers and calls the difference a regression. But
// a plan's cost moves when the data underneath it moves, and the baseline can be
// a day old — long enough for a table to grow by most of its size. On the run
// that prompted this, `project_queries` grew 80% overnight and nine queries
// reading it "regressed" on a pull request that changed one markdown file.
//
// Both runs carry the row counts the planner used, so the comment can say which
// table grew instead of leaving the reader to blame their own diff.

/** The row-count snapshot a run was planned against (`computedStats`). */
export interface RunStats {
  reltuples: { relname: string; schema_name: string; reltuples: number }[];
}

export interface TableGrowth {
  table: string;
  before: number;
  after: number;
  /** Growth as a percentage of the baseline, rounded. */
  percent: number;
}

/** Growth below this is noise, not an explanation for a cost move. */
const MIN_GROWTH_PERCENT = 10;

/**
 * Tables that grew between the baseline run and this one, largest first. Empty
 * when either run has no statistics, which is the case for a run planned on
 * assumptions rather than an export.
 */
export function tableGrowth(
  baseline: RunStats | undefined,
  current: RunStats | undefined,
  /**
   * The run's actual tables. `computedStats.reltuples` lists every relation,
   * including indexes, and an index reports its table's row count — so without
   * this filter one table that grew is reported once per index on it.
   */
  tables?: ReadonlySet<string>,
): TableGrowth[] {
  if (!baseline?.reltuples || !current?.reltuples) return [];

  const before = new Map(
    baseline.reltuples
      .filter((r) => r.schema_name === "public")
      .map((r) => [r.relname, r.reltuples]),
  );

  const grown: TableGrowth[] = [];
  for (const row of current.reltuples) {
    if (row.schema_name !== "public") continue;
    if (tables && !tables.has(row.relname)) continue;
    const was = before.get(row.relname);
    // A table absent from the baseline has no growth to report, and one that
    // was empty would divide by zero.
    if (was === undefined || was <= 0 || row.reltuples <= was) continue;
    const percent = Math.round(((row.reltuples - was) / was) * 100);
    if (percent < MIN_GROWTH_PERCENT) continue;
    grown.push({ table: row.relname, before: was, after: row.reltuples, percent });
  }

  return grown.sort((a, b) => b.percent - a.percent);
}
