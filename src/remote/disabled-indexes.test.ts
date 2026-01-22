import { assertEquals } from "@std/assert/equals";
import { DisabledIndexes } from "./disabled-indexes.ts";
import { PgIdentifier } from "@query-doctor/core";

Deno.test("DisabledIndexes.add adds an index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const result = [...indexes];
  assertEquals(result.length, 1);
  assertEquals(result[0].toString(), "my_index");
});

Deno.test("DisabledIndexes.remove removes an existing index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const removed = indexes.remove(indexName);
  assertEquals(removed, true);
  assertEquals([...indexes].length, 0);
});

Deno.test("DisabledIndexes.remove returns false for non-existent index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  const removed = indexes.remove(indexName);
  assertEquals(removed, false);
});

Deno.test("DisabledIndexes.toggle disables an enabled index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  const isDisabled = indexes.toggle(indexName);
  assertEquals(isDisabled, true);
  assertEquals([...indexes].length, 1);
});

Deno.test("DisabledIndexes.toggle enables a disabled index", () => {
  const indexes = new DisabledIndexes();
  const indexName = PgIdentifier.fromString("my_index");
  indexes.add(indexName);
  const isDisabled = indexes.toggle(indexName);
  assertEquals(isDisabled, false);
  assertEquals([...indexes].length, 0);
});

Deno.test("DisabledIndexes iterator returns PgIdentifier instances", () => {
  const indexes = new DisabledIndexes();
  indexes.add(PgIdentifier.fromString("index_a"));
  indexes.add(PgIdentifier.fromString("index_b"));
  const result = [...indexes];
  assertEquals(result.length, 2);
  assertEquals(result.map((i) => i.toString()).sort(), ["index_a", "index_b"]);
});
