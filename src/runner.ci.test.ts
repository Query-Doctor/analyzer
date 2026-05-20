import { test, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { testSpawnTarget } from "./remote/remote.test.ts";
import { Connectable } from "./sync/connectable.ts";
import { ConnectionManager } from "./sync/connection-manager.ts";
import { Remote } from "./remote/remote.ts";
import { Runner } from "./runner.ts";
import { DEFAULT_CONFIG } from "./config.ts";

test("CI mode runs end-to-end against a source db with pg_stat_statements", async () => {
  const [sourceDb, targetDb] = await Promise.all([
    new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            create extension pg_stat_statements;
            create table testing(a int, b text);
            insert into testing (a, b) values (1, 'hello');
            create index testing_b_idx on testing(b);
            select * from testing where a = 10;
            select * from testing where b = 'c';
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .withCommand(["-c", "shared_preload_libraries=pg_stat_statements"])
      .start(),
    testSpawnTarget(),
  ]);

  try {
    const sourcePostgresUrl = Connectable.fromString(sourceDb.getConnectionUri());
    const targetPostgresUrl = Connectable.fromString(targetDb.getConnectionUri());

    const remote = new Remote(
      targetPostgresUrl,
      ConnectionManager.forLocalDatabase(),
      ConnectionManager.forRemoteDatabase(),
      { disableQueryLoader: true },
    );

    const sourceManager = ConnectionManager.forRemoteDatabase();
    const source = sourceManager.getConnectorFor(sourcePostgresUrl);

    const runner = await Runner.build({
      targetPostgresUrl,
      sourcePostgresUrl,
      source,
      remote,
    });

    try {
      const { reportContext, allResults } = await runner.run(DEFAULT_CONFIG);

      expect(reportContext.queryStats.matched).toBeGreaterThan(0);
      expect(allResults.some((q) => q.query.toLowerCase().includes("testing")))
        .toBe(true);
      expect(reportContext.metadata.logSize).toBe(-1);
      expect(reportContext.error).toBeUndefined();
    } finally {
      await runner.close();
      await sourceManager.closeAll();
    }
  } finally {
    await Promise.all([sourceDb.stop(), targetDb.stop()]);
  }
});
