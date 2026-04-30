#!/usr/bin/env node
// Compare vitest --outputJson benchmark reports and emit a markdown summary.
// Usage:
//   node scripts/compare-bench.mjs <base.json> <pr.json> [--threshold=<pct>]   (diff mode)
//   node scripts/compare-bench.mjs <pr.json>                                   (current-only mode)
// Exit code 0 unless a benchmark regressed beyond --threshold (default 20%).

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
);

if (positional.length < 1) {
  console.error(
    "usage: compare-bench.mjs <base.json> <pr.json> [--threshold=<pct>]\n" +
      "       compare-bench.mjs <pr.json>",
  );
  process.exit(2);
}

const threshold = Number(flags.threshold ?? 20);
const currentOnly = positional.length === 1;
const [basePath, prPath] = currentOnly ? [null, positional[0]] : positional;

const base = currentOnly ? { files: [] } : JSON.parse(readFileSync(basePath, "utf8"));
const pr = JSON.parse(readFileSync(prPath, "utf8"));

function flatten(report) {
  const out = new Map();
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const b of group.benchmarks ?? []) {
        out.set(`${group.fullName} > ${b.name}`, b);
      }
    }
  }
  return out;
}

const baseMap = flatten(base);
const prMap = flatten(pr);

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n).toLocaleString("en-US")}ms`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function verdict(deltaPct, threshold) {
  if (deltaPct == null || Number.isNaN(deltaPct)) return "🆕";
  if (deltaPct >= threshold) return "🔴";
  if (deltaPct <= -threshold) return "🟢";
  return "⚪";
}

const rows = [];
let regressed = false;

const allKeys = new Set([...baseMap.keys(), ...prMap.keys()]);
for (const key of allKeys) {
  const b = baseMap.get(key);
  const p = prMap.get(key);
  const baseMean = b?.mean;
  const prMean = p?.mean;
  const deltaPct =
    baseMean != null && prMean != null && baseMean > 0
      ? ((prMean - baseMean) / baseMean) * 100
      : null;
  if (deltaPct != null && deltaPct >= threshold) regressed = true;

  rows.push({
    key,
    baseMean,
    prMean,
    baseRme: b?.rme,
    prRme: p?.rme,
    deltaPct,
    verdict: verdict(deltaPct, threshold),
    onlyBase: !p,
    onlyPr: !b,
  });
}

rows.sort((a, b) => a.key.localeCompare(b.key));

const lines = [];
lines.push("### Benchmark comparison");
lines.push("");

if (currentOnly) {
  lines.push("_No baseline available — showing PR results only._");
  lines.push("");
  lines.push("| Benchmark | Mean | RME | Samples |");
  lines.push("|---|---:|---:|---:|");
  for (const r of rows) {
    const samples = prMap.get(r.key)?.sampleCount ?? "—";
    const rme = r.prRme != null ? `±${r.prRme.toFixed(1)}%` : "—";
    lines.push(`| \`${r.key}\` | ${fmtMs(r.prMean)} | ${rme} | ${samples} |`);
  }
} else {
  lines.push(
    `Threshold: ±${threshold}% on mean. 🔴 regression · 🟢 improvement · ⚪ within noise · 🆕 new/removed.`,
  );
  lines.push("");
  lines.push("| | Benchmark | Base mean | PR mean | Δ | RME (base → PR) |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const r of rows) {
    const rme =
      r.baseRme != null && r.prRme != null
        ? `±${r.baseRme.toFixed(1)}% → ±${r.prRme.toFixed(1)}%`
        : "—";
    lines.push(
      `| ${r.verdict} | \`${r.key}\` | ${fmtMs(r.baseMean)} | ${fmtMs(r.prMean)} | ${fmtPct(r.deltaPct)} | ${rme} |`,
    );
  }
}

lines.push("");
lines.push(
  "_Benchmarks use testcontainers + wall-time; some noise is expected. Treat single-digit deltas as not-significant._",
);

process.stdout.write(lines.join("\n") + "\n");

if (regressed) {
  process.exitCode = 1;
}
