import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { setTimeout } from "node:timers/promises";

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
            select * from testing where a = 1;
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
    optimizer.addListener("improvementsAvailable", (query) => {
      console.log("optimized!", query.query);
    });
    optimizer.addListener("error", (query, error) => {
      console.error("error!", query, error);
    });
    optimizer.addListener("zeroCostPlan", (query) => {
      console.log("zero cost plan!", query.query);
    });
    const conn = Connectable.fromString(pg.getConnectionUri());
    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(conn, recentQueries);
      await setTimeout(10_000);
    } finally {
      await pg.stop();
    }
  },
});
