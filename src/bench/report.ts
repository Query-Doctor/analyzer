import { comparePaired, type PairedComparison } from "./stats.ts";
import type { ShapeMeasurement } from "./measure.ts";

/**
 * Turns two runs into something a reader can act on.
 *
 * Timings get the paired test, because there are as many pairs as there are
 * queries. Memory and processor time are single readings per run, so they are
 * reported as they are, with a delta and no claim of significance. Saying "8%
 * more memory, one sample" is honest; running a hypothesis test on n=1 is not.
 *
 * A shape that ran out of memory or ran out of time is the headline. It is not
 * a missing row in a table of percentages, and it is never averaged with the
 * shapes that finished.
 */

export type ShapePayload = {
  /** Rejects a comparison across a change to the generated work. */
  workloadVersion?: number;
  /** One reading per query, in the same order on both sides. */
  perQueryMs: number[];
  /** Time outside the query loop, keyed by phase. */
  phases?: Record<string, { totalMs: number; calls: number }>;
  /** Exact counts: index permutations built, statements attempted. */
  counts?: Record<string, number>;
};

/**
 * Timings here are bimodal in practice: most queries sit in a fast band and
 * some fall into a slow one, so a median describes the fast band and says
 * nothing about how many landed outside it. The tail is where a change shows
 * up first, and where a user feels it.
 */
export type Percentiles = {
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Total across every query, which is what a run costs end to end. */
  totalMs: number;
};

export function percentiles(values: number[]): Percentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
  };
}

export type ShapeVerdict = {
  shape: string;
  kind: "compared" | "control-only" | "experiment-only" | "did-not-finish";
  timing?: PairedComparison;
  /** Set when either side failed to finish, naming which and how. */
  incident?: string;
  /** Per-query distribution on each side, which the median alone conceals. */
  timings?: { control?: Percentiles; experiment?: Percentiles };
  /** Time outside the query loop, which the per-query series cannot see. */
  phases?: {
    control?: Record<string, { totalMs: number; calls: number }>;
    experiment?: Record<string, { totalMs: number; calls: number }>;
  };
  wallMs?: { control: number; experiment: number };
  cpuMs?: { control?: number; experiment?: number };
  maxRssMb?: { control?: number; experiment?: number };
  counts?: Record<string, { control: number; experiment: number }>;
};

/** Below this, a shape's timings are too few for the test to ever resolve. */
export const MIN_PAIRS_FOR_SIGNIFICANCE = 6;

const percent = (from: number, to: number) =>
  from === 0 ? 0 : ((to - from) / from) * 100;

function pairCounts(
  control: ShapePayload | undefined,
  experiment: ShapePayload | undefined,
) {
  const keys = new Set([
    ...Object.keys(control?.counts ?? {}),
    ...Object.keys(experiment?.counts ?? {}),
  ]);
  if (keys.size === 0) return undefined;
  const paired: Record<string, { control: number; experiment: number }> = {};
  for (const key of keys) {
    paired[key] = {
      control: control?.counts?.[key] ?? 0,
      experiment: experiment?.counts?.[key] ?? 0,
    };
  }
  return paired;
}

export function compareRuns(
  control: ShapeMeasurement<ShapePayload>[],
  experiment: ShapeMeasurement<ShapePayload>[],
): ShapeVerdict[] {
  const byShape = new Map<
    string,
    {
      control?: ShapeMeasurement<ShapePayload>;
      experiment?: ShapeMeasurement<ShapePayload>;
    }
  >();
  for (const measurement of control) {
    byShape.set(measurement.shape, {
      ...byShape.get(measurement.shape),
      control: measurement,
    });
  }
  for (const measurement of experiment) {
    byShape.set(measurement.shape, {
      ...byShape.get(measurement.shape),
      experiment: measurement,
    });
  }

  const verdicts: ShapeVerdict[] = [];
  for (const [shape, { control: a, experiment: b }] of byShape) {
    if (!a) {
      verdicts.push({ shape, kind: "experiment-only" });
      continue;
    }
    if (!b) {
      verdicts.push({ shape, kind: "control-only" });
      continue;
    }

    const resources = {
      timings: {
        control: percentiles(a.payload?.perQueryMs ?? []),
        experiment: percentiles(b.payload?.perQueryMs ?? []),
      },
      phases: { control: a.payload?.phases, experiment: b.payload?.phases },
      wallMs: { control: a.wallMs, experiment: b.wallMs },
      cpuMs: { control: a.cpuMs, experiment: b.cpuMs },
      maxRssMb: { control: a.maxRssMb, experiment: b.maxRssMb },
      counts: pairCounts(a.payload, b.payload),
    };

    if (a.outcome !== "ok" || b.outcome !== "ok") {
      const which =
        a.outcome !== "ok" && b.outcome !== "ok"
          ? `both sides ${a.outcome}`
          : a.outcome !== "ok"
            ? `control ${a.outcome}`
            : `experiment ${b.outcome}`;
      verdicts.push({
        shape,
        kind: "did-not-finish",
        incident: which,
        ...resources,
      });
      continue;
    }

    // A workload change alters the work itself, so a delta across one measures
    // the generator rather than the analyzer.
    if (
      a.payload?.workloadVersion !== undefined &&
      b.payload?.workloadVersion !== undefined &&
      a.payload.workloadVersion !== b.payload.workloadVersion
    ) {
      verdicts.push({
        shape,
        kind: "did-not-finish",
        incident: `workload version differs (${a.payload.workloadVersion} vs ${b.payload.workloadVersion}), not comparable`,
        ...resources,
      });
      continue;
    }

    const controlTimings = a.payload?.perQueryMs ?? [];
    const experimentTimings = b.payload?.perQueryMs ?? [];
    // Pairing only means anything while the two runs cover the same queries in
    // the same order. Different lengths mean the shapes are not comparable, and
    // silently truncating would produce a confident number about nothing.
    const timing =
      controlTimings.length > 0 &&
      controlTimings.length === experimentTimings.length
        ? comparePaired(controlTimings, experimentTimings)
        : undefined;

    verdicts.push({ shape, kind: "compared", timing, ...resources });
  }
  return verdicts;
}

const fixed = (value: number | undefined, digits = 1) =>
  value === undefined ? "—" : value.toFixed(digits);

const signed = (value: number, digits = 1) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

function timingCell(verdict: ShapeVerdict): string {
  const timing = verdict.timing;
  if (!timing) return "—";
  if (timing.n === 0) return "no query moved";
  const change = `${signed(timing.percentChange)}% (${signed(timing.medianDifference, 2)} ms)`;
  if (timing.n < MIN_PAIRS_FOR_SIGNIFICANCE) {
    return `${change}, ${timing.n} pairs — too few to resolve`;
  }
  return `${change}, p=${timing.p.toFixed(4)}`;
}

export function renderReport(verdicts: ShapeVerdict[]): string {
  const lines: string[] = [];

  const incidents = verdicts.filter((v) => v.kind === "did-not-finish");
  if (incidents.length > 0) {
    lines.push("**Did not finish**");
    lines.push("");
    for (const verdict of incidents) {
      const rss = verdict.maxRssMb?.experiment ?? verdict.maxRssMb?.control;
      const at = rss ? `, last seen at ${fixed(rss, 0)} MiB` : "";
      lines.push(`- \`${verdict.shape}\` — ${verdict.incident}${at}`);
    }
    lines.push("");
  }

  const compared = verdicts.filter((v) => v.kind === "compared");
  if (compared.length > 0) {
    lines.push("| Shape | Time per query | CPU | Peak memory |");
    lines.push("| --- | --- | --- | --- |");
    for (const verdict of compared) {
      const cpu =
        verdict.cpuMs?.control !== undefined &&
        verdict.cpuMs?.experiment !== undefined
          ? `${signed(percent(verdict.cpuMs.control, verdict.cpuMs.experiment))}% (${fixed(verdict.cpuMs.experiment, 0)} ms)`
          : "—";
      const rss =
        verdict.maxRssMb?.control !== undefined &&
        verdict.maxRssMb?.experiment !== undefined
          ? `${signed(percent(verdict.maxRssMb.control, verdict.maxRssMb.experiment))}% (${fixed(verdict.maxRssMb.experiment, 0)} MiB)`
          : "—";
      lines.push(
        `| \`${verdict.shape}\` | ${timingCell(verdict)} | ${cpu} | ${rss} |`,
      );
    }
    lines.push("");
  }

  const withTimings = compared.filter(
    (verdict) => verdict.timings?.control && verdict.timings?.experiment,
  );
  if (withTimings.length > 0) {
    lines.push("**Per-query distribution**");
    lines.push("");
    lines.push("| Shape | | min | p50 | p90 | p99 | max | total |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const verdict of withTimings) {
      for (const side of ["control", "experiment"] as const) {
        const p = verdict.timings![side]!;
        lines.push(
          `| \`${verdict.shape}\` | ${side} | ${fixed(p.min)} | ${fixed(p.p50)} | ${fixed(p.p90)} | ${fixed(p.p99)} | ${fixed(p.max)} | ${fixed(p.totalMs, 0)} ms |`,
        );
      }
    }
    lines.push("");
  }

  const phaseRows = compared.flatMap((verdict) => {
    const keys = new Set([
      ...Object.keys(verdict.phases?.control ?? {}),
      ...Object.keys(verdict.phases?.experiment ?? {}),
    ]);
    return [...keys].map((name) => {
      const c = verdict.phases?.control?.[name];
      const e = verdict.phases?.experiment?.[name];
      const delta =
        c && e ? `${signed(percent(c.totalMs, e.totalMs))}%` : "—";
      return `| \`${verdict.shape}\` | ${name} | ${fixed(c?.totalMs, 0)} ms | ${fixed(e?.totalMs, 0)} ms | ${delta} | ${e?.calls ?? c?.calls ?? "—"} |`;
    });
  });
  if (phaseRows.length > 0) {
    lines.push("**Outside the query loop**");
    lines.push("");
    lines.push("| Shape | Phase | Control | Experiment | Δ | Calls |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    lines.push(...phaseRows);
    lines.push("");
  }

  const countRows = compared.flatMap((verdict) =>
    Object.entries(verdict.counts ?? {})
      .filter(([, { control, experiment }]) => control !== experiment)
      .map(
        ([name, { control, experiment }]) =>
          `| \`${verdict.shape}\` | ${name} | ${control.toLocaleString()} | ${experiment.toLocaleString()} |`,
      ),
  );
  if (countRows.length > 0) {
    // Counts are exact and identical on every machine, so a change here is a
    // fact rather than a measurement, and it usually explains the timings above.
    lines.push("**Counts that changed**");
    lines.push("");
    lines.push("| Shape | Count | Control | Experiment |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(...countRows);
    lines.push("");
  }

  const onlyOneSide = verdicts.filter(
    (v) => v.kind === "control-only" || v.kind === "experiment-only",
  );
  for (const verdict of onlyOneSide) {
    const side = verdict.kind === "control-only" ? "control" : "experiment";
    lines.push(`- \`${verdict.shape}\` ran on the ${side} only.`);
  }

  if (lines.length === 0) return "No shapes ran.";
  return lines.join("\n").trim();
}
