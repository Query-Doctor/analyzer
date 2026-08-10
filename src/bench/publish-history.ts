import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Publishes measurement records to an orphan branch.
 *
 * An orphan branch rather than a directory on the working branch: the history
 * is data, it grows by one file per commit measured, and it has no business
 * appearing in a diff of the source. Nothing here ever touches the branch the
 * caller is on, and nothing force-pushes.
 */

export const HISTORY_BRANCH = "bench-history";

type Git = (args: string[], cwd?: string) => string;

const run =
  (repo: string): Git =>
  (args, cwd) =>
    execFileSync("git", args, {
      cwd: cwd ?? repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

function branchExists(git: Git, ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A worktree holding the history branch, created if the branch does not exist.
 *
 * The branch starts empty rather than from the current tree, so the source is
 * never carried into it.
 */
export function checkoutHistory(repo: string, worktree: string): string {
  const git = run(repo);

  if (existsSync(worktree)) {
    // Reuse it, but make sure it is current before anything is written.
    try {
      git(["fetch", "origin", HISTORY_BRANCH], worktree);
      git(["reset", "--hard", `origin/${HISTORY_BRANCH}`], worktree);
    } catch {
      // No remote branch yet: whatever is here is the whole history.
    }
    return worktree;
  }

  const local = branchExists(git, `refs/heads/${HISTORY_BRANCH}`);
  const remote = branchExists(git, `refs/remotes/origin/${HISTORY_BRANCH}`);

  mkdirSync(worktree, { recursive: true });
  rmSync(worktree, { recursive: true, force: true });

  if (local) {
    git(["worktree", "add", "-q", worktree, HISTORY_BRANCH]);
  } else if (remote) {
    git([
      "worktree",
      "add",
      "-q",
      "-b",
      HISTORY_BRANCH,
      worktree,
      `origin/${HISTORY_BRANCH}`,
    ]);
  } else {
    git(["worktree", "add", "-q", "--detach", worktree, "HEAD"]);
    const wt = run(worktree);
    wt(["checkout", "--orphan", HISTORY_BRANCH]);
    // An orphan checkout keeps the index of whatever it branched from, which
    // would commit the entire source tree into the history branch.
    wt(["rm", "-rf", "--cached", "."]);
    wt(["clean", "-qfdx"]);
  }
  return worktree;
}

export type PublishResult = {
  added: number;
  committed: boolean;
  pushed: boolean;
};

/**
 * Copies records into the history branch and commits them.
 *
 * Pushing is opt-in. A backfill of two hundred commits should produce one push,
 * not two hundred.
 */
export function publishHistory(options: {
  repo: string;
  worktree: string;
  /** Directory holding `data/<month>/<sha>.json`. */
  records: string;
  message: string;
  push?: boolean;
}): PublishResult {
  const worktree = checkoutHistory(options.repo, options.worktree);
  const git = run(worktree);

  const source = join(options.records, "data");
  if (!existsSync(source)) return { added: 0, committed: false, pushed: false };
  cpSync(source, join(worktree, "data"), { recursive: true });

  git(["add", "-A", "data"]);
  const staged = git(["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  if (staged.length === 0) {
    return { added: 0, committed: false, pushed: false };
  }

  git(["commit", "-q", "-m", options.message]);

  let pushed = false;
  if (options.push) {
    // Plain push, never forced. A rejected push means someone else measured
    // something; the fix is to fetch and re-run, not to overwrite their data.
    git(["push", "origin", `${HISTORY_BRANCH}:${HISTORY_BRANCH}`]);
    pushed = true;
  }

  return { added: staged.length, committed: true, pushed };
}
