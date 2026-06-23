import { test, expect, describe } from "vitest";
import type { Op } from "jsondiffpatch/formatters/jsonpatch";
import {
  buildSchemaChangeView,
  schemaChangeLabel,
  type SchemaChangeKind,
} from "./schema-change.ts";

function entriesFor(view: ReturnType<typeof buildSchemaChangeView>, kind: SchemaChangeKind) {
  return view.groups.find((g) => g.kind === kind)?.entries ?? [];
}

describe("buildSchemaChangeView", () => {
  test("empty operations produce no changes", () => {
    const view = buildSchemaChangeView([]);
    expect(view.hasChanges).toBe(false);
    expect(view.total).toBe(0);
    expect(view.groups).toHaveLength(0);
  });

  test("added table is grouped under 'added' with a qualified name", () => {
    const ops: Op[] = [
      {
        op: "add",
        path: "/tables/0",
        value: { type: "table", oid: 1, schemaName: "public", tableName: "users", columns: [] },
      },
    ];
    const view = buildSchemaChangeView(ops);
    expect(view.hasChanges).toBe(true);
    const added = entriesFor(view, "added");
    expect(added).toEqual([{ kind: "added", object: "table", name: "public.users" }]);
  });

  test("added index names itself as table.index", () => {
    const ops: Op[] = [
      {
        op: "add",
        path: "/indexes/0",
        value: {
          type: "index",
          oid: 42,
          schemaName: "public",
          tableName: "users",
          indexName: "users_email_idx",
        },
      },
    ];
    const added = entriesFor(buildSchemaChangeView(ops), "added");
    expect(added[0]).toEqual({ kind: "added", object: "index", name: "users.users_email_idx" });
  });

  test("removed object is grouped under 'removed' (no value to name it)", () => {
    const ops: Op[] = [{ op: "remove", path: "/constraints/2" }];
    const view = buildSchemaChangeView(ops);
    const removed = entriesFor(view, "removed");
    expect(removed).toEqual([{ kind: "removed", object: "constraint", name: "(removed)" }]);
  });

  test("property-level replace is a 'changed' entry carrying the sub-path", () => {
    const ops: Op[] = [{ op: "replace", path: "/indexes/0/isUnique", value: true }];
    const changed = entriesFor(buildSchemaChangeView(ops), "changed");
    expect(changed).toEqual([
      { kind: "changed", object: "index", name: "", detail: "isUnique" },
    ]);
  });

  test("extension uses extensionName and is unqualified", () => {
    const ops: Op[] = [
      {
        op: "add",
        path: "/extensions/0",
        value: { extensionName: "pg_trgm", version: "1.0", schemaName: "public" },
      },
    ];
    const added = entriesFor(buildSchemaChangeView(ops), "added");
    expect(added[0]).toEqual({ kind: "added", object: "extension", name: "pg_trgm" });
  });

  test("move ops and unknown collections are ignored", () => {
    const ops: Op[] = [
      { op: "move", from: "/tables/0", path: "/tables/1" },
      { op: "add", path: "/unknownCollection/0", value: { name: "x" } },
    ];
    const view = buildSchemaChangeView(ops);
    expect(view.hasChanges).toBe(false);
  });

  test("mixed ops total and order by added → removed → changed", () => {
    const ops: Op[] = [
      { op: "replace", path: "/tables/0/tablespace", value: "fast_ssd" },
      { op: "remove", path: "/indexes/3" },
      {
        op: "add",
        path: "/tables/1",
        value: { type: "table", oid: 5, schemaName: "public", tableName: "orders", columns: [] },
      },
    ];
    const view = buildSchemaChangeView(ops);
    expect(view.total).toBe(3);
    expect(view.groups.map((g) => g.kind)).toEqual(["added", "removed", "changed"]);
  });
});

describe("schemaChangeLabel", () => {
  test("named entry", () => {
    expect(
      schemaChangeLabel({ kind: "added", object: "table", name: "public.users" }),
    ).toBe("table public.users");
  });

  test("changed entry with detail and no name", () => {
    expect(
      schemaChangeLabel({ kind: "changed", object: "index", name: "", detail: "isUnique" }),
    ).toBe("index · isUnique");
  });
});
