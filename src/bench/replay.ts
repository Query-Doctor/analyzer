import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { StatisticsMode } from "@query-doctor/core";

/**
 * Builds a benchmark workload from a recorded CI run.
 *
 * The generated shapes only measure what someone thought to generate. This one
 * takes the schema and the queries a real project actually ran, so a change to
 * rewriting, to covering indexes, or to anything else shows up without a shape
 * being written for it first.
 *
 * A run carries the exported statistics, which name every table, every column
 * and its Postgres type, and every index. That is enough to rebuild the
 * database the queries were costed against.
 */

export const REPLAY_VERSION = 1;

type ExportedColumn = {
  columnName: string;
  attlen: number | null;
  dataType?: string;
};

type ExportedTable = {
  schemaName: string;
  tableName: string;
  reltuples: number;
  columns: ExportedColumn[];
  indexes: { indexName: string; amname?: string }[];
};

export type CiRun = {
  repo: string;
  statisticsMode: StatisticsMode & { stats?: ExportedTable[] };
  queries: { hash: string; query: string }[];
};

/**
 * `pg_type` names as the dump reports them, mapped to something `CREATE TABLE`
 * accepts. An unknown type becomes `text`: enums and composites are named by
 * the type they were declared as, which does not exist in a fresh database, and
 * the queries here are costed rather than executed for their values.
 */
const TYPES: Record<string, string> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  smallint: "smallint",
  integer: "integer",
  bigint: "bigint",
  float4: "real",
  float8: "double precision",
  real: "real",
  numeric: "numeric",
  bool: "boolean",
  boolean: "boolean",
  text: "text",
  varchar: "text",
  "character varying": "text",
  bpchar: "text",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  time: "time",
  interval: "interval",
  bytea: "bytea",
  inet: "inet",
  tsvector: "tsvector",
  ARRAY: "text[]",
};

export function columnType(dataType: string | undefined): string {
  if (!dataType) return "text";
  return TYPES[dataType] ?? "text";
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** A value of the right type, varying with `g` so a column is not all one value. */
function sampleValue(type: string): string {
  switch (type) {
    case "smallint":
    case "integer":
    case "bigint":
      return "(g % 1000)";
    case "real":
    case "double precision":
    case "numeric":
      return "(g % 1000)::numeric / 7";
    case "boolean":
      return "(g % 2 = 0)";
    case "uuid":
      // Deterministic, and distinct per row.
      return "md5(g::text)::uuid";
    case "json":
    case "jsonb":
      return `jsonb_build_object('k', g % 50, 'v', 'value_' || (g % 200))`;
    case "date":
      return "current_date - (g % 500)";
    case "timestamp":
    case "timestamptz":
      return "now() - ((g % 5000) || ' minutes')::interval";
    case "time":
      return "'12:00'::time";
    case "interval":
      return "((g % 100) || ' days')::interval";
    case "bytea":
      return "decode(md5(g::text), 'hex')";
    case "inet":
      return "('10.0.0.' || (g % 250 + 1))::inet";
    case "tsvector":
      return "to_tsvector('simple', 'row ' || g)";
    case "text[]":
      return "ARRAY['a_' || (g % 20)]";
    default:
      return "('text_' || (g % 500))";
  }
}

export function schemaStatements(
  tables: ExportedTable[],
  rowsPerTable: number,
): string[] {
  const statements: string[] = [];
  const schemas = new Set(tables.map((t) => t.schemaName));
  for (const schema of schemas) {
    if (schema !== "public") {
      statements.push(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)};`);
    }
  }

  for (const table of tables) {
    const name = `${quote(table.schemaName)}.${quote(table.tableName)}`;
    const columns = table.columns
      .map((c) => `${quote(c.columnName)} ${columnType(c.dataType)}`)
      .join(", ");
    if (!columns) continue;
    statements.push(`CREATE TABLE ${name} (${columns});`);

    // Rows scaled to the table's real size, capped. Empty tables make CREATE
    // INDEX free and EXPLAIN never touch a page, which is how a benchmark ends
    // up measuring planning and nothing else.
    //
    // Postgres writes -1 for a table it has never analyzed and 0 for one that
    // is genuinely empty. An empty table stays empty here, because it is empty
    // in production too and its indexes really are free to build.
    const reltuples = Math.round(table.reltuples);
    const rows =
      reltuples < 0 ? rowsPerTable : Math.min(rowsPerTable, reltuples);
    const values = table.columns
      .map((c) => sampleValue(columnType(c.dataType)))
      .join(", ");
    statements.push(
      `INSERT INTO ${name} (${table.columns.map((c) => quote(c.columnName)).join(", ")}) ` +
        `SELECT ${values} FROM generate_series(1, ${rows}) g;`,
    );
  }
  return statements;
}

export function readCiRun(path: string): CiRun {
  return JSON.parse(readFileSync(path, "utf8")) as CiRun;
}

export type ReplayWorkload = {
  repo: string;
  tables: number;
  statements: string[];
  queries: { hash: string; query: string }[];
  statistics: StatisticsMode;
};

export function buildReplay(
  run: CiRun,
  options: { rowsPerTable?: number; maxQueries?: number } = {},
): ReplayWorkload {
  const tables = run.statisticsMode.stats ?? [];
  const queries = (run.queries ?? [])
    .filter((q) => typeof q.query === "string" && q.query.trim().length > 0)
    // Sorted by hash so a replay covers the same queries in the same order on
    // both sides of a comparison, whatever order the run recorded them in.
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .slice(0, options.maxQueries ?? Number.POSITIVE_INFINITY);

  return {
    repo: run.repo,
    tables: tables.length,
    statements: schemaStatements(tables, options.rowsPerTable ?? 2000),
    queries,
    statistics: run.statisticsMode,
  };
}

/**
 * Applies the schema. Each statement runs on its own, because a type this
 * database does not have should cost its own table rather than the whole
 * replay, and the count of what failed is worth reporting.
 */
export async function applySchema(
  connectionString: string,
  statements: string[],
): Promise<{ applied: number; failed: string[] }> {
  const pool = new Pool({ connectionString });
  const failed: string[] = [];
  let applied = 0;
  try {
    for (const statement of statements) {
      try {
        await pool.query(statement);
        applied++;
      } catch (error) {
        failed.push(
          `${statement.slice(0, 70)}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
  return { applied, failed };
}
