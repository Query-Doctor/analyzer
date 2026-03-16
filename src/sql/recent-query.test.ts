import { test, expect } from "vitest";
import { RecentQuery, type RawRecentQuery } from "./recent-query.ts";
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

test("isSelectQuery returns true for SELECT statements", () => {
  expect(RecentQuery.isSelectQuery(makeRawQuery())).toBe(true);
  expect(
    RecentQuery.isSelectQuery(makeRawQuery({ query: "select 1" })),
  ).toBe(true);
});

test("isSelectQuery returns false for non-SELECT statements", () => {
  expect(
    RecentQuery.isSelectQuery(makeRawQuery({ query: "INSERT INTO users VALUES (1)" })),
  ).toBe(false);
  expect(
    RecentQuery.isSelectQuery(makeRawQuery({ query: "UPDATE users SET name = 'x'" })),
  ).toBe(false);
});

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

test("isTargetlessSelectQuery returns true when no table references", () => {
  expect(RecentQuery.isTargetlessSelectQuery([])).toBe(true);
});

test("isTargetlessSelectQuery returns false when table references exist", () => {
  const refs: TableReference[] = [{ table: "users", schema: "public" }];
  expect(RecentQuery.isTargetlessSelectQuery(refs)).toBe(false);
});
