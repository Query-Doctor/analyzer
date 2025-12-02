import z from "zod";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import postgres from "postgresjs";
import { assertEquals } from "@std/assert/equals";
import { wrapGenericPostgresInterface } from "../sql/postgresjs.ts";
import { RemoteController } from "./remote-controller.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";

const connectable = z.string().transform(Connectable.transform);
Deno.test({
  name: "controller syncs correctly",
  sanitizeOps: false,
  // deno is weird... the sync seems like it might be leaking resources?
  sanitizeResources: false,
  fn: async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create table testing(a int, b text);
              insert into testing values (1);
              create index on testing(b);
              create extension pg_stat_statements;
              select * from testing where a = 1;
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      new PostgreSqlContainer("postgres:17").start(),
    ]);

    try {
      const target = connectable.parse(
        targetDb.getConnectionUri(),
      );
      const source = connectable.parse(
        sourceDb.getConnectionUri(),
      );

      const man = new ConnectionManager(wrapGenericPostgresInterface);
      const remote = new RemoteController(
        new Remote(target, man),
      );

      const response = await remote.execute(
        new Request(
          "http://testing.local/postgres",
          {
            method: "POST",
            body: JSON.stringify({
              db: source.toString(),
            }),
          },
        ),
      );

      assertEquals(response?.status, 200);

      const sql = postgres(
        target.withDatabaseName(Remote.optimizingDbName).toString(),
      );
      const tablesAfter =
        await sql`select tablename from pg_tables where schemaname = 'public'`;
      assertEquals(tablesAfter.count, 1);
      const indexesAfter =
        await sql`select * from pg_indexes where schemaname = 'public'`;
      assertEquals(indexesAfter.count, 1);
      assertEquals(tablesAfter[0], { tablename: "testing" });
      const rows = await sql`select * from testing`;
      // expect no rows to have been synced
      assertEquals(rows.length, 0);
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
  },
});
