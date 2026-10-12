// Render every shape of the PR comment, in light and dark, without a CI run.
//
// The comment is markdown that GitHub sanitises and styles, so rendering it any
// other way tells you nothing: half the constructs we rely on (`<sub>`, `<picture>`,
// `align="absmiddle"`) survive or die by GitHub's rules, and the spacing comes
// from GitHub's own stylesheet. So this posts each fixture to GitHub's `/markdown`
// endpoint and drops the returned HTML into `github-markdown-css`.
//
//   npm run preview        # writes tools/comment-preview/out/index.html
//
// Needs `gh` authenticated. Nothing is posted anywhere — `/markdown` only renders.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import n from "nunjucks";
import { fixtures } from "./fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(here, "out");

const template = readFileSync(join(repoRoot, "src/reporters/github/success.md.j2"), "utf-8");

// Same configuration GithubReporter uses. Whitespace behaviour depends on it, and
// whitespace is most of what this tool exists to show.
n.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true });

function renderMarkdown(markdown: string): string {
  return execFileSync("gh", ["api", "-X", "POST", "/markdown", "--input", "-"], {
    input: JSON.stringify({ mode: "gfm", text: markdown }),
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

mkdirSync(outDir, { recursive: true });

const sections = fixtures.map((fixture, i) => {
  const markdown = n.renderString(template, fixture.view);
  writeFileSync(join(outDir, `${String(i + 1).padStart(2, "0")}-${fixture.name.replace(/[^a-z0-9]+/gi, "-")}.md`), markdown);
  const html = renderMarkdown(markdown);
  return `
    <section id="f${i}">
      <h2>${escape(fixture.name)}</h2>
      <p class="note">${escape(fixture.note)}</p>
      <div class="pair">
        <div class="pane light"><div class="tag">light</div><article class="markdown-body">${html}</article></div>
        <div class="pane dark"><div class="tag">dark</div><article class="markdown-body">${html}</article></div>
      </div>
    </section>`;
});

const light = readFileSync(join(here, "github-markdown-light.css"), "utf-8");
const dark = readFileSync(join(here, "github-markdown-dark.css"), "utf-8");

const nav = fixtures.map((f, i) => `<a href="#f${i}">${escape(f.name)}</a>`).join("");

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>Query Doctor PR comment — every shape</title>
<style>
  /* Both themes on one page: CSS nesting scopes each stylesheet to its pane,
     so the two .markdown-body rulesets never collide. */
  .pane.light { ${light} }
  .pane.dark { ${dark} }
  body { margin: 0; padding: 0 0 80px; background: #f6f8fa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
  nav { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 10px 20px; background: #ffffffee; backdrop-filter: blur(6px); border-bottom: 1px solid #d1d9e0; font-size: 12px; }
  nav a { color: #0969da; text-decoration: none; }
  nav a:hover { text-decoration: underline; }
  section { padding: 28px 20px 0; }
  h2 { font-size: 15px; margin: 0 0 3px; }
  .note { margin: 0 0 12px; font-size: 12.5px; color: #59636e; max-width: 70ch; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  .pane { border-radius: 8px; overflow: hidden; border: 1px solid #d1d9e0; }
  .pane.light { background: #fff; }
  .pane.dark { background: #0d1117; border-color: #3d444d; }
  .tag { font: 400 11px ui-monospace, monospace; padding: 6px 12px; border-bottom: 1px solid #d1d9e0; }
  .pane.light .tag { color: #59636e; }
  .pane.dark .tag { color: #9198a1; border-bottom-color: #3d444d; }
  /* github-markdown-css sets 16px, which is the size for a rendered file, not a
     comment. Comments render at 14px, and every spacing judgement depends on it.
     Matches the nested selector's specificity and comes after it, so it wins. */
  .pane.light .markdown-body, .pane.dark .markdown-body { font-size: 14px; padding: 14px 16px; }
</style>
<nav>${nav}</nav>
${sections.join("\n")}
`,
);

console.log(`${fixtures.length} fixtures → ${join(outDir, "index.html")}`);
