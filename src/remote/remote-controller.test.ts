import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import postgres from "postgresjs";
import { assertEquals } from "@std/assert/equals";
import { RemoteController } from "./remote-controller.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { setTimeout } from "node:timers/promises";
import { assertGreaterOrEqual } from "@std/assert";

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
    const controller = new AbortController();

    const target = Connectable.fromString(
      targetDb.getConnectionUri(),
    );
    const source = Connectable.fromString(
      sourceDb.getConnectionUri(),
    );

    const sourceOptimizer = ConnectionManager.forLocalDatabase();

    const remote = new RemoteController(
      new Remote(target, sourceOptimizer),
    );

    const server = Deno.serve(
      { port: 0, signal: controller.signal },
      async (req: Request): Promise<Response> => {
        const result = await remote.execute(req);
        if (!result) {
          throw new Error();
        }
        return result;
      },
    );
    try {
      const ws = new WebSocket(`ws://localhost:${server.addr.port}/postgres`);
      const messageFunction = spy();
      ws.addEventListener("error", console.error);
      ws.addEventListener("message", messageFunction);

      const response = await fetch(
        new Request(
          `http://localhost:${server.addr.port}/postgres`,
          {
            method: "POST",
            body: RemoteSyncRequest.encode({
              db: source,
            }),
          },
        ),
      );

      assertEquals(response?.status, 200);
      await setTimeout(1000);

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
      assertEquals(rows.length, 0);

      assertGreaterOrEqual(messageFunction.calls.length, 1);
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop(), server.shutdown()]);
    }
  },
});
