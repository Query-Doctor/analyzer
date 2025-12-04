import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { setTimeout } from "node:timers/promises";
import { assertStrictEquals } from "@std/assert";
import { assertEquals } from "@std/assert/equals";
import { assertArrayIncludes } from "@std/assert/array-includes";

Deno.test({
  name: "controller syncs correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            create table testing(a int, b text);
            insert into testing values (1);
            create index on testing(b);
            create extension pg_stat_statements;
            select * from testing where a = 10;
            select * from testing where b = 'c';
            select * from testing where b > 'a';
            select * from testing where b < 'b';
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .withCommand([
        "-c",
        "shared_preload_libraries=pg_stat_statements",
        "-c",
        "log_statement=all",
      ])
      .start();

    const manager = ConnectionManager.forLocalDatabase();
    const optimizer = new QueryOptimizer(manager);

    const expectedImprovements = ["select * from testing where a = $1"];
    const expectedNoImprovements = [
      "select * from testing where b = $1",
      "select * from testing where b > $1",
      "select * from testing where b < $1",
    ];

    const improvements: string[] = [];
    const noImprovements: string[] = [];

    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query.query);
    });
    optimizer.addListener("noImprovements", (query) => {
      noImprovements.push(query.query);
    });

    const conn = Connectable.fromString(pg.getConnectionUri());
    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(conn, recentQueries);
      await setTimeout(1_000);
      assertArrayIncludes(expectedImprovements, improvements);
      assertArrayIncludes(expectedNoImprovements, noImprovements);
    } finally {
      await pg.stop();
    }
  },
});
