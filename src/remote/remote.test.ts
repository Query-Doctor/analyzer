import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import postgres from "postgresjs";
import { assertEquals } from "@std/assert/equals";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { assertArrayIncludes } from "@std/assert";

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
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: "create table testing(a int); create index on testing(a)",
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ]).start(),
    ]);

    try {
      const target = Connectable.fromString(targetDb.getConnectionUri());
      const source = Connectable.fromString(sourceDb.getConnectionUri());

      const remote = new Remote(
        target,
        ConnectionManager.forLocalDatabase(),
      );

      const result = await remote.syncFrom(source);
      assertOk(result.queries);

      const queries = result.queries.value.map((f) => f.query);
      assertArrayIncludes(queries, [
        "create table testing(a int, b text)",
        "select * from testing where a = $1",
      ]);

      assertOk(result.schema);

      const tableNames = result.schema.value.tables.map((table) =>
        table.tableName
      );

      assertArrayIncludes(tableNames, ["testing"]);

      const indexNames = result.schema.value.indexes.map((index) =>
        index.indexName
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
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});
