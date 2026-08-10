import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_BRANCH, publishHistory } from "./publish-history.ts";

/**
 * Runs against a real repository in a temp directory. The interesting
 * behaviour is all git's, so a mock would only assert that the code calls the
 * functions it calls.
 */
const git = (repo: string, args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

let repo: string;
let records: string;

function writeRecord(month: string, sha: string) {
  const dir = join(records, "data", month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha}.json`), JSON.stringify({ commit: sha }));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bench-repo-"));
  records = mkdtempSync(join(tmpdir(), "bench-records-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "bench@example.com"]);
  git(repo, ["config", "user.name", "Bench"]);
  // Source that must never end up on the history branch.
  writeFileSync(join(repo, "source.ts"), "export const x = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
});

describe("publishHistory", () => {
  it("creates the branch with only the records on it", () => {
    writeRecord("2026-07", "abc123");
    const result = publishHistory({
      repo,
      worktree: join(repo, "..", `wt-${Date.now()}`),
      records,
      message: "record abc123",
    });

    expect(result.committed).toBe(true);
    expect(result.added).toBe(1);

    const tracked = git(repo, ["ls-tree", "-r", "--name-only", HISTORY_BRANCH])
      .split("\n")
      .filter(Boolean);
    expect(tracked).toStrictEqual(["data/2026-07/abc123.json"]);
    // The source of the branch it was created from must not be carried over.
    expect(tracked).not.toContain("source.ts");
  });

  it("leaves the working branch untouched", () => {
    writeRecord("2026-07", "abc123");
    publishHistory({
      repo,
      worktree: join(repo, "..", `wt2-${Date.now()}`),
      records,
      message: "record",
    });

    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "source.ts"))).toBe(true);
  });

  it("adds to an existing history rather than replacing it", () => {
    const worktree = join(repo, "..", `wt3-${Date.now()}`);
    writeRecord("2026-07", "abc123");
    publishHistory({ repo, worktree, records, message: "first" });

    writeRecord("2026-08", "def456");
    const second = publishHistory({ repo, worktree, records, message: "second" });

    expect(second.added).toBe(1);
    const tracked = git(repo, ["ls-tree", "-r", "--name-only", HISTORY_BRANCH])
      .split("\n")
      .filter(Boolean);
    expect(tracked).toStrictEqual([
      "data/2026-07/abc123.json",
      "data/2026-08/def456.json",
    ]);
  });

  it("commits nothing when no record changed", () => {
    const worktree = join(repo, "..", `wt4-${Date.now()}`);
    writeRecord("2026-07", "abc123");
    publishHistory({ repo, worktree, records, message: "first" });

    const again = publishHistory({ repo, worktree, records, message: "again" });
    expect(again.committed).toBe(false);
    expect(again.added).toBe(0);
    // One commit, not two.
    expect(git(repo, ["rev-list", "--count", HISTORY_BRANCH])).toBe("1");
  });

  it("does nothing when there are no records at all", () => {
    const result = publishHistory({
      repo,
      worktree: join(repo, "..", `wt5-${Date.now()}`),
      records,
      message: "nothing",
    });
    expect(result).toStrictEqual({ added: 0, committed: false, pushed: false });
  });
});
