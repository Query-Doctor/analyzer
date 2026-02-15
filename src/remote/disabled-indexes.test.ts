import { test, expect } from "vitest";
import { DisabledIndexes } from "./disabled-indexes.ts";
import { PgIdentifier } from "@query-doctor/core";

test("DisabledIndexes.add adds an index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const result = [...indexes];
  expect(result.length).toEqual(1);
  expect(result[0]!.toString()).toEqual("my_index");
});

test("DisabledIndexes.remove removes an existing index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const removed = indexes.remove(indexName);
  expect(removed).toEqual(true);
  expect([...indexes].length).toEqual(0);
});

test("DisabledIndexes.remove returns false for non-existent index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  const removed = indexes.remove(indexName);
  expect(removed).toEqual(false);
});

test("DisabledIndexes.toggle disables an enabled index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  const isDisabled = indexes.toggle(indexName);
  expect(isDisabled).toEqual(true);
  expect([...indexes].length).toEqual(1);
});

test("DisabledIndexes.toggle enables a disabled index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const isDisabled = indexes.toggle(indexName);
  expect(isDisabled).toEqual(false);
  expect([...indexes].length).toEqual(0);
});

test("DisabledIndexes iterator returns PgIdentifier instances", () => {
  const indexes = new DisabledIndexes();
  indexes.add(PgIdentifier.fromString("index_a"));
  indexes.add(PgIdentifier.fromString("index_b"));
  const result = [...indexes];
  expect(result.length).toEqual(2);
  expect(result.map((i) => i.toString()).sort()).toEqual(["index_a", "index_b"]);
});
