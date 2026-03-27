import { test, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { buildStatsFromDatabase } from "./build-stats.ts";
import { connectToSource } from "./sql/postgresjs.ts";
import { Connectable } from "./sync/connectable.ts";
import {
  IndexOptimizer,
  PostgresQueryBuilder,
  Statistics,
  type Postgres,
} from "@query-doctor/core";

let pg: StartedPostgreSqlContainer;
let db: Postgres;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:17")
    .withCommand(["-c", "autovacuum=off"])
    .start();
  db = connectToSource(Connectable.fromString(pg.getConnectionUri()));
}, 30_000);

afterAll(async () => {
  await (db as unknown as { close(): Promise<void> }).close();
  await pg.stop();
});

async function freshSchema(sql: string) {
  // Drop all user tables so each test starts clean
  const tables = await db.exec<{ t: string }>(
    `SELECT tablename AS "t" FROM pg_tables WHERE schemaname = 'public'`,
  );
  for (const { t } of tables) {
    await db.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await db.exec(sql);
}

test("sets reltuples to 10,000 for tables below threshold, preserves real relpages", async () => {
  await freshSchema(`
    CREATE TABLE users(id serial PRIMARY KEY, name text, email text);
    CREATE INDEX users_email_idx ON users(email);
    INSERT INTO users (name, email)
      SELECT 'user_' || i, 'user_' || i || '@example.com'
      FROM generate_series(1, 1000) AS i;
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);

  expect(mode.kind).toBe("fromStatisticsExport");
  if (mode.kind !== "fromStatisticsExport") throw new Error("unreachable");

  const usersStats = mode.stats.find((s) => s.tableName === "users");
  expect(usersStats).toBeDefined();
  expect(usersStats!.reltuples).toBe(10_000);
  expect(usersStats!.relpages).toBeGreaterThan(1);

  const emailIdx = usersStats!.indexes.find(
    (i) => i.indexName === "users_email_idx",
  );
  expect(emailIdx).toBeDefined();
  expect(emailIdx!.relpages).toBeGreaterThanOrEqual(1);
});

test("clamps relpages to at least 1 for empty tables", async () => {
  await freshSchema(`
    CREATE TABLE empty_table(id serial PRIMARY KEY, data text);
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  if (mode.kind !== "fromStatisticsExport") throw new Error("unreachable");

  const stats = mode.stats.find((s) => s.tableName === "empty_table");
  expect(stats).toBeDefined();
  expect(stats!.reltuples).toBe(10_000);
  expect(stats!.relpages).toBeGreaterThanOrEqual(1);
});

test("density stays realistic regardless of actual row count", async () => {
  await freshSchema(`
    CREATE TABLE orders(id serial PRIMARY KEY, user_id int, total numeric);
    CREATE INDEX orders_user_id_idx ON orders(user_id);
    INSERT INTO orders (user_id, total)
      SELECT (random() * 1000)::int, random() * 100
      FROM generate_series(1, 10000);
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  if (mode.kind !== "fromStatisticsExport") throw new Error("unreachable");

  const ordersStats = mode.stats.find((s) => s.tableName === "orders");
  expect(ordersStats).toBeDefined();

  const density = ordersStats!.reltuples / ordersStats!.relpages;
  expect(density).toBeLessThan(500);
  expect(density).toBeGreaterThan(10);
});

test("groups indexes by their parent table", async () => {
  await freshSchema(`
    CREATE TABLE products(id serial PRIMARY KEY, name text, price numeric);
    CREATE INDEX products_name_idx ON products(name);
    CREATE INDEX products_price_idx ON products(price);
    CREATE TABLE categories(id serial PRIMARY KEY, label text);
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  if (mode.kind !== "fromStatisticsExport") throw new Error("unreachable");

  const products = mode.stats.find((s) => s.tableName === "products");
  expect(products).toBeDefined();
  const indexNames = products!.indexes.map((i) => i.indexName).sort();
  expect(indexNames).toContain("products_name_idx");
  expect(indexNames).toContain("products_price_idx");
  expect(indexNames).toContain("products_pkey");

  const categories = mode.stats.find((s) => s.tableName === "categories");
  expect(categories).toBeDefined();
  const catIndexNames = categories!.indexes.map((i) => i.indexName);
  expect(catIndexNames).toContain("categories_pkey");
  expect(catIndexNames).not.toContain("products_name_idx");
});

test("planner estimates 10,000 rows with only 1 row seeded", async () => {
  await freshSchema(`
    CREATE TABLE widgets(id serial PRIMARY KEY, user_id uuid, name text);
    INSERT INTO widgets (user_id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'w1');
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  const stats = await Statistics.fromPostgres(db, mode);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(db, stats, existingIndexes);

  const builder = new PostgresQueryBuilder("SELECT * FROM widgets");
  const plan = await optimizer.testQueryWithStats(builder);

  const estimatedRows = (plan.Plan as Record<string, unknown>)["Plan Rows"];
  expect(estimatedRows).toBe(10_000);
});

test("planner estimates 10,000 rows with 10,000 rows seeded", async () => {
  await freshSchema(`
    CREATE TABLE widgets(id serial PRIMARY KEY, user_id uuid, name text);
    INSERT INTO widgets (user_id, name)
      SELECT gen_random_uuid(), 'widget_' || i
      FROM generate_series(1, 10000) AS i;
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  const stats = await Statistics.fromPostgres(db, mode);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(db, stats, existingIndexes);

  const builder = new PostgresQueryBuilder("SELECT * FROM widgets");
  const plan = await optimizer.testQueryWithStats(builder);

  const estimatedRows = (plan.Plan as Record<string, unknown>)["Plan Rows"];
  expect(estimatedRows).toBe(10_000);
});

test("planner estimates 10,000 rows even with 50,000 rows seeded", async () => {
  await freshSchema(`
    CREATE TABLE widgets(id serial PRIMARY KEY, user_id uuid, name text);
    INSERT INTO widgets (user_id, name)
      SELECT gen_random_uuid(), 'widget_' || i
      FROM generate_series(1, 50000) AS i;
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  const stats = await Statistics.fromPostgres(db, mode);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(db, stats, existingIndexes);

  const builder = new PostgresQueryBuilder("SELECT * FROM widgets");
  const plan = await optimizer.testQueryWithStats(builder);

  const estimatedRows = (plan.Plan as Record<string, unknown>)["Plan Rows"];
  expect(estimatedRows).toBe(10_000);
});

test("BUG: fromAssumption(relpages=1) inflates estimates with real data", async () => {
  await freshSchema(`
    CREATE TABLE widgets(id serial PRIMARY KEY, user_id uuid, name text);
    INSERT INTO widgets (user_id, name)
      SELECT gen_random_uuid(), 'widget_' || i
      FROM generate_series(1, 10000) AS i;
    ANALYZE;
  `);

  const brokenMode = Statistics.defaultStatsMode;
  const stats = await Statistics.fromPostgres(db, brokenMode);
  const existingIndexes = await stats.getExistingIndexes();
  const optimizer = new IndexOptimizer(db, stats, existingIndexes);

  const builder = new PostgresQueryBuilder("SELECT * FROM widgets");
  const plan = await optimizer.testQueryWithStats(builder);

  const estimatedRows = (plan.Plan as Record<string, unknown>)["Plan Rows"];
  expect(estimatedRows).toBeGreaterThan(100_000);
});

test("leaves columns null so ANALYZE pg_statistic entries persist", async () => {
  await freshSchema(`
    CREATE TABLE items(id serial PRIMARY KEY, label text);
    INSERT INTO items (label) SELECT 'item_' || i FROM generate_series(1, 100) AS i;
    ANALYZE;
  `);

  const mode = await buildStatsFromDatabase(db);
  if (mode.kind !== "fromStatisticsExport") throw new Error("unreachable");

  const items = mode.stats.find((s) => s.tableName === "items");
  expect(items).toBeDefined();
  expect(items!.columns).toBeNull();
});
