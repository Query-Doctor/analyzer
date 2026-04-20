import { bench, describe, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { RecentQuery, QueryHash } from "../sql/recent-query.ts";
import type { StatisticsMode } from "@query-doctor/core";

const PG_COMMAND = [
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

type BenchContext = {
  manager: ConnectionManager;
  optimizer: QueryOptimizer;
  queries: RecentQuery[];
  stats: StatisticsMode;
};

// ---------------------------------------------------------------------------
// Schema & query generators
// ---------------------------------------------------------------------------

function tName(i: number): string {
  return `t_${String(i).padStart(3, "0")}`;
}

function generateDDL(tableCount: number): string {
  const stmts: string[] = [];
  for (let i = 1; i <= tableCount; i++) {
    const t = tName(i);
    const hasRef = i > 1;
    stmts.push(`CREATE TABLE ${t} (
      id serial PRIMARY KEY,${hasRef ? "\n      ref_id int," : ""}
      name text,
      value numeric(10,2),
      status text,
      active boolean DEFAULT true,
      created_at timestamp DEFAULT now()
    );`);
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
    const columns = [
      "id",
      ...(hasRef ? ["ref_id"] : []),
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
      Date.now(),
    );
    results.push(query);
  }
  return results;
}

async function setupDatabase(
  baseUrl: string,
  dbName: string,
  tableCount: number,
  queryCount: number,
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
  const queries = await parseQueries(generateQueries(tableCount, queryCount));
  const stats = generateStats(tableCount);

  return { manager, optimizer, queries, stats };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let small: BenchContext;
let medium: BenchContext;
let large: BenchContext;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17")
    .withCommand(PG_COMMAND)
    .start();

  const baseUrl = container.getConnectionUri();
  small = await setupDatabase(baseUrl, "bench_small", 3, 5);
  medium = await setupDatabase(baseUrl, "bench_medium", 20, 100);
  large = await setupDatabase(baseUrl, "bench_large", 300, 1000);
}, 300_000);

afterAll(async () => {
  for (const ctx of [small, medium, large]) {
    if (ctx) {
      ctx.optimizer.stop();
      await ctx.manager.closeAll();
    }
  }
  if (container) await container.stop();
});

describe("query optimizer", () => {
  bench(
    "small  (3 tables, 5 queries)",
    async () => {
      await small.optimizer.start(small.queries, small.stats);
    },
    { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 },
  );

  bench(
    "medium (20 tables, 100 queries)",
    async () => {
      await medium.optimizer.start(medium.queries, medium.stats);
    },
    { iterations: 3, warmupIterations: 1, time: 0, warmupTime: 0 },
  );

  bench(
    "large  (300 tables, 1000 queries)",
    async () => {
      await large.optimizer.start(large.queries, large.stats);
    },
    { iterations: 3, warmupIterations: 1, time: 0, warmupTime: 0 },
  );
});
