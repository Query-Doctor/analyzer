import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { QueryOptimizer } from "../remote/query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { RecentQuery, QueryHash } from "../sql/recent-query.ts";
import type { StatisticsMode } from "@query-doctor/core";

/**
 * Bumped whenever the generated schema, data or queries change. Two runs with
 * different versions measure different work and must never be compared.
 */
export const WORKLOAD_VERSION = 3;

/**
 * Schema and query generation for the benchmark shapes.
 *
 * Lifted unchanged out of `optimizer.bench.ts` so the shape runner and the
 * vitest bench can drive the same workload. A shape has to be byte-identical
 * across every commit it is run against, or the comparison measures the
 * generator rather than the optimizer.
 */

export type BenchContext = {
  manager: ConnectionManager;
  optimizer: QueryOptimizer;
  queries: RecentQuery[];
  stats: StatisticsMode;
};

export const PG_COMMAND = [
  "-c",
  "shared_preload_libraries=pg_stat_statements",
  "-c",
  "autovacuum=off",
  "-c",
  "track_counts=off",
  "-c",
  "track_io_timing=off",
  "-c",
  "track_activities=off",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Schema & query generators
// ---------------------------------------------------------------------------

/** Enough rows that an index build and a heap fetch cost something. */
const ROWS_PER_TABLE = 5_000;

function tName(i: number): string {
  return `t_${String(i).padStart(3, "0")}`;
}

function generateDDL(tableCount: number): string {
  const stmts: string[] = [];
  for (let i = 1; i <= tableCount; i++) {
    const t = tName(i);
    const hasRef = i > 1;
    // ref_id on every table, including the first. A query that filters on it
    // has to work whichever table it lands on, and leaving it off table one
    // made the widest shape fail with "column ref_id does not exist".
    stmts.push(`CREATE TABLE ${t} (
      id serial PRIMARY KEY,
      ref_id int,
      name text,
      value numeric(10,2),
      status text,
      active boolean DEFAULT true,
      created_at timestamp DEFAULT now()
    );`);
    // Rows, not just a schema. Version 1 created empty tables and fabricated
    // statistics claiming a hundred thousand rows, so CREATE INDEX was free and
    // EXPLAIN never touched a page: the run measured planning and nothing else.
    stmts.push(`INSERT INTO ${t} (ref_id, name, value, status, active)
      SELECT (g % 50) + 1,
        'name_' || (g % 500),
        (g % 1000)::numeric / 10,
        (ARRAY['new','open','closed'])[(g % 3) + 1],
        g % 2 = 0
      FROM generate_series(1, ${ROWS_PER_TABLE}) g;`);
    if (i % 3 === 0) stmts.push(`CREATE INDEX ${t}_name_idx ON ${t}(name);`);
    if (hasRef && i % 2 === 0)
      stmts.push(`CREATE INDEX ${t}_ref_idx ON ${t}(ref_id);`);
  }
  return stmts.join("\n");
}

const QUERY_PATTERNS: ((t: string, ref: string | null) => string)[] = [
  (t) => `SELECT * FROM ${t} WHERE name = $1`,
  (t) => `SELECT * FROM ${t} WHERE status = $1`,
  (t) => `SELECT * FROM ${t} WHERE value > $1 ORDER BY value LIMIT 50`,
  (t) => `SELECT * FROM ${t} ORDER BY created_at DESC LIMIT 50`,
  (t) => `SELECT * FROM ${t} WHERE active = $1 AND status = $2`,
  (t) => `SELECT status, COUNT(*) as cnt FROM ${t} GROUP BY status`,
  (t, ref) =>
    ref
      ? `SELECT a.id, a.name, b.name as ref_name FROM ${t} a JOIN ${ref} b ON b.id = a.ref_id WHERE a.active = $1`
      : `SELECT * FROM ${t} WHERE name = $1 AND value > $2`,
];

/**
 * Every column a query can filter on, in the order predicates are added.
 *
 * Candidates per table decide how much work the optimizer does: it builds
 * every ordered subset of them, which is 15 index definitions for three
 * candidates, 1,956 for six and 13,699 for seven. The breadth shape tops out at
 * two, so it never reaches the part that costs anything.
 */
const FILTERABLE = ["name", "status", "value", "active", "created_at", "ref_id"];

/**
 * Queries that filter on `width` columns of one table, so candidate generation
 * has something to permute. `width` is the lever: it is the number the
 * optimizer's cost is a factorial of.
 */
export function generateDepthQueries(
  tableCount: number,
  queryCount: number,
  width: number,
): string[] {
  const queries: string[] = [];
  for (let q = 0; queries.length < queryCount; q++) {
    const t = tName((q % tableCount) + 1);
    const columns = FILTERABLE.slice(0, Math.min(width, FILTERABLE.length));
    const predicates = columns
      .map((column, i) =>
        column === "value" || column === "created_at"
          ? `${column} > $${i + 1}`
          : `${column} = $${i + 1}`,
      )
      .join(" AND ");
    // The sort adds one more candidate without repeating a predicate column.
    queries.push(`SELECT id FROM ${t} WHERE ${predicates} ORDER BY id LIMIT 50`);
  }
  return queries.slice(0, queryCount);
}

function generateQueries(tableCount: number, queryCount: number): string[] {
  const queries: string[] = [];
  for (let q = 0; queries.length < queryCount; q++) {
    const tableIdx = (q % tableCount) + 1;
    const t = tName(tableIdx);
    const ref = tableIdx > 1 ? tName(Math.ceil(tableIdx / 2)) : null;
    const patternIdx = Math.floor(q / tableCount) % QUERY_PATTERNS.length;
    queries.push(QUERY_PATTERNS[patternIdx](t, ref));
  }
  return queries.slice(0, queryCount);
}

function generateStats(
  tableCount: number,
): StatisticsMode {
  const stats = [];
  for (let i = 1; i <= tableCount; i++) {
    const t = tName(i);
    const hasRef = i > 1;
    const reltuples = 100_000 + i * 1_000;
    // Matches the DDL: every table has ref_id.
    const columns = [
      "id",
      "ref_id",
      "name",
      "value",
      "status",
      "active",
      "created_at",
    ];
    const indexes: { indexName: string; relpages: number; reltuples: number; relallvisible: number; amname: "btree"; fillfactor: number; columns: { attlen: null }[] }[] = [
      {
        indexName: `${t}_pkey`,
        relpages: Math.ceil(reltuples / 500),
        reltuples,
        relallvisible: 1,
        amname: "btree",
        fillfactor: 0.9,
        columns: [{ attlen: null }],
      },
    ];
    if (i % 3 === 0)
      indexes.push({
        indexName: `${t}_name_idx`,
        relpages: Math.ceil(reltuples / 500),
        reltuples,
        relallvisible: 1,
        amname: "btree",
        fillfactor: 0.9,
        columns: [{ attlen: null }],
      });
    if (hasRef && i % 2 === 0)
      indexes.push({
        indexName: `${t}_ref_idx`,
        relpages: Math.ceil(reltuples / 500),
        reltuples,
        relallvisible: 1,
        amname: "btree",
        fillfactor: 0.9,
        columns: [{ attlen: null }],
      });
    stats.push({
      tableName: t,
      schemaName: "public",
      relpages: Math.ceil(reltuples / 100),
      reltuples,
      relallvisible: 1,
      columns: columns.map((c) => ({ columnName: c, stats: null, attlen: null })),
      indexes,
    });
  }
  return { kind: "fromStatisticsExport", source: { kind: "inline" }, stats };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function parseQueries(rawQueries: string[]): Promise<RecentQuery[]> {
  const results: RecentQuery[] = [];
  for (let i = 0; i < rawQueries.length; i++) {
    const hash = QueryHash.parse(`bench_${i}`);
    const query = await RecentQuery.analyze(
      {
        query: rawQueries[i],
        formattedQuery: rawQueries[i],
        username: "bench",
        meanTime: 0,
        calls: "1",
        rows: "0",
        topLevel: true,
      },
      hash,
      hash,
    );
    results.push(query);
  }
  return results;
}

export async function setupDatabase(
  baseUrl: string,
  dbName: string,
  tableCount: number,
  queryCount: number,
  /** When set, queries filter on this many columns of one table. */
  predicateWidth?: number,
): Promise<BenchContext> {
  const adminPool = new Pool({ connectionString: baseUrl });
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  await adminPool.end();

  const dbUrl = baseUrl.replace(/\/[^/]*$/, `/${dbName}`);
  const dbPool = new Pool({ connectionString: dbUrl });
  await dbPool.query(generateDDL(tableCount));
  await dbPool.end();

  const manager = ConnectionManager.forLocalDatabase();
  const conn = Connectable.fromString(dbUrl);
  const optimizer = new QueryOptimizer(manager, conn);
  const queries = await parseQueries(
    predicateWidth
      ? generateDepthQueries(tableCount, queryCount, predicateWidth)
      : generateQueries(tableCount, queryCount),
  );
  const stats = generateStats(tableCount);

  return { manager, optimizer, queries, stats };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

