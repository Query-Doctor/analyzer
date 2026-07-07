import { describe, expect, test } from "vitest";
import {
  classifyChangedFiles,
  evaluateTestPresence,
  type ChangedFile,
} from "./test-presence.ts";

const added = (path: string): ChangedFile => ({ path, status: "added" });
const modified = (path: string): ChangedFile => ({ path, status: "modified" });
const removed = (path: string): ChangedFile => ({ path, status: "removed" });

describe("classifyChangedFiles", () => {
  test("buckets a repository and its spec into different surfaces", () => {
    const surface = classifyChangedFiles([
      modified("apps/api/src/users/user.repository.ts"),
      modified("apps/api/src/users/user.repository.spec.ts"),
    ]);
    expect(surface).toEqual({
      dataAccessChanged: ["apps/api/src/users/user.repository.ts"],
      dataLayerTestChanged: ["apps/api/src/users/user.repository.spec.ts"],
    });
  });

  test("treats files under a dal/ directory as data-access", () => {
    const surface = classifyChangedFiles([added("src/dal/orders.ts")]);
    expect(surface.dataAccessChanged).toEqual(["src/dal/orders.ts"]);
    expect(surface.dataLayerTestChanged).toEqual([]);
  });

  test("counts an integration test as a data-layer test", () => {
    const surface = classifyChangedFiles([
      added("test/orders.integration.test.ts"),
    ]);
    expect(surface.dataLayerTestChanged).toEqual([
      "test/orders.integration.test.ts",
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });

  test("ignores non-data-access files entirely", () => {
    const surface = classifyChangedFiles([
      modified("apps/app/src/components/Button.tsx"),
      modified("README.md"),
    ]);
    expect(surface).toEqual({ dataAccessChanged: [], dataLayerTestChanged: [] });
  });

  test("does not count a removed data-access file as a change", () => {
    const surface = classifyChangedFiles([
      removed("apps/api/src/users/user.repository.ts"),
    ]);
    expect(surface.dataAccessChanged).toEqual([]);
  });
});

describe("evaluateTestPresence", () => {
  test("flags data-access change with no data-layer test", () => {
    const verdict = evaluateTestPresence([
      modified("apps/api/src/users/user.repository.ts"),
    ]);
    expect(verdict).not.toBeNull();
    expect(verdict).toMatchObject({
      condition: "untested-data-access",
      verdictClass: "uncertain-conservative-flag",
      dataAccessFiles: ["apps/api/src/users/user.repository.ts"],
    });
  });

  test("passes when a data-layer test changes alongside the data-access code", () => {
    const verdict = evaluateTestPresence([
      modified("apps/api/src/users/user.repository.ts"),
      added("apps/api/src/users/user.repository.spec.ts"),
    ]);
    expect(verdict).toBeNull();
  });

  test("passes when the PR changes no data-access code", () => {
    const verdict = evaluateTestPresence([
      modified("apps/app/src/components/Button.tsx"),
      added("docs/guide.md"),
    ]);
    expect(verdict).toBeNull();
  });

  test("does not fire on a pure data-access deletion", () => {
    const verdict = evaluateTestPresence([
      removed("apps/api/src/users/user.repository.ts"),
    ]);
    expect(verdict).toBeNull();
  });

  test("frames the finding as unverified, not as a bad query", () => {
    const verdict = evaluateTestPresence([
      added("src/dal/orders.ts"),
    ]);
    expect(verdict?.reason).toContain("could not verify");
    expect(verdict?.reason).toContain("flagged conservatively");
    expect(verdict?.nextStep).toContain("test");
  });

  test("evaluates only diff-introduced surface, not pre-existing code", () => {
    // A frontend-only PR: pre-existing repositories elsewhere are untouched and
    // must not trip the gate, because they aren't in the diff.
    const verdict = evaluateTestPresence([
      modified("apps/app/src/routes/dashboard.tsx"),
    ]);
    expect(verdict).toBeNull();
  });
});
