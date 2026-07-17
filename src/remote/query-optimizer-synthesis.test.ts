import { expect, test } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { dumpSchema, PostgresVersion, Statistics } from "@query-doctor/core";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { QueryOptimizer } from "./query-optimizer.ts";

// When the exported snapshot doesn't cover a table in the current schema — added
// on this branch since the snapshot was captured — setStatistics must pass the
// schema through to core's Statistics so the synthesizer sizes that table,
// instead of it falling to the flat default. This is the analyzer-side wiring;
// the synthesis logic itself is covered in @query-doctor/core.
//
// Requires @query-doctor/core >= 0.13.0 (the currentSchema parameter and the
// syntheticTables getter).
test(
  "setStatistics sizes a table missing from the exported snapshot",
  async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            create table orders (id serial primary key);
            create table refunds (id serial primary key, order_id int references orders(id));
            insert into orders default values;
            insert into refunds (order_id) values (1);
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .start();

    try {
      const manager = ConnectionManager.forLocalDatabase();
      const conn = Connectable.fromString(pg.getConnectionUri());
      const optimizer = new QueryOptimizer(manager, conn);

      const version = PostgresVersion.parse("17");
      const connection = manager.getOrCreateConnection(conn);
      const ownStats = await Statistics.dumpStats(connection, version);

      // refunds is omitted from the snapshot (uncovered); orders is given a
      // production-sized count so synthesis yields a large number rather than
      // the single branch row.
      const snapshot = ownStats
        .filter((t) => t.tableName !== "refunds")
        .map((t) => ({
          ...t,
          reltuples: t.tableName === "orders" ? 1_000_000 : t.reltuples,
        }));
      const schema = await dumpSchema(connection);

      await optimizer.setStatistics(
        Statistics.statsModeFromExport(snapshot),
        schema,
      );

      // refunds is reported as modeled/unverified and sized from the 1M-row
      // snapshot (via its foreign key to orders), not its own one row.
      expect(
        optimizer.syntheticTables.some((t) => t.endsWith(".refunds")),
      ).toBe(true);
      const refunds = optimizer.computedStats?.reltuples.find(
        (r) => r.relname === "refunds",
      );
      expect(refunds?.reltuples).toBeGreaterThan(100_000);
    } finally {
      await pg.stop();
    }
  },
  120_000,
);
