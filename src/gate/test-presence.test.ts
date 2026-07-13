import { describe, expect, test } from "vitest";
import {
  classifyChangedFiles,
  evaluateTestPresence,
  patchAddsQueryCode,
  type ChangedFile,
} from "./test-presence.ts";

/** A minimal patch whose single added line is `line`. */
function addPatch(line: string): string {
  return `@@ -1,0 +1,1 @@\n+${line}`;
}

const changed = (
  path: string,
  line: string,
  status = "modified",
): ChangedFile => ({ path, status, patch: addPatch(line) });

describe("patchAddsQueryCode", () => {
  test("detects an ORM query call in added lines", () => {
    expect(patchAddsQueryCode(addPatch("const u = await db.select().from(users);"))).toBe(
      true,
    );
  });

  test("detects a raw SQL string", () => {
    expect(patchAddsQueryCode(addPatch('await client.query("INSERT INTO users VALUES (1)");'))).toBe(
      true,
    );
  });

  test("ignores a comment that merely mentions SQL keywords", () => {
    expect(patchAddsQueryCode(addPatch("// TODO: select the user from the list"))).toBe(
      false,
    );
  });

  test("ignores non-query code", () => {
    expect(patchAddsQueryCode(addPatch("const total = items.length + 1;"))).toBe(false);
  });

  test("only looks at added lines, not removed ones", () => {
    const patch = "@@ -1,1 +1,1 @@\n-await db.select().from(users);\n+const x = 1;";
    expect(patchAddsQueryCode(patch)).toBe(false);
  });

  test("is false for a missing patch", () => {
    expect(patchAddsQueryCode(undefined)).toBe(false);
  });
});

describe("classifyChangedFiles", () => {
  test("classes a query-bearing non-test file as data-access, wherever it lives", () => {
    // Not named like a repository — content is what counts now.
    const surface = classifyChangedFiles([
      changed("apps/api/src/users/user.service.ts", "return db.select().from(users);"),
    ]);
    expect(surface.dataAccessChanged).toEqual(["apps/api/src/users/user.service.ts"]);
  });

  test("does NOT flag a comment-only edit to a repository file", () => {
    const surface = classifyChangedFiles([
      changed("apps/api/src/users/user.repository.ts", "// clarify the join order"),
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("classes a query-bearing test as a data-layer test", () => {
    const surface = classifyChangedFiles([
      changed(
        "apps/api/src/users/user.repository.spec.ts",
        "expect(await db.select().from(users)).toHaveLength(1);",
      ),
    ]);
    expect(surface.dataLayerTestChanged).toEqual([
      "apps/api/src/users/user.repository.spec.ts",
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("falls back to the filename prior when a patch is unavailable", () => {
    const surface = classifyChangedFiles([
      { path: "apps/api/src/users/user.repository.ts", status: "modified" },
    ]);
    expect(surface.dataAccessChanged).toEqual(["apps/api/src/users/user.repository.ts"]);
  });

  test("does not count a removed file as a change", () => {
    const surface = classifyChangedFiles([
      changed("apps/api/src/users/user.repository.ts", "db.select().from(users)", "removed"),
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("does NOT class a Drizzle migration .sql as changed data-access", () => {
    // DDL, not a query site — its coverage lives in a pg/integration test.
    const surface = classifyChangedFiles([
      changed(
        "apps/api/drizzle/0026_projects_card1_733.sql",
        "CREATE TABLE projects (id uuid PRIMARY KEY);",
      ),
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("excludes migration .sql under a migrations/ directory too", () => {
    const surface = classifyChangedFiles([
      changed(
        "db/migrations/20240101_add_orders/migration.sql",
        "ALTER TABLE plans ADD COLUMN project_id uuid;",
      ),
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("still classes DDL inside a .ts source file as data-access", () => {
    // A migration file is excluded; a create-table in application code is not.
    const surface = classifyChangedFiles([
      changed(
        "apps/api/src/schema.ts",
        "await db.execute(sql`CREATE TABLE projects (id uuid)`);",
      ),
    ]);
    expect(surface.dataAccessChanged).toEqual(["apps/api/src/schema.ts"]);
  });
});

describe("evaluateTestPresence", () => {
  test("flags a query change with no related test", () => {
    const verdict = evaluateTestPresence([
      changed("apps/api/src/users/user.repository.ts", "db.insert(users).values(u);"),
    ]);
    expect(verdict).toMatchObject({
      condition: "untested-data-access",
      verdictClass: "uncertain-conservative-flag",
      dataAccessFiles: ["apps/api/src/users/user.repository.ts"],
    });
  });

  test("passes when a related data-layer test changes alongside the query", () => {
    const verdict = evaluateTestPresence([
      changed("apps/api/src/users/user.repository.ts", "db.insert(users).values(u);"),
      changed(
        "apps/api/src/users/user.repository.spec.ts",
        "expect(await db.select().from(users)).toEqual([u]);",
      ),
    ]);
    expect(verdict).toBeNull();
  });

  test("still flags when only an UNRELATED data-layer test changed", () => {
    const verdict = evaluateTestPresence([
      changed("apps/api/src/orders/order.repository.ts", "db.insert(orders).values(o);"),
      changed(
        "apps/api/src/users/user.repository.spec.ts",
        "expect(await db.select().from(users)).toEqual([u]);",
      ),
    ]);
    expect(verdict?.dataAccessFiles).toEqual([
      "apps/api/src/orders/order.repository.ts",
    ]);
  });

  test("does not fire on the migration + pg-test PR from #3531", () => {
    // The reported false positive: a PR that adds a Drizzle migration and a pg
    // test exercising the new table/column. The migration is DDL (excluded); the
    // pg test is real coverage — nothing to flag.
    const verdict = evaluateTestPresence([
      changed(
        "drizzle/0026_projects_card1_733.sql",
        "CREATE TABLE projects (id uuid PRIMARY KEY);",
      ),
      changed(
        "tests/pg/postgres.test.ts",
        "expect(await db.select().from(projects)).toEqual([p]);",
      ),
    ]);
    expect(verdict).toBeNull();
  });

  test("does not fire on a migration alone, even with no test", () => {
    // A migration's coverage can't be linked by the diff heuristic, so it is
    // never flagged — under-firing is the safe side for a warn-only gate.
    const verdict = evaluateTestPresence([
      changed(
        "apps/api/drizzle/0027_add_index.sql",
        "CREATE INDEX plans_project_id_idx ON plans (project_id);",
      ),
    ]);
    expect(verdict).toBeNull();
  });

  test("passes when the PR changes no query code", () => {
    const verdict = evaluateTestPresence([
      changed("apps/app/src/components/Button.tsx", "const label = props.label;"),
      changed("docs/guide.md", "Some prose about SELECT and FROM."),
    ]);
    expect(verdict).toBeNull();
  });

  test("does not fire on a comment-only edit to a repository file", () => {
    const verdict = evaluateTestPresence([
      changed("apps/api/src/users/user.repository.ts", "// rename for clarity"),
    ]);
    expect(verdict).toBeNull();
  });

  test("frames the finding as unverified, not a bad query", () => {
    const verdict = evaluateTestPresence([
      changed("src/dal/orders.ts", "db.update(orders).set({ shipped: true });"),
    ]);
    expect(verdict?.reason).toContain("could not verify");
    expect(verdict?.reason).toContain("flagged conservatively");
    expect(verdict?.nextStep).toContain("test");
  });

  // A repo whose data-layer test doesn't sit beside the source or share its stem
  // (e.g. `tests/pg/postgres.test.ts` for `src/db/postgres.ts`) trips the diff
  // heuristic — but the run captured the new queries, proving a test ran them.
  test("passes when capture reports new queries the run executed", () => {
    const files = [
      changed("src/db/postgres.ts", "return db.select().from(projects).where(eq(projects.userId, id));"),
    ];
    expect(evaluateTestPresence(files)).not.toBeNull();
    const verdict = evaluateTestPresence(files, undefined, {
      newQueryHashes: ["f13683ee48e6a487", "53350021ed44ae14"],
    });
    expect(verdict).toBeNull();
  });

  test("still flags when capture reports no new queries", () => {
    const verdict = evaluateTestPresence(
      [changed("src/db/postgres.ts", "return db.select().from(projects);")],
      undefined,
      { newQueryHashes: [] },
    );
    expect(verdict?.dataAccessFiles).toEqual(["src/db/postgres.ts"]);
  });
});
