import { expect, test } from "vitest";
import type { ExportedStats } from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "./remote.ts";
import { assertDefined, testSpawnTarget } from "./test-utils.ts";

/**
 * A project publishes its production statistics because its analyzer synced,
 * not because someone went and asked it to.
 *
 * The drift check is what pushes a re-dump, and it cannot run without a
 * baseline. The baseline was set only by a push, so an analyzer that had never
 * pushed never would: no snapshot on the server, nothing to seed from, no
 * baseline, no dump, no snapshot.
 */
test("a sync publishes the statistics it dumped from the source", async () => {
  const [sourceDb, targetDb] = await Promise.all([
    // 200 rows: far under STATS_ROWS_THRESHOLD, which is the case that used to
    // publish nothing at all.
    testSpawnTarget({
      content: `
        create table items(id int primary key, sockets int);
        insert into items select g, g % 6 from generate_series(1, 200) g;
        analyze items;
      `,
    }),
    testSpawnTarget(),
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
    const items = published[0].find((t) => t.tableName === "items");
    assertDefined(items, "expected the published dump to cover items");
    // Production's own number, not the 10M-row assumption the optimizer costs
    // a database this small against. What we publish is what we measured.
    expect(items.reltuples).toBe(200);
  } finally {
    await Promise.all([sourceDb.stop(), targetDb.stop()]);
  }
});
