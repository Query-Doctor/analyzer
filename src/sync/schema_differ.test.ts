import { test, expect } from "vitest";
import { SchemaDiffer, type FullSchema } from "./schema_differ.ts";
import { Connectable } from "./connectable.ts";

function makeConnectable(): Connectable {
  return new Connectable("postgres://test:test@localhost:5432/test");
}

function makeSchema(overrides?: Partial<FullSchema>): FullSchema {
  return {
    indexes: [],
    tables: [],
    constraints: [],
    functions: [],
    extensions: [],
    views: [],
    types: [],
    triggers: [],
    ...overrides,
  };
}

test("put returns undefined on first call (no previous schema to diff)", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();
  const schema = makeSchema();

  const result = differ.put(conn, schema);
  expect(result).toBeUndefined();
});

test("put returns undefined when schema has not changed", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();
  const schema = makeSchema();

  differ.put(conn, schema);
  const result = differ.put(conn, schema);
  expect(result).toBeUndefined();
});

test("put returns JSON patch ops when schema changes", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();

  differ.put(conn, makeSchema());

  const updated = makeSchema({
    tables: [
      {
        type: "table",
        oid: 1,
        schemaName: "public" as any,
        tableName: "users" as any,
        columns: [],
      },
    ],
  });

  const result = differ.put(conn, updated);
  expect(result).toBeDefined();
  expect(Array.isArray(result)).toBe(true);
  expect(result!.length).toBeGreaterThan(0);
});

test("put tracks schemas per connectable independently", () => {
  const differ = new SchemaDiffer();
  const conn1 = makeConnectable();
  const conn2 = new Connectable("postgres://test:test@localhost:5433/other");

  differ.put(conn1, makeSchema());
  differ.put(conn2, makeSchema());

  // Change only conn1's schema
  const updated = makeSchema({
    extensions: [
      { extensionName: "pg_trgm", version: "1.0", schemaName: "public" as any },
    ],
  });

  const result1 = differ.put(conn1, updated);
  const result2 = differ.put(conn2, makeSchema());

  expect(result1).toBeDefined();
  expect(result2).toBeUndefined();
});

test("put detects index additions via oid-based identity", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();

  differ.put(conn, makeSchema());

  const withIndex = makeSchema({
    indexes: [
      {
        type: "index",
        oid: 42,
        schemaName: "public" as any,
        tableName: "users" as any,
        indexName: "users_pkey" as any,
        indexType: "btree",
        isUnique: true,
        isPrimary: true,
        isClustered: false,
        keyColumns: [{ type: "indexColumn", name: "id" as any }],
      },
    ],
  });

  const result = differ.put(conn, withIndex);
  expect(result).toBeDefined();
  expect(result!.some((op) => op.path.startsWith("/indexes"))).toBe(true);
});
