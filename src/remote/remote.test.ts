import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import postgres from "postgresjs";
import { assertEquals } from "@std/assert/equals";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { assertArrayIncludes } from "@std/assert";
import { PgIdentifier } from "@query-doctor/core";

const TEST_TARGET_CONTAINER_NAME = "postgres:17";
const TEST_TARGET_CONTAINER_TIMESCALEDB_NAME =
  "timescale/timescaledb:latest-pg17";

export function testSpawnTarget(
  options: { content?: string; containerName?: string } = {
    containerName: TEST_TARGET_CONTAINER_NAME,
  },
) {
  let pg = new PostgreSqlContainer(
    options.containerName ?? TEST_TARGET_CONTAINER_NAME,
  );
  if (options.content) {
    pg = pg.withCopyContentToContainer([
      {
        content: options.content,
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ]);
  }
  return pg.start();
}

function assertOk<T>(
  result: { type: string; value?: T },
): asserts result is { type: "ok"; value: T } {
  assertEquals(result.type, "ok");
}

Deno.test({
  name: "syncs correctly",
  sanitizeOps: false,
  // deno is weird... the sync seems like it might be leaking resources?
  sanitizeResources: false,
  fn: async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create extension pg_stat_statements;
              create table testing(a int, b text);
              insert into testing values (1);
              create index "testing_1234" on testing(b);
              select * from testing where a = 1;
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      testSpawnTarget(
        { content: "create table testing(a int); create index on testing(a)" },
      ),
    ]);

    try {
      const target = Connectable.fromString(targetDb.getConnectionUri());
      const source = Connectable.fromString(sourceDb.getConnectionUri());

      await using remote = new Remote(
        target,
        ConnectionManager.forLocalDatabase(),
      );

      const result = await remote.syncFrom(source);
      const optimizedQueries = remote.optimizer.getQueries();

      const queries = optimizedQueries.map((f) => f.query);
      assertArrayIncludes(queries, [
        "create table testing(a int, b text)",
        "select * from testing where a = $1",
      ]);

      assertOk(result.schema);

      const tableNames = result.schema.value.tables.map((table) =>
        table.tableName.toString()
      );
      console.log("tablenames", tableNames);

      assertArrayIncludes(tableNames, ["testing"]);

      const indexNames = result.schema.value.indexes.map((index) =>
        index.indexName.toString()
      );
      assertArrayIncludes(indexNames, ["testing_1234"]);

      const sql = postgres(
        target.withDatabaseName(Remote.optimizingDbName).toString(),
      );

      const indexesAfter =
        await sql`select indexname from pg_indexes where schemaname = 'public'`;
      assertEquals(
        indexesAfter.count,
        1,
        "Indexes were not copied over correctly from the source db",
      );

      assertEquals(indexesAfter[0], { indexname: "testing_1234" });

      const tablesAfter =
        await sql`select tablename from pg_tables where schemaname = 'public'`;
      assertEquals(
        tablesAfter.count,
        1,
        "Tables were not copied over correctly from the source db",
      );
      assertEquals(
        tablesAfter[0],
        { tablename: "testing" },
        "Table name mismatch",
      );
      const rows = await sql`select * from testing`;
      // expect no rows to have been synced
      assertEquals(rows.length, 0, "Table in target db not empty");

      await sql.end();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});

// Users who upgraded from Postgres 13/14 may have a leftover bit_xor aggregate.
// It became built-in in Postgres 15, but custom versions from older installs remain.
// This test ensures sync handles this gracefully.
Deno.test({
  name: "syncs database with custom bit_xor aggregate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create extension pg_stat_statements;
              CREATE AGGREGATE public.bit_xor(v bigint) (
                SFUNC = int8xor,
                STYPE = bigint
              );
              create table testing(a bigint);
              insert into testing values (1);
              create index "testing_idx" on testing(a);
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      testSpawnTarget(),
    ]);

    try {
      const target = Connectable.fromString(targetDb.getConnectionUri());
      const source = Connectable.fromString(sourceDb.getConnectionUri());

      await using remote = new Remote(
        target,
        ConnectionManager.forLocalDatabase(),
      );

      const result = await remote.syncFrom(source);
      await remote.optimizer.finish;

      // Assert sync completed successfully (aggregate excluded gracefully)
      assertOk(result.schema);

      const tableNames = result.schema.value.tables.map((table) =>
        table.tableName.toString()
      );
      assertArrayIncludes(tableNames, ["testing"]);

      const indexNames = result.schema.value.indexes.map((index) =>
        index.indexName.toString()
      );
      assertArrayIncludes(indexNames, ["testing_idx"]);
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});

Deno.test({
  name: "raw timescaledb syncs correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [source, target] = await Promise.all([
      new PostgreSqlContainer(
        "timescale/timescaledb:latest-pg17",
      )
        .withEnvironment({
          POSTGRES_HOST_AUTH_METHOD: "trust",
        })
        .withCopyContentToContainer([
          {
            content: `
              create table testing(a int, b text);
              insert into testing values (1);
              create index "testing_1234" on testing(b);
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .start(),
      testSpawnTarget({
        containerName: TEST_TARGET_CONTAINER_TIMESCALEDB_NAME,
      }),
    ]);

    const sourceConn = Connectable.fromString(source.getConnectionUri());
    const targetConn = Connectable.fromString(target.getConnectionUri());
    const manager = ConnectionManager.forLocalDatabase();

    try {
      await using remote = new Remote(targetConn, manager);

      const t = manager.getOrCreateConnection(
        targetConn.withDatabaseName(PgIdentifier.fromString("optimizing_db")),
      );
      await remote.syncFrom(sourceConn);
      const indexesAfter = await t.exec(
        "select indexname from pg_indexes where schemaname = 'public'",
      );
      assertEquals(
        indexesAfter.length,
        1,
        "Indexes were not copied over correctly from the source db",
      );

      assertEquals(indexesAfter[0], { indexname: "testing_1234" });
    } finally {
      await Promise.all([source.stop(), target.stop()]);
    }
  },
});

Deno.test({
  name: "infers '10k' stats strategy when row count is below threshold",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Create source with very few rows (below 5000 threshold)
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create extension pg_stat_statements;
              create table small_table(id int);
              insert into small_table select generate_series(1, 100);
              analyze small_table;
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      testSpawnTarget(),
    ]);

    try {
      const target = Connectable.fromString(targetDb.getConnectionUri());
      const source = Connectable.fromString(sourceDb.getConnectionUri());

      const remote = new Remote(
        target,
        ConnectionManager.forLocalDatabase(),
      );

      const result = await remote.syncFrom(source);
      await remote.optimizer.finish;

      assertEquals(
        result.meta.inferredStatsStrategy,
        "10k",
        "Should infer '10k' strategy for small databases",
      );
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});

Deno.test({
  name: "infers 'fromSource' stats strategy when row count is above threshold",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Create source with many rows (above 5000 threshold)
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create extension pg_stat_statements;
              create table large_table(id int);
              insert into large_table select generate_series(1, 10000);
              analyze large_table;
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      testSpawnTarget(),
    ]);

    try {
      const target = Connectable.fromString(targetDb.getConnectionUri());
      const source = Connectable.fromString(sourceDb.getConnectionUri());

      const remote = new Remote(
        target,
        ConnectionManager.forLocalDatabase(),
      );

      const result = await remote.syncFrom(source);
      await remote.optimizer.finish;

      assertEquals(
        result.meta.inferredStatsStrategy,
        "fromSource",
        "Should infer 'fromSource' strategy for large databases",
      );
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});

Deno.test({
  name: "timescaledb with continuous aggregates sync correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [source, target] = await Promise.all([
      new PostgreSqlContainer(
        "timescale/timescaledb:latest-pg17",
      )
        .withEnvironment({
          POSTGRES_HOST_AUTH_METHOD: "trust",
        })
        .withCommand([
          "-c",
          "shared_preload_libraries=pg_stat_statements,timescaledb",
        ])
        .withLogConsumer((a) => a.pipe(process.stdout))
        .withCopyContentToContainer([
          {
            content: `
              create extension if not exists pg_stat_statements;
              create table conditions(
                "time"      timestamptz not null,
                device_id   integer,
                temperature float
              )
              with(
                timescaledb.hypertable,
                timescaledb.partition_column = 'time'
              );
              create materialized view conditions_summary_daily
              with (timescaledb.continuous) as
              select device_id,
                time_bucket(interval '1 day', time) as bucket,
                avg(temperature),
                max(temperature),
                min(temperature)
              from conditions
              group by device_id, bucket;
              select * from conditions where time < now();
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .start(),
      testSpawnTarget({
        containerName: TEST_TARGET_CONTAINER_TIMESCALEDB_NAME,
      }),
    ]);

    const sourceConn = Connectable.fromString(source.getConnectionUri());
    const targetConn = Connectable.fromString(target.getConnectionUri());
    const manager = ConnectionManager.forLocalDatabase();

    try {
      await using remote = new Remote(targetConn, manager);

      const t = manager.getOrCreateConnection(
        targetConn.withDatabaseName(PgIdentifier.fromString("optimizing_db")),
      );
      await remote.syncFrom(sourceConn);
      const queries = remote.optimizer.getQueries();
      const queryStrings = queries.map((q) => q.query);

      assertArrayIncludes(queryStrings, [
        "select * from conditions where time < now()",
      ]);
      const indexesAfter = await t.exec(
        "select indexname from pg_indexes where schemaname = 'public'",
      );
      assertEquals(
        indexesAfter.length,
        1,
        "Indexes were not copied over correctly from the source db",
      );

      assertEquals(indexesAfter[0], { indexname: "conditions_time_idx" });
    } finally {
      await Promise.all([source.stop(), target.stop()]);
    }
  },
});
