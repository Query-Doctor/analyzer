import { test, expect, vi, afterEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import { Pool } from "pg";

import { ConnectionManager } from "../sync/connection-manager.ts";

import { PgIdentifier } from "@query-doctor/core";
import { type Op } from "jsondiffpatch/formatters/jsonpatch";

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
  expect(result.type).toEqual("ok");
}

test("syncs correctly", async () => {
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
      expect(queries).toEqual(expect.arrayContaining([
        "create table testing(a int, b text);",
        "select * from testing where a = $1;",
      ]));

      assertOk(result.schema);

      const tableNames = result.schema.value.tables.map((table) =>
        table.tableName.toString()
      );
      console.log("tablenames", tableNames);

      expect(tableNames).toEqual(expect.arrayContaining(["testing"]));

      const indexNames = result.schema.value.indexes.map((index) =>
        index.indexName.toString()
      );
      expect(indexNames).toEqual(expect.arrayContaining(["testing_1234"]));

      const pool = new Pool({
        connectionString: target.withDatabaseName(Remote.optimizingDbName).toString(),
      });

      const indexesAfter =
        await pool.query("select indexname from pg_indexes where schemaname = 'public'");
      expect(indexesAfter.rowCount).toEqual(1);

      expect(indexesAfter.rows[0]).toEqual({ indexname: "testing_1234" });

      const tablesAfter =
        await pool.query("select tablename from pg_tables where schemaname = 'public'");
      expect(tablesAfter.rowCount).toEqual(1);
      expect(tablesAfter.rows[0]).toEqual({ tablename: "testing" });
      const rows = await pool.query("select * from testing");
      // expect no rows to have been synced
      expect(rows.rowCount, "Table in target db not empty").toEqual(0);

      await pool.end();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

// Users who upgraded from Postgres 13/14 may have a leftover bit_xor aggregate.
// It became built-in in Postgres 15, but custom versions from older installs remain.
// This test ensures sync handles this gracefully.
test("syncs database with custom bit_xor aggregate", async () => {
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
      expect(tableNames).toEqual(expect.arrayContaining(["testing"]));

      const indexNames = result.schema.value.indexes.map((index) =>
        index.indexName.toString()
      );
      expect(indexNames).toEqual(expect.arrayContaining(["testing_idx"]));
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("raw timescaledb syncs correctly", async () => {
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
      expect(indexesAfter.length).toEqual(1);

      expect(indexesAfter[0]).toEqual({ indexname: "testing_1234" });
    } finally {
      await Promise.all([source.stop(), target.stop()]);
    }
});

test("infers '10k' stats strategy when row count is below threshold", async () => {
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

      expect(result.meta.inferredStatsStrategy).toEqual("10k");
      await remote.cleanup();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("infers 'fromSource' stats strategy when row count is above threshold", async () => {
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

      expect(result.meta.inferredStatsStrategy).toEqual("fromSource");
      await remote.cleanup();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("timescaledb with continuous aggregates sync correctly", async () => {
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

      expect(queryStrings).toEqual(expect.arrayContaining([
        "select * from conditions where time < now();",
      ]));
      const indexesAfter = await t.exec(
        "select indexname from pg_indexes where schemaname = 'public';",
      );
      expect(indexesAfter.length).toEqual(1);

      expect(indexesAfter[0]).toEqual({ indexname: "conditions_time_idx" });
    } finally {
      await Promise.all([source.stop(), target.stop()]);
    }
});

test("schema loader detects changes after database modification", async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create extension pg_stat_statements;
              create table testing(a int, b text);
              insert into testing values (1, 'test');
              create index "testing_b_idx" on testing(b);
              select * from testing where a = 1;
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

      const manager = ConnectionManager.forLocalDatabase();
      await using remote = new Remote(target, manager);

      const sourcePg = new Pool({ connectionString: source.toString() });

      await remote.syncFrom(source);
      await remote.optimizer.finish;

      const initialStatus = await remote.getStatus();
      const initialDiffsResult = initialStatus.diffs;
      expect(initialDiffsResult.status, "Schema poll should succeed").toEqual("fulfilled");
      const initialDiffs = initialDiffsResult.status === "fulfilled"
        ? initialDiffsResult.value
        : [];
      expect(initialDiffs.length, "Should have no diffs initially after sync").toEqual(0);

      await sourcePg.query(`
        alter table testing add column c int;
        create index "testing_c_idx" on testing(c);
      `);

      const statusAfterChange = await remote.getStatus();
      const diffsResult = statusAfterChange.diffs;

      expect(diffsResult.status, "Schema poll should succeed").toEqual("fulfilled");
      const diffs = diffsResult.status === "fulfilled" ? diffsResult.value : [];

      expect(diffs.length, "Should detect 2 schema changes (added column and index)").toEqual(2);

      const addedColumnDiff = diffs.find((diff: Op) =>
        typeof diff.path === "string" && diff.path.includes("columns")
      );
      expect(addedColumnDiff?.op, "Should detect column addition").toEqual("add");

      const addedIndexDiff = diffs.find((diff: Op) =>
        typeof diff.path === "string" && diff.path.includes("indexes")
      );
      expect(addedIndexDiff?.op, "Should detect index addition").toEqual("add");

      await sourcePg.end();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("returns extension error when pg_stat_statements is not installed", async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create table testing(a int, b text);
              insert into testing values (1);
              create index "testing_idx" on testing(b);
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
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

      try {
        const result = await remote.syncFrom(source);

        // Schema should still sync successfully
        assertOk(result.schema);

        const tableNames = result.schema.value.tables.map((table) =>
          table.tableName.toString()
        );
        expect(tableNames).toContain("testing");

        // Should return the extension error for recent queries
        expect(result.recentQueriesError).toEqual({
          type: "extension_not_installed",
          extensionName: "pg_stat_statements",
        });
      } finally {
        await remote.cleanup();
      }
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});
