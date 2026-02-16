import { test, expect, vi } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Connectable } from "../sync/connectable.ts";
import { Remote } from "./remote.ts";
import { Pool } from "pg";

import { RemoteController } from "./remote-controller.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { RemoteSyncRequest } from "./remote.dto.ts";

test("controller syncs correctly", async () => {
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

    const target = Connectable.fromString(targetDb.getConnectionUri());
    const source = Connectable.fromString(sourceDb.getConnectionUri());
    const sourceOptimizer = ConnectionManager.forLocalDatabase();

    const innerRemote = new Remote(target, sourceOptimizer);
    const remote = new RemoteController(innerRemote);

    try {
      const syncResult = await remote.onFullSync(
        RemoteSyncRequest.encode({ db: source }),
      );

      expect(syncResult.status).toEqual(200);

      const pool = new Pool({
        connectionString: target.withDatabaseName(Remote.optimizingDbName).toString(),
      });
      const tablesAfter =
        await pool.query("select tablename from pg_tables where schemaname = 'public'");
      expect(tablesAfter.rowCount).toEqual(1);
      const indexesAfter =
        await pool.query("select * from pg_indexes where schemaname = 'public'");
      expect(indexesAfter.rowCount).toEqual(1);
      expect(tablesAfter.rows[0]).toEqual({ tablename: "testing" });
      const rows = await pool.query("select * from testing");
      expect(rows.rowCount).toEqual(0);

      await pool.end();
      await innerRemote.cleanup();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("creating an index via endpoint adds it to the optimizing db", async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create table testing(a int, b text);
              insert into testing values (1, 'hello');
              create extension pg_stat_statements;
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
        .start(),
      new PostgreSqlContainer("postgres:17").start(),
    ]);

    const target = Connectable.fromString(targetDb.getConnectionUri());
    const source = Connectable.fromString(sourceDb.getConnectionUri());
    const sourceOptimizer = ConnectionManager.forLocalDatabase();

    const innerRemote = new Remote(target, sourceOptimizer);
    const remote = new RemoteController(innerRemote);

    try {
      // First sync the database
      const syncResult = await remote.onFullSync(
        RemoteSyncRequest.encode({ db: source }),
      );
      expect(syncResult.status).toEqual(200);

      const pool = new Pool({
        connectionString: target.withDatabaseName(Remote.optimizingDbName).toString(),
      });

      // Verify no indexes exist initially
      const indexesBefore =
        await pool.query("select * from pg_indexes where schemaname = 'public'");
      expect(indexesBefore.rowCount).toEqual(0);

      // Create an index via the controller method
      const createResult = await remote.createIndex({
        connectionString: sourceDb.getConnectionUri(),
        table: "testing",
        columns: [{ name: "a", order: "asc" }],
      });

      expect(createResult.status).toEqual(200);
      // as any: HandlerResult.body is unknown — will be typed (Site#2402)
      expect((createResult.body as any).success).toEqual(true);

      // Verify the index was created on the optimizing db
      const indexesAfter =
        await pool.query("select * from pg_indexes where schemaname = 'public'");
      expect(indexesAfter.rowCount).toEqual(1);
      expect(indexesAfter.rows[0].tablename).toEqual("testing");

      await pool.end();
      await innerRemote.cleanup();
    } finally {
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});

test("controller returns extension error when pg_stat_statements is not installed", async () => {
    const [sourceDb, targetDb] = await Promise.all([
      new PostgreSqlContainer("postgres:17")
        .withCopyContentToContainer([
          {
            content: `
              create table testing(a int, b text);
              insert into testing values (1);
              create index on testing(b);
            `,
            target: "/docker-entrypoint-initdb.d/init.sql",
          },
        ])
        .start(),
      new PostgreSqlContainer("postgres:17").start(),
    ]);

    const target = Connectable.fromString(targetDb.getConnectionUri());
    const source = Connectable.fromString(sourceDb.getConnectionUri());
    const sourceOptimizer = ConnectionManager.forLocalDatabase();

    const innerRemote = new Remote(target, sourceOptimizer);
    const remote = new RemoteController(innerRemote);

    try {
      const syncResult = await remote.onFullSync(
        RemoteSyncRequest.encode({ db: source }),
      );

      expect(syncResult.status).toEqual(200);

      // as any: HandlerResult.body is unknown — will be typed (Site#2402)
      const body = syncResult.body as any;
      // Schema should still sync successfully
      expect(body.schema.type).toEqual("ok");

      // Queries should return the extension_not_installed error
      expect(body.queries.type).toEqual("error");
      expect(body.queries.error).toEqual("extension_not_installed");
    } finally {
      await innerRemote.cleanup();
      await Promise.all([sourceDb.stop(), targetDb.stop()]);
    }
});
