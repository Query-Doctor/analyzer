import { expect, test } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { ExportedStats } from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "./remote.ts";

/**
 * A project publishes its production statistics because its analyzer synced,
 * not because someone went and asked it to.
 *
 * The drift check is what pushes a re-dump, and it cannot run without a
 * baseline. The baseline was set only by a push, so an analyzer that had never
 * pushed never would: no snapshot on the server, nothing to seed from, no
 * baseline, no dump, no snapshot. The sync already holds the dump — it just has
 * to say so.
 */
test("a sync publishes the statistics it dumped from the source", async () => {
  const [sourceDb, targetDb] = await Promise.all([
    new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          // 200 rows: far under STATS_ROWS_THRESHOLD, which is the case that
          // used to publish nothing at all.
          content: `
            create table items(id int primary key, sockets int);
            insert into items select g, g % 6 from generate_series(1, 200) g;
            analyze items;
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .start(),
    new PostgreSqlContainer("postgres:17").start(),
  ]);

  try {
    await using remote = new Remote(
      Connectable.fromString(targetDb.getConnectionUri()),
      ConnectionManager.forLocalDatabase(),
    );
    const published: ExportedStats[][] = [];
    remote.on("statsApplied", (stats) => published.push(stats));

    await remote.syncFrom(Connectable.fromString(sourceDb.getConnectionUri()));

    expect(published).toHaveLength(1);
    const items = published[0].find(
      (t) => String(t.tableName) === "items",
    );
    // Production's own number, not the 10M-row assumption the optimizer costs
    // a database this small against. What we publish is what we measured.
    expect(items?.reltuples).toBe(200);
  } finally {
    await Promise.all([sourceDb.stop(), targetDb.stop()]);
  }
});
