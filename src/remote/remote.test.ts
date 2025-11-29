import z from "zod";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import postgres from "postgresjs";
import { assertEquals } from "@std/assert/equals";
import { wrapGenericPostgresInterface } from "../sql/postgresjs.ts";

const connectable = z.string().transform(Connectable.transform);
Deno.test({
  name: "syncs correctly",
  sanitizeOps: false,
  fn: async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content:
              "create table testing(a int); insert into testing values (1);",
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ]).start(),
      new PostgreSqlContainer("postgres:17")
        .start(),
    ]);

    try {
      const target = connectable.parse(
        targetDb.getConnectionUri(),
      );
      const source = connectable.parse(
        sourceDb.getConnectionUri(),
      );
      const sql = postgres(target.toString());
      const tablesBefore =
        await sql`select tablename from pg_tables where schemaname = 'public'`;
      assertEquals(tablesBefore.count, 0);

      const remote = new Remote(target, wrapGenericPostgresInterface);
      await remote.syncFrom(source);

      const tablesAfter =
        await sql`select tablename from pg_tables where schemaname = 'public'`;
      assertEquals(tablesAfter.count, 1);
      assertEquals(tablesAfter[0], { tablename: "testing" });
      const rows = await sql`select * from testing`;
      // expect no rows to have been synced
      assertEquals(rows.length, 0);
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});
