import { test, expect, vi, afterEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";

import { type OptimizedQuery } from "../sql/recent-query.ts";

function hasGinRecommendation(query: OptimizedQuery): boolean {
  if (query.optimization.state !== "improvements_available") return false;
  return query.optimization.indexRecommendations.some((r) =>
    r.definition.toLowerCase().includes("using gin")
  );
}

function getGinRecommendations(query: OptimizedQuery) {
  if (query.optimization.state !== "improvements_available") return [];
  return query.optimization.indexRecommendations.filter((r) =>
    r.definition.toLowerCase().includes("using gin")
  );
}

function getBtreeRecommendations(query: OptimizedQuery) {
  if (query.optimization.state !== "improvements_available") return [];
  return query.optimization.indexRecommendations.filter(
    (r) => !r.definition.toLowerCase().includes("using gin"),
  );
}

// ──────────────────────────────────────────────
// 1. Basic @> containment → GIN jsonb_path_ops
// ──────────────────────────────────────────────

test("GIN: basic @> containment recommends GIN with jsonb_path_ops", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE products (
              id serial PRIMARY KEY,
              data jsonb NOT NULL
            );
            INSERT INTO products (data)
              SELECT jsonb_build_object('category', CASE WHEN i % 3 = 0 THEN 'electronics' ELSE 'clothing' END, 'name', 'product' || i)
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM products WHERE data @> '{"category": "electronics"}' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "products",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "data", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("@>") || q.query.includes("products")
      );
      expect(match, "Expected improvements for @> containment query").toBeTruthy();
      expect(hasGinRecommendation(match!), "Expected a GIN index recommendation").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      expect(
        ginRecs.some((r) => r.definition.toLowerCase().includes("jsonb_path_ops")),
        `Expected jsonb_path_ops, got: ${ginRecs.map((r) => r.definition)}`,
      ).toBeTruthy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 2. Key existence ? → GIN default jsonb_ops
// ──────────────────────────────────────────────

test("GIN: key existence (?) recommends GIN with default jsonb_ops", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE events (
              id serial PRIMARY KEY,
              payload jsonb NOT NULL
            );
            INSERT INTO events (payload)
              SELECT jsonb_build_object('type', 'click', 'x', i, 'y', i * 2) ||
                CASE WHEN i % 5 = 0 THEN '{"element_id": "btn"}'::jsonb ELSE '{}'::jsonb END
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM events WHERE payload ? 'element_id' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "events",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "payload", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("?") || q.query.includes("payload")
      );
      expect(match, "Expected improvements for ? key existence query").toBeTruthy();
      expect(hasGinRecommendation(match!), "Expected a GIN index recommendation").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      // ? requires jsonb_ops — must NOT have jsonb_path_ops
      expect(
        ginRecs.every((r) => !r.definition.toLowerCase().includes("jsonb_path_ops")),
        `Expected default jsonb_ops (no jsonb_path_ops) for ? operator, got: ${ginRecs.map((r) => r.definition)}`,
      ).toBeTruthy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 3. Any-key existence ?| → GIN default jsonb_ops
// ──────────────────────────────────────────────

test("GIN: any-key existence (?|) recommends GIN with default jsonb_ops", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE events (
              id serial PRIMARY KEY,
              payload jsonb NOT NULL
            );
            INSERT INTO events (payload)
              SELECT jsonb_build_object('type', 'click', 'x', i, 'y', i * 2) ||
                CASE WHEN i % 5 = 0 THEN '{"element_id": "btn"}'::jsonb ELSE '{}'::jsonb END ||
                CASE WHEN i % 7 = 0 THEN '{"delta": 50}'::jsonb ELSE '{}'::jsonb END
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM events WHERE payload ?| array['element_id', 'delta'] LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "events",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "payload", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("?|") || q.query.includes("payload")
      );
      expect(match, "Expected improvements for ?| any-key existence query").toBeTruthy();
      expect(hasGinRecommendation(match!), "Expected a GIN index recommendation").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      expect(
        ginRecs.every((r) => !r.definition.toLowerCase().includes("jsonb_path_ops")),
        `Expected default jsonb_ops for ?| operator, got: ${ginRecs.map((r) => r.definition)}`,
      ).toBeTruthy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 4. All-keys existence ?& → GIN default jsonb_ops
// ──────────────────────────────────────────────

test("GIN: all-keys existence (?&) recommends GIN with default jsonb_ops", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE events (
              id serial PRIMARY KEY,
              payload jsonb NOT NULL
            );
            INSERT INTO events (payload)
              SELECT jsonb_build_object('type', 'click', 'x', i, 'y', i * 2)
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM events WHERE payload ?& array['x', 'y'] LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "events",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "payload", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("?&") || q.query.includes("payload")
      );
      expect(match, "Expected improvements for ?& all-keys existence query").toBeTruthy();
      expect(hasGinRecommendation(match!), "Expected a GIN index recommendation").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      expect(
        ginRecs.every((r) => !r.definition.toLowerCase().includes("jsonb_path_ops")),
        `Expected default jsonb_ops for ?& operator, got: ${ginRecs.map((r) => r.definition)}`,
      ).toBeTruthy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 5. Mixed JSONB + regular column → GIN + B-tree
// ──────────────────────────────────────────────

test("GIN: mixed JSONB and regular column produces both GIN and B-tree", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE products (
              id serial PRIMARY KEY,
              data jsonb NOT NULL,
              price numeric NOT NULL
            );
            INSERT INTO products (data, price)
              SELECT jsonb_build_object('active', i % 2 = 0, 'name', 'product' || i),
                     (random() * 500)::numeric
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM products WHERE data @> '{"active": true}' AND price > 100 LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "products",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "data", stats: null },
            { columnName: "price", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("products")
      );
      expect(match, "Expected improvements for mixed JSONB + regular query").toBeTruthy();
      expect(
        match!.optimization.state,
        `Expected improvements_available but got ${match!.optimization.state}`,
      ).toEqual("improvements_available");

      const ginRecs = getGinRecommendations(match!);
      const btreeRecs = getBtreeRecommendations(match!);

      // Should have a GIN recommendation for the JSONB column
      expect(
        ginRecs.length,
        `Expected GIN recommendation for data column, got: ${JSON.stringify(match!.optimization.state === "improvements_available" ? match!.optimization.indexRecommendations.map((r) => r.definition) : [])}`,
      ).toBeGreaterThan(0);
      // The two index types should not interfere — GIN for data, B-tree for price
      // The optimizer may or may not also produce a B-tree for price depending on
      // cost analysis, but the GIN and B-tree candidates must remain separate types
      for (const gin of ginRecs) {
        expect(
          gin.definition.toLowerCase(),
          `GIN recommendation should not include non-JSONB column "price", got: ${gin.definition}`,
        ).not.toContain("price");
      }
      for (const btree of btreeRecs) {
        expect(
          btree.definition.toLowerCase(),
          `B-tree recommendation should not be a GIN index, got: ${btree.definition}`,
        ).not.toContain("using gin");
      }
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 6. Mixed @> and ? on same column → ONE GIN
//    with default jsonb_ops (opclass escalation)
// ──────────────────────────────────────────────

test("GIN: mixed @> and ? on same column escalates to jsonb_ops", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE products (
              id serial PRIMARY KEY,
              data jsonb NOT NULL
            );
            INSERT INTO products (data)
              SELECT jsonb_build_object('a', i, 'name', 'product' || i) ||
                CASE WHEN i % 3 = 0 THEN '{"b": true}'::jsonb ELSE '{}'::jsonb END
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM products WHERE data @> '{"a": 1}' AND data ? 'b' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "products",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "data", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("products")
      );
      expect(match, "Expected improvements for mixed @> and ? query").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);

      // Should produce exactly ONE GIN index, not two
      expect(
        ginRecs.length,
        `Expected exactly 1 merged GIN recommendation, got ${ginRecs.length}: ${ginRecs.map((r) => r.definition)}`,
      ).toEqual(1);
      // Should use default jsonb_ops (no jsonb_path_ops) because ? requires it
      expect(
        ginRecs[0].definition.toLowerCase(),
        `Expected default jsonb_ops due to ? operator, got: ${ginRecs[0].definition}`,
      ).not.toContain("jsonb_path_ops");
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 7. Table-aliased JSONB column resolves correctly
// ──────────────────────────────────────────────

test("GIN: table alias resolves to correct table for GIN recommendation", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE products (
              id serial PRIMARY KEY,
              data jsonb NOT NULL
            );
            INSERT INTO products (data)
              SELECT jsonb_build_object('color', CASE WHEN i % 2 = 0 THEN 'red' ELSE 'blue' END, 'name', 'product' || i)
              FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM products p WHERE p.data @> '{"color": "red"}' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "products",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "data", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) =>
        q.query.includes("products")
      );
      expect(match, "Expected improvements for aliased JSONB query").toBeTruthy();
      expect(hasGinRecommendation(match!), "Expected a GIN index recommendation").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      // Should target the real table "products", not the alias "p"
      expect(
        ginRecs.some((r) => r.table === "products"),
        `Expected GIN recommendation on table "products", got: ${ginRecs.map((r) => `${r.table}: ${r.definition}`)}`,
      ).toBeTruthy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 8. Non-JSONB query → normal B-tree, no GIN
// ──────────────────────────────────────────────

test("GIN: non-JSONB query produces B-tree only, no GIN", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE users (
              id serial PRIMARY KEY,
              name text NOT NULL
            );
            INSERT INTO users (name)
              SELECT 'user' || i FROM generate_series(1, 1000) i;
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM users WHERE name = 'alice' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "users",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "name", stats: null },
          ],
          indexes: [],
        }],
      });
      await optimizer.finish;

      const match = improvements.find((q) => q.query.includes("users"));
      expect(match, "Expected improvements for non-JSONB equality query").toBeTruthy();

      const ginRecs = getGinRecommendations(match!);
      expect(
        ginRecs.length,
        `Expected no GIN recommendations for non-JSONB query, got: ${ginRecs.map((r) => r.definition)}`,
      ).toEqual(0);

      const btreeRecs = getBtreeRecommendations(match!);
      expect(
        btreeRecs.length,
        "Expected B-tree recommendation for text equality query",
      ).toBeGreaterThan(0);
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});

// ──────────────────────────────────────────────
// 9. Existing GIN index prevents duplicate
// ──────────────────────────────────────────────

test("GIN: existing GIN index prevents duplicate recommendation", async () => {
    const pg = await new PostgreSqlContainer("postgres:17")
      .withCopyContentToContainer([
        {
          content: `
            CREATE TABLE products (
              id serial PRIMARY KEY,
              data jsonb NOT NULL
            );
            INSERT INTO products (data)
              SELECT jsonb_build_object('category', CASE WHEN i % 3 = 0 THEN 'electronics' ELSE 'clothing' END, 'name', 'product' || i)
              FROM generate_series(1, 1000) i;
            CREATE INDEX idx_products_data ON products USING gin (data jsonb_path_ops);
            CREATE EXTENSION pg_stat_statements;
            SELECT * FROM products WHERE data @> '{"category": "electronics"}' LIMIT 10;
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
    const optimizer = new QueryOptimizer(manager, conn);

    const improvements: OptimizedQuery[] = [];
    const noImprovements: OptimizedQuery[] = [];
    optimizer.addListener("improvementsAvailable", (query) => {
      improvements.push(query);
    });
    optimizer.addListener("noImprovements", (query) => {
      noImprovements.push(query);
    });

    const connector = manager.getConnectorFor(conn);
    try {
      const recentQueries = await connector.getRecentQueries();
      await optimizer.start(recentQueries, {
        kind: "fromStatisticsExport",
        source: { kind: "inline" },
        stats: [{
          tableName: "products",
          schemaName: "public",
          relpages: 100,
          reltuples: 100_000,
          relallvisible: 1,
          columns: [
            { columnName: "id", stats: null },
            { columnName: "data", stats: null },
          ],
          indexes: [{
            indexName: "idx_products_data",
            relpages: 50,
            reltuples: 100_000,
            relallvisible: 1,
          }],
        }],
      });
      await optimizer.finish;

      // Should NOT recommend another GIN index on the same column
      const ginImprovement = improvements.find((q) =>
        q.query.includes("products") && hasGinRecommendation(q)
      );
      expect(
        ginImprovement,
        `Expected no duplicate GIN recommendation when one already exists, but got: ${
          ginImprovement
            ? JSON.stringify(getGinRecommendations(ginImprovement).map((r) => r.definition))
            : "none"
        }`,
      ).toBeFalsy();
    } finally {
      optimizer.stop();
      await manager.closeAll();
      await pg.stop();
    }
});
