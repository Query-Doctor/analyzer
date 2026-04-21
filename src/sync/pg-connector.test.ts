import { test, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { ConnectionManager } from "./connection-manager.ts";
import { Connectable } from "./connectable.ts";
import { PgIdentifier } from "@query-doctor/core";

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

test("getTotalRowCount sums reltuples across all tables in a single schema", async () => {
  const pg = await new PostgreSqlContainer("postgres:17")
    .withCopyContentToContainer([
      {
        content: `
          CREATE TABLE small_audit(id int);
          INSERT INTO small_audit SELECT generate_series(1, 77);

          CREATE TABLE big_users(id int);
          INSERT INTO big_users SELECT generate_series(1, 300000);

          ANALYZE small_audit;
          ANALYZE big_users;
        `,
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ])
    .start();

  const manager = ConnectionManager.forLocalDatabase();
  const conn = Connectable.fromString(pg.getConnectionUri());
  const connector = manager.getConnectorFor(conn);

  try {
    const tables = [
      { schemaName: PgIdentifier.fromString("public"), tableName: PgIdentifier.fromString("small_audit") },
      { schemaName: PgIdentifier.fromString("public"), tableName: PgIdentifier.fromString("big_users") },
    ];

    const total = await connector.getTotalRowCount(tables);

    expect(total).toBeGreaterThanOrEqual(300_000);
  } finally {
    await manager.closeAll();
    await pg.stop();
  }
});

// When requested tables span multiple schemas with uneven counts per schema,
// the pre-fix dedup would shrink schemaNames below tableNames, pairing
// (schema[i], table[i]) by position and NULL-padding the tail — dropping
// tables past the shorter array.
test("getTotalRowCount sums reltuples with uneven table counts across schemas", async () => {
  const pg = await new PostgreSqlContainer("postgres:17")
    .withCopyContentToContainer([
      {
        content: `
          CREATE SCHEMA reporting;

          CREATE TABLE public.a(id int);
          INSERT INTO public.a SELECT generate_series(1, 1000);

          CREATE TABLE public.b(id int);
          INSERT INTO public.b SELECT generate_series(1, 2000);

          CREATE TABLE reporting.c(id int);
          INSERT INTO reporting.c SELECT generate_series(1, 4000);

          ANALYZE public.a;
          ANALYZE public.b;
          ANALYZE reporting.c;
        `,
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ])
    .start();

  const manager = ConnectionManager.forLocalDatabase();
  const conn = Connectable.fromString(pg.getConnectionUri());
  const connector = manager.getConnectorFor(conn);

  try {
    const tables = [
      { schemaName: PgIdentifier.fromString("public"), tableName: PgIdentifier.fromString("a") },
      { schemaName: PgIdentifier.fromString("public"), tableName: PgIdentifier.fromString("b") },
      { schemaName: PgIdentifier.fromString("reporting"), tableName: PgIdentifier.fromString("c") },
    ];

    const total = await connector.getTotalRowCount(tables);

    // All three must contribute: sum of any pair is at most 6000 (b+c),
    // so > 6000 proves no table was dropped.
    expect(total).toBeGreaterThan(6000);
  } finally {
    await manager.closeAll();
    await pg.stop();
  }
});

test("getTotalRowCount does not count tables outside the requested set", async () => {
  const pg = await new PostgreSqlContainer("postgres:17")
    .withCopyContentToContainer([
      {
        content: `
          CREATE TABLE wanted(id int);
          INSERT INTO wanted SELECT generate_series(1, 1000);

          CREATE TABLE unwanted(id int);
          INSERT INTO unwanted SELECT generate_series(1, 500000);

          ANALYZE wanted;
          ANALYZE unwanted;
        `,
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ])
    .start();

  const manager = ConnectionManager.forLocalDatabase();
  const conn = Connectable.fromString(pg.getConnectionUri());
  const connector = manager.getConnectorFor(conn);

  try {
    const tables = [
      { schemaName: PgIdentifier.fromString("public"), tableName: PgIdentifier.fromString("wanted") },
    ];

    const total = await connector.getTotalRowCount(tables);

    expect(total).toBeGreaterThanOrEqual(1000);
    expect(total).toBeLessThan(500_000);
  } finally {
    await manager.closeAll();
    await pg.stop();
  }
});

