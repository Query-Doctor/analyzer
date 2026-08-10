import type { CommitRecord } from "./history.ts";

/**
 * Shapes records into plottable series.
 *
 * The one thing this does that a plain map would not: it breaks the line
 * wherever the instrument changed. A harness or workload version bump means the
 * points either side measured different work, and joining them draws a cliff
 * that looks exactly like a regression. Breaking the line says "these are not
 * comparable" without hiding either half.
 */

export type Metric =
  | "p50"
  | "p90"
  | "p99"
  | "wallMs"
  | "cpuMs"
  | "maxRssMb"
  | "vacuumMs";

export type Point = {
  commit: string;
  committedAt: string;
  subject: string;
  value: number | null;
  /** Set when the shape did not finish. Plotted, never silently dropped. */
  outcome?: string;
  /** The dependency tree was resolved, not locked, so this point is not reproducible. */
  resolved?: boolean;
};

/** Points that share an instrument. A new segment starts where it changed. */
export type Segment = {
  harnessVersion: number;
  workloadVersion?: number;
  points: Point[];
};

function valueOf(
  record: CommitRecord,
  shape: string,
  metric: Metric,
): number | null {
  const found = record.shapes.find((s) => s.shape === shape);
  if (!found) return null;
  switch (metric) {
    case "p50":
    case "p90":
    case "p99":
      return found.timings?.[metric] ?? null;
    case "wallMs":
      return found.wallMs ?? null;
    case "cpuMs":
      return found.cpuMs ?? null;
    case "maxRssMb":
      return found.maxRssMb ?? null;
    case "vacuumMs":
      return found.phases?.vacuum?.totalMs ?? null;
  }
}

export function buildSeries(
  records: CommitRecord[],
  shape: string,
  metric: Metric,
): Segment[] {
  const segments: Segment[] = [];
  for (const record of records) {
    const found = record.shapes.find((s) => s.shape === shape);
    if (!found) continue;

    const harnessVersion = record.harnessVersion;
    const workloadVersion = found.workloadVersion;
    const current = segments[segments.length - 1];
    const sameInstrument =
      current &&
      current.harnessVersion === harnessVersion &&
      current.workloadVersion === workloadVersion;

    const point: Point = {
      commit: record.commit,
      committedAt: record.committedAt,
      subject: record.subject,
      value: valueOf(record, shape, metric),
      ...(found.outcome !== "ok" ? { outcome: found.outcome } : {}),
      ...(record.env.dependenciesResolved ? { resolved: true } : {}),
    };

    if (sameInstrument) current.points.push(point);
    else segments.push({ harnessVersion, workloadVersion, points: [point] });
  }
  return segments;
}

/** Records landed within `months` of the newest one. */
export function withinMonths(
  records: CommitRecord[],
  months: number,
): CommitRecord[] {
  if (records.length === 0) return records;
  const newest = new Date(records[records.length - 1].committedAt);
  const cutoff = new Date(newest);
  cutoff.setMonth(cutoff.getMonth() - months);
  return records.filter((r) => new Date(r.committedAt) >= cutoff);
}

export function shapeNames(records: CommitRecord[]): string[] {
  return [...new Set(records.flatMap((r) => r.shapes.map((s) => s.shape)))].sort();
}
