import { test, expect } from "vitest";
import {
  DependencyAnalyzer,
  type DatabaseConnector,
  type Hash,
  type Dependency,
} from "./dependency-tree.ts";

type TestRow = { data: Record<string, unknown>; table: string };

function makeConnector(
  db: Record<string, Record<string, unknown>[]>,
  deps: Dependency[],
): DatabaseConnector<TestRow> {
  return {
    async *cursor(table) {
      for (const row of db[table] ?? []) {
        yield { data: row, table };
      }
    },
    dependencies() {
      return Promise.resolve(deps);
    },
    get(table, values) {
      const found = (db[table] ?? []).find((row) =>
        Object.entries(values).every(
          ([key, value]) => String(row[key]) === String(value),
        ),
      );
      return Promise.resolve(found ? { data: found, table } : undefined);
    },
    hash(v) {
      return JSON.stringify(v.data) as Hash;
    },
  };
}

test("findAllDependencies returns empty when requiredRows is 0", async () => {
  const connector = makeConnector(
    { "public.users": [{ id: 1 }] },
    [
      {
        sourceSchema: "public",
        sourceTable: "users",
        sourceColumn: null,
        referencedSchema: null,
        referencedTable: null,
        referencedColumn: null,
      },
    ],
  );
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 0,
    maxRows: 10,
    seed: 0,
  });
  const graph = await da.buildGraph(
    await connector.dependencies({ excludedSchemas: [] }),
  );
  const result = await da.findAllDependencies(graph);
  expect(result.items).toEqual({});
  expect(result.notices).toEqual([]);
});

test("findAllDependencies produces too_few_rows notice when table has fewer rows than required", async () => {
  const connector = makeConnector(
    { "public.users": [{ id: 1 }] },
    [
      {
        sourceSchema: "public",
        sourceTable: "users",
        sourceColumn: null,
        referencedSchema: null,
        referencedTable: null,
        referencedColumn: null,
      },
    ],
  );
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 5,
    maxRows: 100,
    seed: 0,
  });
  const graph = await da.buildGraph(
    await connector.dependencies({ excludedSchemas: [] }),
  );
  const result = await da.findAllDependencies(graph);
  expect(result.items["public.users"]).toHaveLength(1);
  expect(result.notices).toEqual([
    {
      kind: "too_few_rows",
      table: "public.users",
      requested: 5,
      found: 1,
    },
  ]);
});

test("buildGraph creates entries for tables with no dependencies", async () => {
  const connector = makeConnector(
    { "public.standalone": [{ id: 1 }] },
    [
      {
        sourceSchema: "public",
        sourceTable: "standalone",
        sourceColumn: null,
        referencedSchema: null,
        referencedTable: null,
        referencedColumn: null,
      },
    ],
  );
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 1,
    maxRows: 10,
    seed: 0,
  });
  const graph = await da.buildGraph(
    await connector.dependencies({ excludedSchemas: [] }),
  );
  expect(graph.has("public.standalone")).toBe(true);
  expect(graph.get("public.standalone")).toEqual([]);
});

test("buildGraph links FK dependencies between tables", async () => {
  const deps: Dependency[] = [
    {
      sourceSchema: "public",
      sourceTable: "posts",
      sourceColumn: ["author_id"],
      referencedSchema: "public",
      referencedTable: "users",
      referencedColumn: ["id"],
    },
  ];
  const connector = makeConnector({}, deps);
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 1,
    maxRows: 10,
    seed: 0,
  });
  const graph = await da.buildGraph(deps);
  const pointers = graph.get("public.posts");
  expect(pointers).toBeDefined();
  expect(pointers).toHaveLength(1);
  expect(pointers![0]).toMatchObject({
    sourceColumn: ["author_id"],
    referencedColumn: ["id"],
  });
});

test("findAllDependencies follows FK chains correctly", async () => {
  const connector = makeConnector(
    {
      "public.orders": [{ id: 1, user_id: 10 }],
      "public.users": [{ id: 10 }],
    },
    [
      {
        sourceSchema: "public",
        sourceTable: "orders",
        sourceColumn: ["user_id"],
        referencedSchema: "public",
        referencedTable: "users",
        referencedColumn: ["id"],
      },
      {
        sourceSchema: "public",
        sourceTable: "users",
        sourceColumn: null,
        referencedSchema: null,
        referencedTable: null,
        referencedColumn: null,
      },
    ],
  );
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 1,
    maxRows: 10,
    seed: 0,
  });
  const graph = await da.buildGraph(
    await connector.dependencies({ excludedSchemas: [] }),
  );
  const result = await da.findAllDependencies(graph);
  // The order's FK to user should pull in the user row
  expect(result.items["public.users"]).toContainEqual({ id: 10 });
  expect(result.items["public.orders"]).toContainEqual({
    id: 1,
    user_id: 10,
  });
});

test("findAllDependencies skips null FK values without error", async () => {
  const connector = makeConnector(
    {
      "public.posts": [{ id: 1, author_id: null }],
      "public.users": [{ id: 10 }],
    },
    [
      {
        sourceSchema: "public",
        sourceTable: "posts",
        sourceColumn: ["author_id"],
        referencedSchema: "public",
        referencedTable: "users",
        referencedColumn: ["id"],
      },
      {
        sourceSchema: "public",
        sourceTable: "users",
        sourceColumn: null,
        referencedSchema: null,
        referencedTable: null,
        referencedColumn: null,
      },
    ],
  );
  const da = new DependencyAnalyzer(connector, {
    requiredRows: 1,
    maxRows: 10,
    seed: 0,
  });
  const graph = await da.buildGraph(
    await connector.dependencies({ excludedSchemas: [] }),
  );
  const result = await da.findAllDependencies(graph);
  expect(result.items["public.posts"]).toContainEqual({
    id: 1,
    author_id: null,
  });
  // User should still be pulled in via its own cursor, not the null FK
  expect(result.items["public.users"]).toHaveLength(1);
});
