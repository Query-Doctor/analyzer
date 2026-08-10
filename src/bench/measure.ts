import { spawn } from "node:child_process";

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

export async function measureShape<T = unknown>(
  options: MeasureOptions,
): Promise<ShapeMeasurement<T>> {
  const execArgs = options.maxHeapMb
    ? [`--max-old-space-size=${options.maxHeapMb}`]
    : [];

  const started = process.hrtime.bigint();
  const child = spawn(options.command, [...execArgs, ...options.args], {
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

  // A child that ran out of memory never reached its own report, so its cost is
  // only knowable from the outside: it died, and it died big.
  const outcome: ShapeOutcome = timedOut
    ? "timeout"
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
