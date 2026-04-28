import { test, expect } from "vitest";
import {
  RecentQuery,
  QueryHash,
  type RawRecentQuery,
} from "./recent-query.ts";
import type { TableReference } from "@query-doctor/core";

function makeRawQuery(overrides?: Partial<RawRecentQuery>): RawRecentQuery {
  return {
    username: "test",
    query: "SELECT * FROM users",
    formattedQuery: "SELECT * FROM users",
    meanTime: 1.5,
    calls: "10",
    rows: "100",
    topLevel: true,
    ...overrides,
  };
}

const testHash = QueryHash.parse("test-hash");

// --- isSelectQuery ---

test("isSelectQuery returns true for SELECT statements", () => {
  expect(RecentQuery.isSelectQuery(makeRawQuery())).toBe(true);
  expect(
    RecentQuery.isSelectQuery(makeRawQuery({ query: "select 1" })),
  ).toBe(true);
});

test("isSelectQuery returns false for non-SELECT statements", () => {
  expect(
    RecentQuery.isSelectQuery(
      makeRawQuery({ query: "INSERT INTO users VALUES (1)" }),
    ),
  ).toBe(false);
  expect(
    RecentQuery.isSelectQuery(
      makeRawQuery({ query: "UPDATE users SET name = 'x'" }),
    ),
  ).toBe(false);
  expect(
    RecentQuery.isSelectQuery(makeRawQuery({ query: "DELETE FROM users" })),
  ).toBe(false);
});

test("isSelectQuery returns false for DML containing SELECT subqueries", () => {
  expect(
    RecentQuery.isSelectQuery(
      makeRawQuery({
        query: 'UPDATE "public"."oban_jobs" SET "state" = $1 FROM (SELECT id FROM t) s WHERE id = s.id',
      }),
    ),
  ).toBe(false);
  expect(
    RecentQuery.isSelectQuery(
      makeRawQuery({
        query: "INSERT INTO archive SELECT * FROM users",
      }),
    ),
  ).toBe(false);
  expect(
    RecentQuery.isSelectQuery(
      makeRawQuery({
        query: "DELETE FROM users WHERE EXISTS (SELECT 1 FROM banned)",
      }),
    ),
  ).toBe(false);
});

// --- isSystemQuery ---

test("isSystemQuery returns true for pg_ tables", () => {
  const refs: TableReference[] = [{ table: "pg_class", schema: "pg_catalog" }];
  expect(RecentQuery.isSystemQuery(refs)).toBe(true);
});

test("isSystemQuery returns true for timescaledb internal tables", () => {
  const refs: TableReference[] = [
    { table: "hypertable", schema: "_timescaledb_catalog" },
  ];
  expect(RecentQuery.isSystemQuery(refs)).toBe(true);
});

test("isSystemQuery returns true for timescaledb_information schema", () => {
  const refs: TableReference[] = [
    { table: "chunks", schema: "timescaledb_information" },
  ];
  expect(RecentQuery.isSystemQuery(refs)).toBe(true);
});

test("isSystemQuery returns false for user tables", () => {
  const refs: TableReference[] = [{ table: "users", schema: "public" }];
  expect(RecentQuery.isSystemQuery(refs)).toBe(false);
});

test("isSystemQuery returns false for empty array", () => {
  expect(RecentQuery.isSystemQuery([])).toBe(false);
});

test("isSystemQuery returns true when any ref is a system table (mixed refs)", () => {
  const refs: TableReference[] = [
    { table: "users", schema: "public" },
    { table: "pg_stat_activity", schema: "pg_catalog" },
  ];
  expect(RecentQuery.isSystemQuery(refs)).toBe(true);
});

// --- isIntrospection ---

test("isIntrospection returns true when query has @qd_introspection marker", () => {
  expect(
    RecentQuery.isIntrospection(
      makeRawQuery({ query: "SELECT 1 /* @qd_introspection */" }),
    ),
  ).toBe(true);
});

test("isIntrospection returns false for normal queries", () => {
  expect(RecentQuery.isIntrospection(makeRawQuery())).toBe(false);
});

// --- isTargetlessSelectQuery ---

test("isTargetlessSelectQuery returns true when no table references", () => {
  expect(RecentQuery.isTargetlessSelectQuery([])).toBe(true);
});

test("isTargetlessSelectQuery returns false when table references exist", () => {
  const refs: TableReference[] = [{ table: "users", schema: "public" }];
  expect(RecentQuery.isTargetlessSelectQuery(refs)).toBe(false);
});

// --- constructor ---

test("constructor sets derived boolean properties correctly for a SELECT on user tables", () => {
  const refs: TableReference[] = [{ table: "users", schema: "public" }];
  const rq = new RecentQuery(makeRawQuery(), refs, [], [], [], testHash, 1000);
  expect(rq.isSelectQuery).toBe(true);
  expect(rq.isSystemQuery).toBe(false);
  expect(rq.isIntrospection).toBe(false);
  expect(rq.isTargetlessSelectQuery).toBe(false);
});

test("constructor sets isTargetlessSelectQuery=true for SELECT with no table refs", () => {
  const rq = new RecentQuery(makeRawQuery(), [], [], [], [], testHash, 1000);
  expect(rq.isSelectQuery).toBe(true);
  expect(rq.isTargetlessSelectQuery).toBe(true);
});

test("constructor sets isTargetlessSelectQuery=false for non-SELECT even with empty refs", () => {
  const rq = new RecentQuery(
    makeRawQuery({ query: "INSERT INTO t VALUES (1)" }),
    [],
    [],
    [],
    [],
    testHash,
    1000,
  );
  expect(rq.isSelectQuery).toBe(false);
  expect(rq.isTargetlessSelectQuery).toBe(false);
});

test("constructor copies all data fields from RawRecentQuery", () => {
  const data = makeRawQuery({
    username: "admin",
    query: "SELECT 1",
    formattedQuery: "SELECT\n  1",
    meanTime: 42.5,
    calls: "999",
    rows: "0",
    topLevel: false,
  });
  const rq = new RecentQuery(data, [], [], [], [], testHash, 1000);
  expect(rq.username).toBe("admin");
  expect(rq.query).toBe("SELECT 1");
  expect(rq.formattedQuery).toBe("SELECT\n  1");
  expect(rq.meanTime).toBe(42.5);
  expect(rq.calls).toBe("999");
  expect(rq.rows).toBe("0");
  expect(rq.topLevel).toBe(false);
  expect(rq.hash).toBe(testHash);
  expect(rq.seenAt).toBe(1000);
});

// --- withOptimization ---

test("withOptimization attaches optimization to the instance", () => {
  const rq = new RecentQuery(makeRawQuery(), [], [], [], [], testHash, 1000);
  const optimization = { plan: "mock plan" } as any;
  const optimized = rq.withOptimization(optimization);
  expect(optimized.optimization).toBe(optimization);
  // Should be the same object (mutates in place)
  expect(optimized).toBe(rq);
});

// --- analyze (integration) ---

test("analyze produces a RecentQuery with formatted query and analysis", async () => {
  const data = makeRawQuery({ query: "SELECT id FROM users WHERE id = $1" });
  const rq = await RecentQuery.analyze(data, testHash, 2000);
  expect(rq).toBeInstanceOf(RecentQuery);
  expect(rq.hash).toBe(testHash);
  expect(rq.seenAt).toBe(2000);
  // The formatted query should have uppercase keywords
  expect(rq.formattedQuery).toMatch(/SELECT/);
  // Table references should include 'users'
  expect(rq.tableReferences.some((ref) => ref.table === "users")).toBe(true);
});

test("analyze throws on unparseable SQL", async () => {
  const data = makeRawQuery({ query: "THIS IS NOT VALID SQL AT ALL !!!" });
  await expect(
    RecentQuery.analyze(data, testHash, 3000),
  ).rejects.toThrow();
});

// --- statementType-based isSelectQuery via analyze ---

test("analyze sets isSelectQuery=true for SELECT", async () => {
  const data = makeRawQuery({ query: "SELECT * FROM users" });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.isSelectQuery).toBe(true);
});

test("analyze sets isSelectQuery=true for CTE with SELECT", async () => {
  const data = makeRawQuery({
    query: "WITH cte AS (SELECT id FROM users) SELECT * FROM cte",
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.isSelectQuery).toBe(true);
});

test("analyze sets isSelectQuery=false for UPDATE even with SELECT subquery", async () => {
  const data = makeRawQuery({
    query:
      'UPDATE "public"."jobs" SET "state" = $1 FROM (SELECT id FROM "public"."jobs" WHERE state = $2 LIMIT 10) AS s1 WHERE "jobs".id = s1.id',
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.isSelectQuery).toBe(false);
});

test("analyze sets isSelectQuery=false for INSERT ... SELECT", async () => {
  const data = makeRawQuery({
    query: "INSERT INTO archive SELECT * FROM users WHERE active = false",
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.isSelectQuery).toBe(false);
});

test("analyze sets isSelectQuery=false for DELETE with EXISTS subquery", async () => {
  const data = makeRawQuery({
    query:
      "DELETE FROM users WHERE EXISTS (SELECT 1 FROM banned WHERE banned.user_id = users.id)",
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.isSelectQuery).toBe(false);
});

// --- displayQuery via analyze ---

test("analyze populates displayQuery for wide SELECTs", async () => {
  const data = makeRawQuery({
    query:
      'SELECT "u"."id", "u"."email", "u"."first_name", "u"."last_name", "u"."created_at", "u"."updated_at", "u"."stripe_customer_id" FROM "users" "u" WHERE "u"."id" = $1',
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  // Normalize whitespace because the analyzer prettier-formats the query
  // before compacting; the site applies the same normalization on render.
  const normalized = rq.displayQuery?.replace(/\s+/g, " ").trim();
  expect(normalized).toBe(
    `SELECT ... FROM "users" "u" WHERE "u"."id" = $1;`,
  );
});

test("analyze leaves displayQuery undefined for narrow SELECTs", async () => {
  const data = makeRawQuery({ query: "SELECT id FROM users WHERE id = $1" });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.displayQuery).toBeUndefined();
});

test("analyze leaves displayQuery undefined for non-SELECTs", async () => {
  const data = makeRawQuery({
    query:
      "INSERT INTO archive SELECT a, b, c, d, e, f, g, h FROM users WHERE active = false",
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.displayQuery).toBeUndefined();
});

test("analyze leaves displayQuery undefined for UNION", async () => {
  const data = makeRawQuery({
    query:
      "SELECT a, b, c, d, e, f, g FROM t UNION SELECT a, b, c, d, e, f, g FROM u",
  });
  const rq = await RecentQuery.analyze(data, testHash, 1000);
  expect(rq.displayQuery).toBeUndefined();
});
