import {
  type Postgres,
  Statistics,
  type StatisticsMode,
} from "@query-doctor/core";

const DEFAULT_RELTUPLES = 10_000;

/**
 * Build a `fromStatisticsExport` stats mode from the live database.
 *
 * PostgreSQL's planner ignores `pg_class.relpages` for tables with data on
 * disk — it reads the actual page count via `RelationGetNumberOfBlocks()`.
 * It then estimates tuples as:
 *
 *     estimated_tuples = actual_pages × pg_class.reltuples ÷ pg_class.relpages
 *
 * The old `fromAssumption` default (reltuples=10 000, relpages=1) causes a
 * massive inflation when tables have real data (e.g. 167 pages → 1.67 M
 * estimated tuples).
 *
 * By reading the real `relpages` from pg_class (after ANALYZE) and pairing
 * it with a correct reltuples, the formula produces the correct estimate
 * regardless of actual data volume.  Column-level statistics (`pg_statistic`)
 * are left untouched — ANALYZE already populated them.
 *
 * All tables are assumed to have 10,000 rows regardless of actual data.
 */
export async function buildStatsFromDatabase(
  db: Postgres,
): Promise<StatisticsMode> {
  type TableRow = {
    tableName: string;
    schemaName: string;
    relpages: number;
    relallvisible: number;
  };
  type IndexRow = TableRow & { indexName: string; reltuples: number };

  const [tables, indexes] = await Promise.all([
    db.exec<TableRow>(`
      SELECT c.relname       AS "tableName",
             n.nspname       AS "schemaName",
             c.relpages::int AS "relpages",
             c.relallvisible::int AS "relallvisible"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') -- @qd_introspection
    `),
    db.exec<IndexRow>(`
      SELECT t.relname       AS "tableName",
             n.nspname       AS "schemaName",
             i.relname       AS "indexName",
             i.reltuples::real AS "reltuples",
             i.relpages::int AS "relpages",
             i.relallvisible::int AS "relallvisible"
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') -- @qd_introspection
    `),
  ]);

  const indexesByTable = new Map<string, IndexRow[]>();
  for (const idx of indexes) {
    const key = `${idx.schemaName}.${idx.tableName}`;
    const list = indexesByTable.get(key) ?? [];
    list.push(idx);
    indexesByTable.set(key, list);
  }

  const stats = tables.map((t) => ({
    tableName: t.tableName,
    schemaName: t.schemaName,
    reltuples: DEFAULT_RELTUPLES,
    relpages: Math.max(1, t.relpages),
    relallvisible: t.relallvisible ?? 0,
    columns: null,
    indexes: (
      indexesByTable.get(`${t.schemaName}.${t.tableName}`) ?? []
    ).map((i) => ({
      indexName: i.indexName,
      relpages: Math.max(1, i.relpages),
      reltuples: i.reltuples,
      relallvisible: i.relallvisible ?? 0,
    })),
  }));

  return Statistics.statsModeFromExport(stats);
}
