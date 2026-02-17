import { test, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { ConnectionManager } from "./connection-manager.ts";
import { Connectable } from "./connectable.ts";

test("getRecentQueries resolves pg_stat_statements in a non-default schema", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE SCHEMA monitoring;
            CREATE EXTENSION pg_stat_statements SCHEMA monitoring;

            CREATE TABLE users(id int, name text);
            INSERT INTO users (id, name) VALUES (1, 'alice');
            SELECT * FROM users WHERE id = 1;
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .withCommand([
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
      ])
      .start();

    const manager = ConnectionManager.forLocalDatabase();
    const conn = Connectable.fromString(pg.getConnectionUri());
    const connector = manager.getConnectorFor(conn);

    try {
      const recentQueries = await connector.getRecentQueries();
      const userQuery = recentQueries.find((q) =>
        q.query.includes("users")
      );
      expect(userQuery, "Expected to find a query involving 'users' table").toBeTruthy();
    } finally {
      await manager.closeAll();
      await pg.stop();
    }
});

test("resetPgStatStatements works with a non-default schema", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE SCHEMA monitoring;
            CREATE EXTENSION pg_stat_statements SCHEMA monitoring;

            CREATE TABLE users(id int, name text);
            INSERT INTO users (id, name) VALUES (1, 'alice');
            SELECT * FROM users WHERE id = 1;
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .withCommand([
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
      ])
      .start();

    const manager = ConnectionManager.forLocalDatabase();
    const conn = Connectable.fromString(pg.getConnectionUri());
    const connector = manager.getConnectorFor(conn);

    try {
      const before = await connector.getRecentQueries();
      expect(before.length, "Expected queries before reset").toBeGreaterThan(0);

      await connector.resetPgStatStatements();

      const after = await connector.getRecentQueries();
      expect(after.length, "Expected 0 queries after reset").toEqual(0);
    } finally {
      await manager.closeAll();
      await pg.stop();
    }
});
