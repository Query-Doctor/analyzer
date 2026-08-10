import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CommitRecord,
  HARNESS_VERSION,
  currentEnv,
  dependencyKey,
  toShapeRecord,
  writeRecord,
} from "./history.ts";
import { measureShape } from "./measure.ts";
import { publishHistory } from "./publish-history.ts";
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

/**
 * `width` is predicates per query, which becomes candidates per table, which
 * the optimizer turns into every ordered subset: 15 index definitions at three
 * candidates, 325 at five, 13,699 at seven.
 *
 * breadth covers the ordinary path. depth-4 reaches the permutation work at
 * 325, which costs about 1.5s a query. Width 6 costs about 5s a query, or two
 * hours across a backfill, so it is run on its own rather than in the series.
 */
const SHAPES = [
  { shape: "breadth", tables: 20, queries: 100 },
  { shape: "depth-4", tables: 4, queries: 8, width: 4 },
] as const;

const PG_IMAGE = "postgres:17";
const CACHE = join(homedir(), ".cache", "qd-bench", "node_modules");

type Args = {
  commits?: string[];
  since?: string;
  every: number;
  root: string;
  worktrees: string;
  publish: boolean;
  push: boolean;
  keepWorktrees: boolean;
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
    publish: argv.includes("--publish"),
    // Pushing once at the end, not once per commit: a backfill of two hundred
    // commits should produce one push.
    push: argv.includes("--push"),
    // A worktree costs ~290MB once node_modules is in it. Seventy of them is
    // twenty gigabytes and seventy entries left registered in the repository,
    // so each is removed once measured. The dependency cache survives, which is
    // the expensive part to rebuild.
    keepWorktrees: argv.includes("--keep-worktrees"),
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

  const key = dependencyKey(
    readFileSync(join(path, "package-lock.json"), "utf8"),
    readFileSync(join(path, "package.json"), "utf8"),
  );
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
  ref: string,
  args: Args,
): Promise<CommitRecord | undefined> {
  // Resolved to the full hash before anything is recorded. A record keyed on
  // whatever abbreviation the caller typed lands in a different file from the
  // same commit named in full, and the series gets two points for one commit.
  const commit = git(["rev-parse", ref]);
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
        ...("width" in shape ? [`--width=${shape.width}`] : []),
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

  if (!args.keepWorktrees) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", prepared.path], {
        stdio: "ignore",
      });
    } catch {
      // Leaving one behind costs disk, not correctness.
    }
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

  if (args.publish) {
    const result = publishHistory({
      repo: process.cwd(),
      worktree: join(args.worktrees, "history"),
      records: args.root,
      message: `bench: ${commits.length} commit(s), harness ${HARNESS_VERSION}`,
      push: args.push,
    });
    console.error(
      result.committed
        ? `published ${result.added} record(s)${result.pushed ? " and pushed" : ""}`
        : "nothing new to publish",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
