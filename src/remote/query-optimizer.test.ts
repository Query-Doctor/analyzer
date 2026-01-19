import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import { setTimeout } from "node:timers/promises";
import { assertArrayIncludes } from "@std/assert/array-includes";
import { assert, assertGreater } from "@std/assert";
import { RecentQuery, type OptimizedQuery } from "../sql/recent-query.ts";

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

Deno.test({
  name: "hypertable optimization includes index recommendations",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pg = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
      .withCopyContentToContainer([
        {
          content: `
            CREATE EXTENSION IF NOT EXISTS timescaledb;
            CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

            CREATE TABLE air_quality_sensors (
              id SERIAL PRIMARY KEY,
              name TEXT NOT NULL,
              location_type TEXT NOT NULL
            );

            CREATE TABLE air_quality_readings (
              time TIMESTAMPTZ NOT NULL,
              sensor_id INT NOT NULL REFERENCES air_quality_sensors(id),
              aqi INT NOT NULL,
              pm25_ugm3 NUMERIC,
              pm10_ugm3 NUMERIC
            );

            SELECT create_hypertable('air_quality_readings', 'time');

            INSERT INTO air_quality_sensors (name, location_type) VALUES ('sensor1', 'outdoor');

            -- Insert enough data to make the optimizer recommend indexes
            INSERT INTO air_quality_readings (time, sensor_id, aqi, pm25_ugm3, pm10_ugm3)
            SELECT
              NOW() - (i || ' minutes')::interval,
              1,
              50 + (i % 100),
              10.0 + (i % 50),
              20.0 + (i % 50)
            FROM generate_series(1, 1000) AS i;

            -- Run the query we want to optimize (simple conditions to avoid parameterized interval issues)
            SELECT aqs.name AS sensor_name, aqs.location_type, aqr.time, aqr.aqi, aqr.pm25_ugm3, aqr.pm10_ugm3
            FROM air_quality_readings aqr
            JOIN air_quality_sensors aqs ON aqs.id = aqr.sensor_id
            WHERE aqr.aqi > 100
            ORDER BY aqr.aqi DESC
            LIMIT 20;
          `,
          target: "/docker-entrypoint-initdb.d/init.sql",
        },
      ])
      .withCommand([
        "-c",
        "shared_preload_libraries=timescaledb,pg_stat_statements",
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

    const improvementsWithRecommendations: OptimizedQuery[] = [];

    optimizer.addListener("error", (error, query) => {
      console.error("error when running query", query.query, error);
    });
    optimizer.addListener("improvementsAvailable", (query) => {
      improvementsWithRecommendations.push(query);
    });

    const conn = Connectable.fromString(pg.getConnectionUri());
    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();

      await optimizer.start(conn, recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [
          {
            tableName: "air_quality_readings",
            schemaName: "public",
            relpages: 100,
            reltuples: 100_000,
            relallvisible: 1,
            columns: [
              { columnName: "time", stats: null },
              { columnName: "sensor_id", stats: null },
              { columnName: "aqi", stats: null },
              { columnName: "pm25_ugm3", stats: null },
              { columnName: "pm10_ugm3", stats: null },
            ],
            indexes: [],
          },
          {
            tableName: "air_quality_sensors",
            schemaName: "public",
            relpages: 1,
            reltuples: 100,
            relallvisible: 1,
            columns: [
              { columnName: "id", stats: null },
              { columnName: "name", stats: null },
              { columnName: "location_type", stats: null },
            ],
            indexes: [],
          },
        ],
      });

      // The bug: when improvements_available, indexRecommendations should not be empty
      for (const q of improvementsWithRecommendations) {
        if (q.optimization.state === "improvements_available") {
          assertGreater(
            q.optimization.indexRecommendations.length,
            0,
            `Query "${q.query}" has ${q.optimization.costReductionPercentage}% cost reduction but no index recommendations`,
          );
        }
      }
    } finally {
      await pg.stop();
    }
  },
});
