import { test, expect } from "vitest";
import { SchemaDiffer, type FullSchema } from "./schema_differ.ts";
import { Connectable } from "./connectable.ts";

function makeConnectable(url = "postgres://test:test@localhost:5432/test"): Connectable {
  return Connectable.fromString(url);
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

  const result = differ.put(conn, makeSchema());
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

test("put returns add op when a table is added", () => {
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
  expect(result!).toContainEqual(
    expect.objectContaining({ op: "add", path: "/tables/0" }),
  );
});

test("put returns remove op when a table is removed", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();

  const withTable = makeSchema({
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

  differ.put(conn, withTable);
  const result = differ.put(conn, makeSchema());

  expect(result).toBeDefined();
  expect(result!).toContainEqual(
    expect.objectContaining({ op: "remove", path: "/tables/0" }),
  );
});

test("put returns replace op when a table property changes", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();

  const original = makeSchema({
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

  differ.put(conn, original);

  const modified = makeSchema({
    tables: [
      {
        type: "table",
        oid: 1,
        schemaName: "public" as any,
        tableName: "users" as any,
        tablespace: "fast_ssd",
        columns: [],
      },
    ],
  });

  const result = differ.put(conn, modified);
  expect(result).toBeDefined();
  expect(result!.some((op) => op.op === "add" || op.op === "replace")).toBe(true);
});

test("put tracks schemas per connectable independently", () => {
  const differ = new SchemaDiffer();
  const conn1 = makeConnectable();
  const conn2 = makeConnectable("postgres://test:test@otherhost:5432/other");

  differ.put(conn1, makeSchema());
  differ.put(conn2, makeSchema());

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

test("put detects index additions with correct path", () => {
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
  expect(result!).toContainEqual(
    expect.objectContaining({ op: "add", path: "/indexes/0" }),
  );
});

test("put detects constraint changes via oid-based identity", () => {
  const differ = new SchemaDiffer();
  const conn = makeConnectable();

  differ.put(conn, makeSchema());

  const withConstraint = makeSchema({
    constraints: [
      {
        type: "constraint",
        oid: 99,
        schemaName: "public" as any,
        tableName: "users" as any,
        constraintName: "users_pkey" as any,
        constraintType: "primary_key",
        definition: "PRIMARY KEY (id)",
      },
    ],
  });

  const result = differ.put(conn, withConstraint);
  expect(result).toBeDefined();
  expect(result!).toContainEqual(
    expect.objectContaining({ op: "add", path: "/constraints/0" }),
  );
});
