import { test, expect } from "vitest";
import { computeDisplayQuery } from "./display-query.ts";

test("returns undefined for SELECT below both thresholds", async () => {
  expect(await computeDisplayQuery("SELECT a, b FROM t")).toBeUndefined();
});

test("compacts SELECT with more than 2 columns", async () => {
  const q = "SELECT a, b, c FROM t WHERE x = 1";
  expect(await computeDisplayQuery(q)).toBe(
    "SELECT ... FROM t WHERE x = 1",
  );
});

test("compacts SELECT with a long target list slice even at 2 columns", async () => {
  const q =
    'SELECT "u"."stripe_customer_subscription_id", "u"."very_long_last_seen_timestamp" FROM "users" "u"';
  expect(await computeDisplayQuery(q)).toBe(
    'SELECT ... FROM "users" "u"',
  );
});

test("matches the hand-off example", async () => {
  const q =
    'SELECT "u"."id", "u"."email", "u"."first_name", "u"."last_name", "u"."created_at", "u"."updated_at", "u"."stripe_customer_id" FROM "users" "u" WHERE "u"."id" = $1';
  expect(await computeDisplayQuery(q)).toBe(
    'SELECT ... FROM "users" "u" WHERE "u"."id" = $1',
  );
});

test("leaves outer SELECT alone when only an inner subquery would benefit", async () => {
  const q = "SELECT a, b FROM (SELECT x, y, z, w, v, u FROM inner_t) s";
  expect(await computeDisplayQuery(q)).toBeUndefined();
});

test("returns undefined for SELECT COUNT(*)", async () => {
  expect(
    await computeDisplayQuery("SELECT COUNT(*) FROM t"),
  ).toBeUndefined();
});

test("preserves DISTINCT in the prefix when compacting", async () => {
  const q = "SELECT DISTINCT a, b, c, d, e, f, g FROM t";
  expect(await computeDisplayQuery(q)).toBe("SELECT DISTINCT ... FROM t");
});

test("returns undefined for targetless SELECT like SELECT now()", async () => {
  expect(await computeDisplayQuery("SELECT now()")).toBeUndefined();
});

test("returns undefined for CTE when outer SELECT is below threshold", async () => {
  const q =
    "WITH cte AS (SELECT a, b, c, d, e, f FROM t) SELECT x, y FROM cte";
  expect(await computeDisplayQuery(q)).toBeUndefined();
});

test("compacts outer SELECT only, leaving the CTE untouched", async () => {
  const q =
    "WITH cte AS (SELECT a FROM t) SELECT x, y, z FROM cte WHERE r > 0";
  expect(await computeDisplayQuery(q)).toBe(
    "WITH cte AS (SELECT a FROM t) SELECT ... FROM cte WHERE r > 0",
  );
});

test("elides line comments that sit inside the target list", async () => {
  const q = "SELECT a -- comment\n, b, c FROM t";
  expect(await computeDisplayQuery(q)).toBe("SELECT ... FROM t");
});

test("returns undefined for UNION (set-op SELECT)", async () => {
  const q =
    "SELECT a, b, c, d, e, f, g FROM t UNION SELECT a, b, c, d, e, f, g FROM u";
  expect(await computeDisplayQuery(q)).toBeUndefined();
});

test("returns undefined for INTERSECT", async () => {
  const q =
    "SELECT a, b, c, d, e, f, g FROM t INTERSECT SELECT a, b, c, d, e, f, g FROM u";
  expect(await computeDisplayQuery(q)).toBeUndefined();
});

test("returns undefined for EXCEPT", async () => {
  const q =
    "SELECT a, b, c, d, e, f, g FROM t EXCEPT SELECT a, b, c, d, e, f, g FROM u";
  expect(await computeDisplayQuery(q)).toBeUndefined();
});

test("preserves trailing semicolon", async () => {
  const q = "SELECT a, b, c, d, e, f, g FROM t;";
  expect(await computeDisplayQuery(q)).toBe("SELECT ... FROM t;");
});

test("returns undefined when the query can't be parsed", async () => {
  expect(
    await computeDisplayQuery("THIS IS NOT VALID SQL AT ALL !!!"),
  ).toBeUndefined();
});

test("returns undefined for non-SELECT statements", async () => {
  expect(
    await computeDisplayQuery(
      "INSERT INTO archive SELECT a, b, c, d, e, f, g FROM users",
    ),
  ).toBeUndefined();
  expect(
    await computeDisplayQuery("UPDATE users SET a = 1 WHERE id = 2"),
  ).toBeUndefined();
  expect(
    await computeDisplayQuery("DELETE FROM users WHERE id = 2"),
  ).toBeUndefined();
});

test("ignores FROM inside subquery target expression when compacting outer", async () => {
  const q =
    "SELECT (SELECT a FROM s), b, c, d, e, f, g FROM outer_t WHERE x = 1";
  expect(await computeDisplayQuery(q)).toBe(
    "SELECT ... FROM outer_t WHERE x = 1",
  );
});

test("ignores string literal that looks like FROM", async () => {
  const q =
    "SELECT CASE WHEN x = 'FROM' THEN 1 ELSE 2 END, a, b, c, d, e, f FROM t";
  expect(await computeDisplayQuery(q)).toBe("SELECT ... FROM t");
});

test("handles lowercase keywords", async () => {
  const q = "select a, b, c, d, e, f, g from t where x = 1";
  expect(await computeDisplayQuery(q)).toBe(
    "select ... from t where x = 1",
  );
});

test("ignores FROM inside TRIM(FROM ...) function calls", async () => {
  const q =
    "SELECT TRIM(FROM '  x  '), a, b, c, d, e, f FROM t WHERE x = 1";
  expect(await computeDisplayQuery(q)).toBe(
    "SELECT ... FROM t WHERE x = 1",
  );
});

test("result is never valid SQL (sanity: always contains the '... ' marker)", async () => {
  const q = "SELECT a, b, c FROM t";
  const out = await computeDisplayQuery(q);
  expect(out).toContain("... ");
});

test("slices correctly when a multi-byte char appears before FROM", async () => {
  // The comment 'ä' is 2 UTF-8 bytes but 1 UTF-16 code unit — exercising the
  // byte-aware splice.
  const q = "SELECT /* ä */ a, b, c FROM t";
  expect(await computeDisplayQuery(q)).toBe("SELECT /* ä */ ... FROM t");
});
