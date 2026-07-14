import { describe, expect, test } from "vitest";
import { originFile, originsCompatible, shapeKey } from "./query-shape.ts";

describe("shapeKey", () => {
  test("a column added to the SELECT list does not change the key", async () => {
    const base = await shapeKey(
      "SELECT id, user_id FROM renders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    );
    const wider = await shapeKey(
      "SELECT id, user_id, session_id, source_payload FROM renders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    );
    expect(base).not.toBeNull();
    expect(wider).toBe(base);
  });

  test("a different WHERE changes the key", async () => {
    const a = await shapeKey("SELECT id FROM renders WHERE user_id = $1");
    const b = await shapeKey("SELECT id FROM renders WHERE share_slug = $1");
    expect(a).not.toBe(b);
  });

  test("a different table changes the key", async () => {
    const a = await shapeKey("SELECT id FROM renders WHERE id = $1");
    const b = await shapeKey("SELECT id FROM widgets WHERE id = $1");
    expect(a).not.toBe(b);
  });

  test("returns null for an unparseable query rather than throwing", async () => {
    expect(await shapeKey("this is not sql")).toBeNull();
  });
});

describe("originFile", () => {
  test("reads the first entry of the file tag", () => {
    expect(
      originFile([{ key: "file", value: "src/db/postgres.ts;src/service.ts" }]),
    ).toBe("src/db/postgres.ts");
  });

  test("is null when there is no file tag", () => {
    expect(originFile([{ key: "route", value: "/api/x" }])).toBeNull();
    expect(originFile(undefined)).toBeNull();
  });
});

describe("originsCompatible", () => {
  test("both tagged and equal → compatible", () => {
    const a = [{ key: "file", value: "src/db/postgres.ts" }];
    const b = [{ key: "file", value: "src/db/postgres.ts" }];
    expect(originsCompatible(a, b)).toBe(true);
  });

  test("both tagged and different → incompatible", () => {
    const a = [{ key: "file", value: "src/db/postgres.ts" }];
    const b = [{ key: "file", value: "src/db/other.ts" }];
    expect(originsCompatible(a, b)).toBe(false);
  });

  test("either untagged → compatible", () => {
    expect(originsCompatible([{ key: "file", value: "src/db/postgres.ts" }], [])).toBe(true);
    expect(originsCompatible(undefined, undefined)).toBe(true);
  });
});
