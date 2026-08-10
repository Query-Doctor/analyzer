import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CommitRecord,
  HARNESS_VERSION,
  currentEnv,
  lockfileKey,
  toShapeRecord,
  writeRecord,
} from "./history.ts";
import { measureShape } from "./measure.ts";
import type { ShapePayload } from "./report.ts";

/**
 * Measures a series of commits into the history.
 *
 *   node --import tsx src/bench/bench-history.ts --commits=abc123,def456
 *   node --import tsx src/bench/bench-history.ts --since=2026-07-01 --every=7
 *
 * Every commit is measured by the bench files from the working tree, copied
 * onto its checkout. What varies is the analyzer and its dependencies.
 *
 * Commits are walked along `--first-parent` and dated by committer, not author.
 * Author dates are the order work was written, which is not the order it
 * landed: two commits here were authored eleven days before they merged. A
 * series built on author dates puts points in the wrong place, and can compare
 * two commits where neither is an ancestor of the other.
 */

const SHAPES = [
  { shape: "breadth", tables: 20, queries: 100 },
] as const;

const PG_IMAGE = "postgres:17";
const CACHE = join(homedir(), ".cache", "qd-bench", "node_modules");

type Args = {
  commits?: string[];
  since?: string;
  every: number;
  root: string;
  worktrees: string;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    commits: get("commits")?.split(","),
    since: get("since"),
    every: Number(get("every") ?? 1),
    root: get("root") ?? join(process.cwd(), ".bench-history"),
    worktrees: get("worktrees") ?? join(process.cwd(), ".bench-worktrees"),
  };
}

const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

/** Commits along first-parent, oldest first, sampled every `every`th. */
function selectCommits(args: Args): string[] {
  if (args.commits) return args.commits;
  const range = args.since ? [`--since=${args.since}`] : ["-n", "50"];
  const all = git(["log", "--first-parent", "--reverse", "--format=%H", ...range])
    .split("\n")
    .filter(Boolean);
  return all.filter((_, index) => index % args.every === 0);
}

/**
 * A checkout with dependencies. Installs are keyed by lockfile, not by commit,
 * so a run over two hundred commits installs once per distinct lockfile.
 */
function prepare(
  commit: string,
  worktreeRoot: string,
): { path: string; resolved: boolean } {
  const path = join(worktreeRoot, commit.slice(0, 12));
  if (!existsSync(path)) {
    mkdirSync(worktreeRoot, { recursive: true });
    git(["worktree", "add", "-q", "--detach", path, commit]);
  }

  // The same instrument on every commit.
  mkdirSync(join(path, "src", "bench"), { recursive: true });
  cpSync(join(process.cwd(), "src", "bench"), join(path, "src", "bench"), {
    recursive: true,
  });

  if (existsSync(join(path, "node_modules"))) return { path, resolved: false };

  const key = lockfileKey(readFileSync(join(path, "package-lock.json"), "utf8"));
  const cached = join(CACHE, key);
  if (existsSync(cached)) {
    cpSync(cached, join(path, "node_modules"), { recursive: true });
    return { path, resolved: false };
  }

  let resolved = false;
  try {
    execFileSync("npm", ["ci", "--silent"], { cwd: path, stdio: "ignore" });
  } catch {
    // Some commits shipped a lockfile that does not match their manifest, and
    // `npm ci` refuses those outright. Resolving gives the tree the commit
    // meant rather than the one it recorded, which is worth having as long as
    // the record says the point is not reproducible.
    execFileSync("npm", ["install", "--silent"], { cwd: path, stdio: "ignore" });
    resolved = true;
  }
  mkdirSync(CACHE, { recursive: true });
  cpSync(join(path, "node_modules"), cached, { recursive: true });
  return { path, resolved };
}

async function measureCommit(
  commit: string,
  args: Args,
): Promise<CommitRecord | undefined> {
  const committedAt = git(["show", "-s", "--format=%cI", commit]);
  const subject = git(["show", "-s", "--format=%s", commit]);

  let prepared: { path: string; resolved: boolean };
  try {
    prepared = prepare(commit, args.worktrees);
  } catch (error) {
    console.error(`${commit.slice(0, 12)}: could not prepare — ${error}`);
    return undefined;
  }

  const shapes = [];
  for (const shape of SHAPES) {
    // One shape at a time. Two at once contend for processor and for Docker,
    // and a contended measurement is worse than a slow one.
    const measurement = await measureShape<ShapePayload>({
      shape: shape.shape,
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        join(prepared.path, "src", "bench", "run-shape.ts"),
        `--shape=${shape.shape}`,
        `--tables=${shape.tables}`,
        `--queries=${shape.queries}`,
        `--image=${PG_IMAGE}`,
      ],
      cwd: prepared.path,
      env: { SOURCE_DATABASE_URL: "postgres://bench@localhost:5432/bench" },
      timeoutMs: 15 * 60_000,
    });
    shapes.push(toShapeRecord(measurement));
    console.error(
      `  ${shape.shape}: ${measurement.outcome} ${(measurement.wallMs / 1000).toFixed(1)}s`,
    );
  }

  return {
    commit,
    committedAt,
    subject,
    harnessVersion: HARNESS_VERSION,
    measuredAt: new Date().toISOString(),
    env: currentEnv(PG_IMAGE, prepared.resolved),
    shapes,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commits = selectCommits(args);
  console.error(`${commits.length} commit(s) to measure`);

  for (const [index, commit] of commits.entries()) {
    const subject = git(["show", "-s", "--format=%s", commit]);
    console.error(
      `[${index + 1}/${commits.length}] ${commit.slice(0, 12)} ${subject}`,
    );
    const record = await measureCommit(commit, args);
    if (record) console.error(`  -> ${writeRecord(args.root, record)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
