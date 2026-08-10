import { execFileSync, spawn } from "node:child_process";

/**
 * Runs one benchmark shape in its own process and records what it cost.
 *
 * A child process rather than an in-process timer, for three reasons. It gives
 * an isolated heap, so one shape's garbage cannot be charged to the next. It
 * makes `maxRSS` mean something, because the number is the peak of that shape
 * alone. And it makes running out of memory a result rather than the end of the
 * run: the parent survives, records which shape died and at what size, and goes
 * on to the rest.
 */

/** Written by the child on its last line so the parent can find it in stdout. */
export const RESULT_SENTINEL = "__bench_result__";

export type ShapeOutcome =
  | "ok"
  /** The process was killed, almost always by the kernel for exceeding memory. */
  | "killed"
  /** It ran, and failed. */
  | "failed"
  /** It ran past the time it was given. */
  | "timeout";

export type ShapeMeasurement<T = unknown> = {
  shape: string;
  outcome: ShapeOutcome;
  /** Elapsed time, as a caller experiences it. */
  wallMs: number;
  /**
   * Processor time actually consumed, user plus system. Much steadier than
   * wall clock on a shared or thermally-throttled machine, because it does not
   * count time spent waiting for Postgres or for another process to yield.
   */
  cpuMs?: number;
  /** Peak resident memory, in mebibytes. Absent when the child was killed. */
  maxRssMb?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Whatever the shape itself reported: per-query timings, counts. */
  payload?: T;
  /** Present when the shape failed, for the report to quote. */
  stderr?: string;
};

/**
 * Runs the child inside a container instead of on the host.
 *
 * The point is a fixed ceiling. `--max-old-space-size` bounds only the V8 heap,
 * so a shape whose growth is in buffers runs past it and exhausts the machine;
 * a cgroup limit holds for every kind of allocation, and the kernel reports the
 * kill. That makes running out of memory reproducible rather than a function of
 * whichever machine happened to run it.
 *
 * The image is pinned by digest because a tag moves, and two runs months apart
 * have to agree about what they were measuring.
 */
export type ContainerOptions = {
  image: string;
  memoryMb: number;
  cpus?: number;
  /** Physical cores to pin to, e.g. "0-3", so another shape cannot steal them. */
  cpuset?: string;
  /** Paths mounted read-write, as host:container pairs. */
  mounts?: Array<{ host: string; container: string }>;
  workdir?: string;
};

export type MeasureOptions = {
  shape: string;
  command: string;
  args: string[];
  /** Killed after this long, and recorded as a timeout rather than a hang. */
  timeoutMs?: number;
  /**
   * Heap ceiling for the child, in mebibytes. Set it deliberately: a fixed
   * ceiling makes running out of memory reproducible instead of a function of
   * whichever machine happened to run it.
   *
   * It bounds the V8 heap and nothing else. `Buffer` and `ArrayBuffer` allocate
   * outside that heap and run straight past this flag, so a shape whose growth
   * is in buffers will exhaust the machine rather than trip the ceiling. Give
   * the container a `--memory` cap as well; that one holds for every kind of
   * allocation.
   */
  maxHeapMb?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Run in a container rather than on the host. */
  container?: ContainerOptions;
};

/** What a child writes on its final line. */
export type ChildReport<T = unknown> = {
  payload: T;
  cpuMs: number;
  maxRssMb: number;
};

/**
 * Emitted by the child at the end of its run. `process.resourceUsage()` reports
 * `maxRSS` in kibibytes on Linux and macOS, and processor times in microseconds.
 */
export function reportFromChild<T>(payload: T): string {
  const usage = process.resourceUsage();
  const report: ChildReport<T> = {
    payload,
    cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
    maxRssMb: usage.maxRSS / 1024,
  };
  return `${RESULT_SENTINEL}${JSON.stringify(report)}`;
}

function parseChildReport<T>(stdout: string): ChildReport<T> | undefined {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_SENTINEL));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_SENTINEL.length)) as ChildReport<T>;
  } catch {
    return undefined;
  }
}

/** A name the parent can inspect after the container exits. */
const containerName = (shape: string, nonce: number) =>
  `qd-bench-${shape.replace(/\W/g, "-")}-${nonce}`;

function dockerCommand(
  options: MeasureOptions,
  name: string,
  inner: string[],
): { command: string; args: string[] } {
  const c = options.container!;
  const args = [
    "run",
    "--name",
    name,
    // Not --rm: the container has to survive long enough to be inspected for
    // the out-of-memory flag, which is the whole reason for running in one.
    `--memory=${c.memoryMb}m`,
    // Equal to --memory so swap cannot mask a leak as merely slow.
    `--memory-swap=${c.memoryMb}m`,
  ];
  if (c.cpus) args.push(`--cpus=${c.cpus}`);
  if (c.cpuset) args.push(`--cpuset-cpus=${c.cpuset}`);
  for (const mount of c.mounts ?? []) {
    args.push("-v", `${mount.host}:${mount.container}`);
  }
  if (c.workdir) args.push("-w", c.workdir);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) args.push("-e", `${key}=${value}`);
  }
  args.push(c.image, ...inner);
  return { command: "docker", args };
}

/** Docker's own account of how the container ended. */
function inspectContainer(name: string): { oomKilled: boolean } | undefined {
  try {
    const raw = execFileSync(
      "docker",
      ["inspect", "--format", "{{.State.OOMKilled}}", name],
      { encoding: "utf8" },
    ).trim();
    return { oomKilled: raw === "true" };
  } catch {
    return undefined;
  }
}

export async function measureShape<T = unknown>(
  options: MeasureOptions,
): Promise<ShapeMeasurement<T>> {
  const execArgs = options.maxHeapMb
    ? [`--max-old-space-size=${options.maxHeapMb}`]
    : [];

  const inner = [options.command, ...execArgs, ...options.args];
  const name = containerName(options.shape, process.pid);
  const launch = options.container
    ? dockerCommand(options, name, inner)
    : { command: options.command, args: [...execArgs, ...options.args] };

  const started = process.hrtime.bigint();
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs)
    : undefined;

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (timer) clearTimeout(timer);

  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const report = parseChildReport<T>(stdout);

  // Asked before the container is removed, and it is the one signal a child
  // that ran out of memory could never report for itself.
  const inspected = options.container ? inspectContainer(name) : undefined;
  if (options.container) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  }

  // A child that ran out of memory never reached its own report, so its cost is
  // only knowable from the outside: it died, and it died big.
  const outcome: ShapeOutcome = timedOut
    ? "timeout"
    : inspected?.oomKilled
      ? "killed"
      : signal !== null
        ? "killed"
        : code === 0 && report
          ? "ok"
          : "failed";

  return {
    shape: options.shape,
    outcome,
    wallMs,
    cpuMs: report?.cpuMs,
    maxRssMb: report?.maxRssMb,
    exitCode: code,
    signal,
    payload: report?.payload,
    stderr: outcome === "ok" ? undefined : stderr.trim().slice(-2000),
  };
}
