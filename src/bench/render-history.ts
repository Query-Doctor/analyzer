import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecords } from "./history.ts";
import { shapeNames } from "./series.ts";

/**
 * Renders the history as one self-contained HTML file.
 *
 *   node --import tsx src/bench/render-history.ts --root=.bench-history
 *
 * No chart library and no network. The records are inlined and drawn as SVG by
 * a few lines of vanilla script, so the file can be opened from disk, mailed,
 * or attached to a CI run and still work in a year.
 */

const PAGE = (data: string, shapes: string[]) => `<!doctype html>
<meta charset="utf-8">
<title>Analyzer benchmark history</title>
<style>
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #111; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; }
  .controls { display: flex; gap: 1rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; }
  select, button { font: inherit; padding: .25rem .5rem; }
  button[aria-pressed="true"] { background: #111; color: #fff; }
  .chart { margin-bottom: 2rem; }
  .chart h2 { font-size: .85rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 0 0 .25rem; }
  svg { width: 100%; height: 180px; overflow: visible; }
  .line { fill: none; stroke: #2563eb; stroke-width: 1.5; }
  .dot { fill: #2563eb; }
  .dot.bad { fill: #dc2626; }
  .dot.resolved { fill: #d97706; }
  .axis { stroke: #ddd; }
  .label { font-size: 10px; fill: #666; }
  .note { color: #666; font-size: 12px; }
  .break { stroke: #999; stroke-dasharray: 3 3; }
</style>
<h1>Analyzer benchmark history</h1>
<div class="controls">
  <label>Shape <select id="shape">${shapes.map((s) => `<option>${s}</option>`).join("")}</select></label>
  <span>
    <button data-months="1">1 month</button>
    <button data-months="6" aria-pressed="true">6 months</button>
    <button data-months="120">All</button>
  </span>
  <span class="note">Dashed line: the instrument changed, so the points either side are not comparable. Red: did not finish. Amber: dependencies resolved, not locked.</span>
</div>
<div id="charts"></div>
<script>
const RECORDS = ${data};
const METRICS = [
  ["p50", "per-query p50 (ms)"], ["p90", "per-query p90 (ms)"], ["p99", "per-query p99 (ms)"],
  ["wallMs", "wall clock (ms)"], ["cpuMs", "cpu (ms)"], ["maxRssMb", "peak memory (MiB)"],
  ["vacuumMs", "vacuum (ms)"],
];
let months = 6;

const valueOf = (rec, shape, metric) => {
  const s = rec.shapes.find((x) => x.shape === shape);
  if (!s) return null;
  if (metric === "p50" || metric === "p90" || metric === "p99") return s.timings ? s.timings[metric] : null;
  if (metric === "vacuumMs") return s.phases && s.phases.vacuum ? s.phases.vacuum.totalMs : null;
  return s[metric] ?? null;
};

function inWindow(records) {
  if (!records.length) return records;
  const newest = new Date(records[records.length - 1].committedAt);
  const cutoff = new Date(newest);
  cutoff.setMonth(cutoff.getMonth() - months);
  return records.filter((r) => new Date(r.committedAt) >= cutoff);
}

function draw() {
  const shape = document.getElementById("shape").value;
  const records = inWindow(RECORDS.filter((r) => r.shapes.some((s) => s.shape === shape)));
  const charts = document.getElementById("charts");
  charts.innerHTML = "";
  if (!records.length) { charts.textContent = "No records in this window."; return; }

  const W = 900, H = 180, PAD = 34;
  const t0 = new Date(records[0].committedAt).getTime();
  const t1 = new Date(records[records.length - 1].committedAt).getTime();
  const x = (r) => PAD + (t1 === t0 ? 0.5 : (new Date(r.committedAt).getTime() - t0) / (t1 - t0)) * (W - PAD * 2);

  for (const [metric, title] of METRICS) {
    const values = records.map((r) => valueOf(r, shape, metric)).filter((v) => v != null);
    if (!values.length) continue;
    const max = Math.max(...values), min = Math.min(0, ...values);
    const y = (v) => H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);

    // A new path wherever the harness or workload version changed.
    let paths = [], current = [], key = null;
    for (const r of records) {
      const s = r.shapes.find((x) => x.shape === shape);
      const k = r.harnessVersion + ":" + s.workloadVersion;
      if (key !== null && k !== key) { paths.push(current); current = []; }
      key = k;
      const v = valueOf(r, shape, metric);
      if (v != null) current.push([x(r), y(v)]);
    }
    paths.push(current);

    const dots = records.map((r) => {
      const s = r.shapes.find((x) => x.shape === shape);
      const v = valueOf(r, shape, metric);
      const cls = s.outcome !== "ok" ? "dot bad" : r.env.dependenciesResolved ? "dot resolved" : "dot";
      const cy = v == null ? H - PAD : y(v);
      const label = r.commit.slice(0, 8) + " " + r.committedAt.slice(0, 10) + " — " + r.subject +
        (v == null ? " (" + s.outcome + ")" : " — " + v.toFixed(1));
      return '<circle class="' + cls + '" cx="' + x(r) + '" cy="' + cy + '" r="3"><title>' +
        label.replace(/[<>&]/g, "") + "</title></circle>";
    }).join("");

    const breaks = paths.slice(0, -1).map((p) => {
      const last = p[p.length - 1];
      return last ? '<line class="break" x1="' + last[0] + '" y1="' + PAD + '" x2="' + last[0] + '" y2="' + (H - PAD) + '"/>' : "";
    }).join("");

    charts.insertAdjacentHTML("beforeend",
      '<div class="chart"><h2>' + title + '</h2><svg viewBox="0 0 ' + W + " " + H + '">' +
      '<line class="axis" x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '"/>' +
      '<text class="label" x="0" y="' + (PAD + 4) + '">' + max.toFixed(0) + "</text>" +
      '<text class="label" x="0" y="' + (H - PAD + 4) + '">' + min.toFixed(0) + "</text>" +
      breaks +
      paths.map((p) => p.length > 1 ? '<path class="line" d="M' + p.map((q) => q.join(",")).join("L") + '"/>' : "").join("") +
      dots + "</svg></div>");
  }
}

document.getElementById("shape").addEventListener("change", draw);
for (const button of document.querySelectorAll("button[data-months]")) {
  button.addEventListener("click", () => {
    months = Number(button.dataset.months);
    for (const b of document.querySelectorAll("button[data-months]")) {
      b.setAttribute("aria-pressed", String(b === button));
    }
    draw();
  });
}
draw();
</script>
`;

function main() {
  const argv = process.argv.slice(2);
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const root = get("root") ?? join(process.cwd(), ".bench-history");
  const out = get("out") ?? join(root, "index.html");

  const records = readRecords(root);
  if (records.length === 0) {
    console.error(`No records under ${root}`);
    process.exit(1);
  }
  writeFileSync(out, PAGE(JSON.stringify(records), shapeNames(records)));
  console.error(
    `${records.length} record(s), ${records[0].committedAt.slice(0, 10)} to ${records[records.length - 1].committedAt.slice(0, 10)} -> ${out}`,
  );
}

main();
