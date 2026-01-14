import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { setTimeout } from "node:timers/promises";
import { assertArrayIncludes } from "@std/assert/array-includes";
import { assert } from "@std/assert";
import { RecentQuery } from "../sql/recent-query.ts";

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
            insert into testing (a, b) values (1, 'hello');
            create index "testing_index" on testing(b);

            -- normally should be in another db but
            -- this makes testing much faster
            create extension pg_stat_statements;
            select * from testing where a = 10;
            select * from testing where b = 'c';
            select * from testing where b > 'a';
            select * from testing where b < 'b';
            select * from pg_index where 1 = 1;
            select * from pg_class where relname > 'example' /* @qd_introspection */;
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
    const optimizer = new QueryOptimizer(manager);

    const expectedImprovements = ["select * from testing where a = $1"];
    const expectedNoImprovements = [
      "select * from testing where b = $1",
      "select * from testing where b > $1",
      "select * from testing where b < $1",
    ];

    let improvements: string[] = [];
    let noImprovements: string[] = [];

    optimizer.addListener("error", (query, error) => {
      console.error("error when running query", query);
      throw error;
    });
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
      const includedQueries = await optimizer.start(conn, recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "testing",
          schemaName: "public",
          relpages: 56,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [{
            columnName: "a",
            stats: null,
          }, {
            columnName: "b",
            stats: null,
          }],
          indexes: [{
            indexName: "testing_index",
            relpages: 2,
            reltuples: 10000,
            relallvisible: 1,
          }],
        }],
      });
      // should ignore the query with
      assert(
        includedQueries.every((q) =>
          !q.query.startsWith("select * from pg_class where relname > $1")
        ),
        "Optimizer did not ignore a query with @qd_introspection",
      );
      assert(
        includedQueries.every((q) =>
          !q.query.startsWith("select * from pg_index where $1 = $2")
        ),
        "Optimizer did not ignore a system query",
      );
      await setTimeout(1_000);
      assertArrayIncludes(expectedImprovements, improvements);
      assertArrayIncludes(expectedNoImprovements, noImprovements);
      improvements = [];
      noImprovements = [];
      await optimizer.addQueries([
        new RecentQuery(
          {
            calls: "0",
            formattedQuery: "select * from testing where a >= $1",
            meanTime: 100,
            query: "select * from testing where a >= $1",
            rows: "1",
            topLevel: true,
            username: "test",
          },
          [{ table: "testing" }],
          [{
            parts: [{ text: "a", quoted: false }],
            frequency: 1,
            ignored: false,
            position: { start: 1, end: 2 },
            representation: "a",
          }],
          [],
          [],
          0 as any,
          1,
        ),
      ]);
      assertArrayIncludes(
        [...expectedImprovements, "select * from testing where a >= $1"],
        improvements,
      );
      assertArrayIncludes(expectedNoImprovements, noImprovements);
      console.log("improvements 1", improvements);
      console.log("no improvements 1", noImprovements);
      await optimizer.start(conn, recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "testing",
          schemaName: "public",
          relpages: 1,
          reltuples: 100000,
          relallvisible: 1,
          columns: [{
            columnName: "a",
            stats: null,
          }, {
            columnName: "b",
            stats: null,
          }],
          indexes: [{
            indexName: "testing_index",
            relpages: 2,
            reltuples: 10000,
            relallvisible: 1,
          }],
        }],
      });
      await setTimeout(2_000);
      console.log("improvements", improvements);
      console.log("no improvements", noImprovements);
    } finally {
      await pg.stop();
    }
  },
});
