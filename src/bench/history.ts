import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cpus, totalmem } from "node:os";
import type { ShapeMeasurement } from "./measure.ts";
import { percentiles, type ShapePayload } from "./report.ts";

/**
 * One record per commit, written to the history branch.
 *
 * The fields that matter for reading a graph six months from now are not the
 * measurements. They are `committedAt`, which puts a backfilled point at the
 * commit's place on the axis rather than the day it was measured;
 * `harnessVersion` and `workloadVersion`, which tell a reader where to break
 * the line instead of reading an instrument change as a cliff; and `env`,
 * because the same code on a different machine is a different number.
 */

/** Bumped when the harness changes what or how it measures. */
export const HARNESS_VERSION = 1;

export type Env = {
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memoryGb: number;
  node: string;
  pgImage: string;
  /**
   * True when the tree was resolved with `npm install` because the commit's
   * lockfile did not match its manifest. The dependencies are then what the
   * commit meant, not what it shipped, and the point is not reproducible.
   */
  dependenciesResolved?: boolean;
};

export type ShapeRecord = {
  shape: string;
  outcome: ShapeMeasurement["outcome"];
  workloadVersion?: number;
  wallMs: number;
  cpuMs?: number;
  maxRssMb?: number;
  queries?: number;
  timings?: ReturnType<typeof percentiles>;
  phases?: Record<string, { totalMs: number; calls: number }>;
  counts?: Record<string, number>;
};

export type CommitRecord = {
  commit: string;
  /** Committer date: when it landed, which is the axis a reader wants. */
  committedAt: string;
  subject: string;
  harnessVersion: number;
  measuredAt: string;
  env: Env;
  shapes: ShapeRecord[];
};

export function currentEnv(pgImage: string, resolved?: boolean): Env {
  const cpu = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpu[0]?.model ?? "unknown",
    cores: cpu.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    pgImage,
    ...(resolved ? { dependenciesResolved: true } : {}),
  };
}

export function toShapeRecord(
  measurement: ShapeMeasurement<ShapePayload>,
): ShapeRecord {
  const payload = measurement.payload;
  return {
    shape: measurement.shape,
    outcome: measurement.outcome,
    workloadVersion: payload?.workloadVersion,
    wallMs: measurement.wallMs,
    cpuMs: measurement.cpuMs,
    maxRssMb: measurement.maxRssMb,
    queries: payload?.perQueryMs?.length,
    timings: payload?.perQueryMs && percentiles(payload.perQueryMs),
    phases: payload?.phases,
    counts: payload?.counts,
  };
}

/**
 * One file per commit, under the month it landed.
 *
 * A file each rather than one appended log: a backfill writes hundreds of these
 * in parallel, and appending would make every one of them a merge conflict.
 */
export function recordPath(root: string, record: CommitRecord): string {
  const month = record.committedAt.slice(0, 7);
  return join(root, "data", month, `${record.commit.slice(0, 12)}.json`);
}

export function writeRecord(root: string, record: CommitRecord): string {
  const path = recordPath(root, record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function readRecords(root: string): CommitRecord[] {
  const dataDir = join(root, "data");
  const records: CommitRecord[] = [];
  let months: string[];
  try {
    months = readdirSync(dataDir);
  } catch {
    return records;
  }
  for (const month of months) {
    let files: string[];
    try {
      files = readdirSync(join(dataDir, month));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        records.push(
          JSON.parse(readFileSync(join(dataDir, month, file), "utf8")),
        );
      } catch {
        // A half-written record is skipped rather than taking the read down.
      }
    }
  }
  // Sorted by when the commit landed, not when it was measured, so a backfill
  // run today lands in its own place in the series.
  return records.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
}

/**
 * Identifies a dependency tree. A backfill installs once per distinct tree
 * rather than once per commit, which is the difference between twenty installs
 * and two hundred.
 *
 * Keyed on the manifest as well as the lockfile. Two commits can share a
 * lockfile byte for byte and still want different dependencies, because one of
 * them bumped `package.json` and never regenerated the lock. On the lockfile
 * alone the second gets the first's tree from cache, `npm ci` never runs, and
 * the mismatch that should have been caught is never noticed.
 */
export function dependencyKey(
  lockfileContents: string,
  manifestContents: string,
): string {
  const manifest = JSON.parse(manifestContents) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return createHash("sha256")
    .update(lockfileContents)
    .update(
      JSON.stringify({
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
