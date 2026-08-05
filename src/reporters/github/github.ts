import * as github from "@actions/github";
import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const success = readFileSync(join(__dirname, "success.md.j2"), "utf-8");
import n from "nunjucks";
import { summarizeGates } from "../../gate/evaluate.ts";
import {
  deriveIndexStatistics,
  isQueryLong,
  renderExplain,
  ReportContext,
  ReportIndexRecommendation,
  Reporter,
} from "../reporter.ts";

import type { CiQueryPayload, ImprovedQuery, RegressedQuery } from "../site-api.ts";
import {
  buildNamedSchemaChangeView,
  buildSchemaChangeView,
  schemaChangeLabel,
  type SchemaChangeView,
} from "./schema-change.ts";

n.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true });

// NOTE: The Site API exposes presentation-agnostic `signalKeys` (available in
// the template via `runMetadata.signalKeys`), but we don't render per-signal
// icons yet — the image assets don't exist. Rendering is deferred until the
// Site follow-up that hosts them. See Query-Doctor/Site (analyzer#141 follow-up).

interface DisplayRecommendation extends ReportIndexRecommendation {
  queryPreview: string;
  site?: { name: string; file: string | undefined };
  /** Below the `minimumCost` floor: shown for context, but does not gate the PR. */
  belowThreshold: boolean;
}

interface DisplayRegression extends RegressedQuery {
  queryPreview: string;
  site?: { name: string; file: string | undefined };
}

interface DisplayImprovement extends ImprovedQuery {
  queryPreview: string;
  site?: { name: string; file: string | undefined };
  indexesChanged: boolean;
}

interface DisplayNewQuery {
  hash: string;
  queryPreview: string;
  site?: { name: string; file: string | undefined };
  /** Pre-rendered "cost N" label, or "" when the query has no extractable cost. */
  costLabel: string;
}

/** Matches the cap in Site's `modeledTablesWarning` (mcp-server/src/apply-stats.ts). */
const MODELED_TABLES_SHOWN = 10;

interface ModeledTablesNotice {
  /** Total modeled tables, including any beyond the cap. */
  count: number;
  /** Backticked names, capped, with a trailing "and N more" when truncated. */
  list: string;
}

export function formatCost(cost: number): string {
  return Math.round(cost).toLocaleString("en-US");
}

export function queryPreview(formattedQuery: string): string {
  const preview = formattedQuery
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  if (preview.length > 200) {
    return preview.slice(0, 197) + "...";
  }
  return preview;
}

function addPreviews(
  recs: ReportIndexRecommendation[],
  belowThreshold = false,
): DisplayRecommendation[] {
  return recs.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
    site: callSite((r as { tags?: { key: string; value: string }[] }).tags),
    belowThreshold,
  }));
}

function addRegressionPreviews(
  regressions: RegressedQuery[],
): DisplayRegression[] {
  return regressions.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
    site: callSite(r.tags),
  }));
}

function indexesChanged(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return !sortedA.every((v, i) => v === sortedB[i]);
}

function addImprovementPreviews(
  improvements: ImprovedQuery[],
): DisplayImprovement[] {
  return improvements.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
    indexesChanged: indexesChanged(r.previousIndexes, r.currentIndexes),
  }));
}

function newQueryCost(q: CiQueryPayload): number | null {
  if (q.optimization.state === "improvements_available") return q.optimization.cost;
  if (q.optimization.state === "no_improvement_found") return q.optimization.cost;
  return null;
}

function addNewQueryPreviews(newQueries: CiQueryPayload[]): DisplayNewQuery[] {
  return newQueries.map((q) => {
    const cost = newQueryCost(q);
    return {
      hash: q.hash,
      queryPreview: queryPreview(q.formattedQuery),
      costLabel: cost === null ? "" : `cost ${formatCost(cost)}`,
    };
  });
}

/** Per-query detail links keyed by query hash, sourced from the run metadata. */
function buildQueryLinks(ctx: ReportContext): Record<string, string> {
  const links: Record<string, string> = {};
  for (const q of ctx.runMetadata?.queries ?? []) {
    links[q.hash] = q.link;
  }
  return links;
}

/**
 * Schema delta between this PR and the comparison baseline, sourced from the run
 * metadata. Absent when the API predates the field or couldn't resolve the
 * baseline schema (`null`), and empty when the schema is unchanged — all collapse
 * to a non-rendering view so the template stays a single `if hasChanges` guard.
 */
function buildSchemaChange(ctx: ReportContext): SchemaChangeView {
  const change = ctx.runMetadata?.schemaChange;
  if (!change || !change.changed) {
    return { hasChanges: false, total: 0, groups: [] };
  }
  // The API names each changed object; a patch path indexes a baseline schema
  // this process never holds, so it can only be read positionally. Prefer the
  // names whenever the API sends them, and fall back to the patch for an API
  // that predates the field.
  return change.changes
    ? buildNamedSchemaChangeView(change.changes)
    : buildSchemaChangeView(change.operations);
}

/**
 * Caveat for tables the production snapshot never saw: the synthesizer estimated
 * their row counts, so costs touching them are modeled rather than measured. The
 * cap and phrasing mirror `modeledTablesWarning` in Site's mcp-server so the CI
 * comment and the MCP tools tell a developer the same thing.
 *
 * Named `modeledTablesNotice`, not `modeledTables`: the reporter renders with
 * `{...ctx, ...viewModel}`, and reusing the key would shadow `ctx.modeledTables`
 * with a different shape — correct only for as long as the spread order holds.
 */
function buildModeledTablesNotice(
  ctx: ReportContext,
): ModeledTablesNotice | null {
  const tables = ctx.modeledTables ?? [];
  if (tables.length === 0) return null;
  const shown = tables.slice(0, MODELED_TABLES_SHOWN);
  const rest = tables.length - shown.length;
  const names = shown.map((t) => `\`${t}\``).join(", ");
  return {
    count: tables.length,
    list: rest > 0 ? `${names}, and ${rest} more` : names,
  };
}


/**
 * Name a query by where it is written, from its SQLCommenter tags. The stored
 * preview truncates at the column list, so a hash is otherwise the only handle a
 * reader gets. `file` arrives absolute from the CI runner, so it is trimmed to a
 * repo-relative path. Returns undefined when the run carries no tags at all.
 */
export function callSite(
  tags: { key: string; value: string }[] | undefined,
): { name: string; file: string | undefined } | undefined {
  const get = (key: string) => tags?.find((t) => t.key === key)?.value;
  const funcName = get("func_name");
  const raw = get("file");
  const file = raw?.includes("/Site/")
    ? raw.slice(raw.lastIndexOf("/Site/") + "/Site/".length)
    : raw;
  if (!funcName && !file) return undefined;
  return funcName ? { name: funcName, file } : { name: file!, file: undefined };
}

export function buildViewModel(ctx: ReportContext) {
  const hasComparison = !!ctx.comparison;
  const queryLinks = buildQueryLinks(ctx);
  const schemaChange = buildSchemaChange(ctx);
  const modeledTablesNotice = buildModeledTablesNotice(ctx);
  // The roster the comment leads with. Derived from the same array the check
  // annotations read, so the heading cannot contradict the check (ADR-0009).
  const gateSummary = ctx.gates ? summarizeGates(ctx.gates) : undefined;
  // Failing first: the reader's question is what is blocking them, and the
  // roster otherwise reads in catalogue order regardless of what happened.
  const RANK = { failure: 0, neutral: 1, success: 2 } as const;
  const gates = ctx.gates
    ? [...ctx.gates].sort((a, b) => RANK[a.conclusion] - RANK[b.conclusion])
    : undefined;
  // Status glyphs live in this repo; GitHub strips inline <svg>, so they are
  // fetched over HTTP and Camo-proxied into the comment.
  const gateIconBase =
    "https://raw.githubusercontent.com/Query-Doctor/analyzer/main/assets/gate";
  const brandMark =
    "https://raw.githubusercontent.com/Query-Doctor/analyzer/main/assets/brand/mark.svg";

  if (!hasComparison) {
    return {
      displayRecommendations: addPreviews(ctx.recommendations),
      displayRegressed: [] as DisplayRegression[],
      displayAcknowledgedRegressed: [] as DisplayRegression[],
      displayImproved: [] as DisplayImprovement[],
      displayNewQueries: [] as DisplayNewQuery[],
      displayTestOriginExcluded: [] as DisplayNewQuery[],
      preExistingRecommendations: [] as DisplayRecommendation[],
      newQueryCount: 0,
      hasComparison: false,
      queryLinks,
      schemaChange,
      schemaChangeLabel,
      modeledTablesNotice,
      gateSummary,
      gateIconBase,
      brandMark,
      gates,
    };
  }

  const newQueryHashes = new Set(
    ctx.comparison!.newQueries.map((q) => q.hash),
  );
  const recommendedHashes = new Set(
    ctx.recommendations.map((r) => r.fingerprint),
  );
  // New queries whose recommendation is below the cost floor: shown with their
  // fix, marked below-threshold, and NOT gated. Without this they'd fall through
  // to displayNewQueries and be mislabeled "no index suggestion". Scoped to new
  // queries — below-floor recommendations on pre-existing queries stay hidden.
  const belowThresholdNewRecs = (ctx.belowThresholdRecommendations ?? []).filter(
    (r) => newQueryHashes.has(r.fingerprint),
  );
  const belowThresholdHashes = new Set(
    belowThresholdNewRecs.map((r) => r.fingerprint),
  );

  const displayRecommendations = [
    ...addPreviews(
      ctx.recommendations.filter((r) => newQueryHashes.has(r.fingerprint)),
    ),
    ...addPreviews(belowThresholdNewRecs, true),
  ];
  const preExistingRecommendations = addPreviews(
    ctx.recommendations.filter((r) => !newQueryHashes.has(r.fingerprint)),
  );

  // New queries that carry no index recommendation are otherwise invisible:
  // counted in the "N new" tally but listed nowhere (Site#3287 follow-up). The
  // ones that DO have a recommendation already render under "introduces queries
  // with recommendations" (gated above the floor, below-threshold below it), so
  // exclude both here to avoid double-listing.
  const displayNewQueries = addNewQueryPreviews(
    ctx.comparison!.newQueries.filter(
      (q) => !recommendedHashes.has(q.hash) && !belowThresholdHashes.has(q.hash),
    ),
  );

  const displayRegressed = addRegressionPreviews(ctx.comparison!.regressed);
  const displayAcknowledgedRegressed = addRegressionPreviews(ctx.comparison!.acknowledgedRegressed);
  const displayImproved = addImprovementPreviews(ctx.comparison!.improved);
  // Test-origin queries are auto-excluded from the gate (#3199); surface them so
  // the exclusion is auditable rather than silent. They share the new-query
  // preview shape (hash + preview + cost label).
  const displayTestOriginExcluded = addNewQueryPreviews(ctx.comparison!.testOriginExcluded);

  return {
    displayRecommendations,
    displayRegressed,
    displayAcknowledgedRegressed,
    displayImproved,
    displayNewQueries,
    displayTestOriginExcluded,
    preExistingRecommendations,
    newQueryCount: ctx.comparison!.newQueries.length,
    hasComparison: true,
    queryLinks,
    schemaChange,
    schemaChangeLabel,
    modeledTablesNotice,
    gateSummary,
    gateIconBase,
    brandMark,
    gates,
  };
}

export class GithubReporter implements Reporter {
  // This might be much longer https://github.com/dead-claudia/github-limits?tab=readme-ov-file#pr-body
  private static MAX_REVIEW_BODY_LENGTH = 65536;
  private static readonly REVIEW_COMMENT_PREFIX = "<!-- qd-review-comment -->";
  private readonly prNumber?: number;
  private readonly octokit?: ReturnType<typeof github.getOctokit>;
  private readonly isInGithubActions?: boolean;
  constructor(githubToken?: string) {
    this.prNumber = github.context.payload.pull_request?.number;
    this.isInGithubActions = typeof github.context.workflow !== "undefined";
    if (githubToken) {
      this.octokit = github.getOctokit(githubToken);
    } else {
      console.log("No GitHub token provided, review will not be created");
    }
  }

  provider() {
    return "GitHub";
  }

  async report(ctx: ReportContext) {
    const existingReview = await this.findExistingReview();
    // we don't want to create a "something went wrong" review
    // if we can't render properly. Letting this step crash if needed
    const viewModel = buildViewModel(ctx);
    const output = this.renderToMd(success, {
      ...ctx,
      ...viewModel,
      isQueryLong,
      renderExplain,
      formatCost,
    });
    return this.createReview(output, existingReview);
  }

  private async findExistingReview() {
    if (
      typeof this.octokit === "undefined" ||
      typeof this.prNumber === "undefined"
    ) {
      return;
    }
    try {
      const reviews = await this.octokit.rest.pulls.listReviews({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: this.prNumber,
      });
      return reviews.data.find(
        (r) =>
          r.body && r.body.startsWith(GithubReporter.REVIEW_COMMENT_PREFIX),
      );
    } catch (err) {
      console.error(err);
      return;
    }
  }

  private async createReview(review: string, existingReview?: { id: number }) {
    if (this.isInGithubActions) {
      await core.summary.addRaw(review, true).write();
    }
    if (
      typeof this.octokit === "undefined" ||
      typeof this.prNumber === "undefined"
    ) {
      console.log(
        "No GitHub token or PR number provided, review will not be created",
      );
      console.log("\n--- Rendered Report ---\n");
      console.log(review);
      console.log("\n--- End Report ---\n");
      return;
    }
    if (review.length > GithubReporter.MAX_REVIEW_BODY_LENGTH) {
      console.log(
        `Review body is possibly too long? ${review.length} > ${GithubReporter.MAX_REVIEW_BODY_LENGTH}`,
      );
    }
    try {
      if (typeof existingReview === "undefined") {
        await this.octokit.rest.pulls.createReview({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: this.prNumber,
          event: "COMMENT",
          body: GithubReporter.REVIEW_COMMENT_PREFIX + "\n" + review,
        });
      } else {
        await this.octokit.rest.pulls.updateReview({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: this.prNumber,
          review_id: existingReview.id,
          body: GithubReporter.REVIEW_COMMENT_PREFIX + "\n" + review,
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  private renderToMd(
    content: string,
    reportContext: ReportContext & {
      renderExplain: (explainPlan: object) => string;
      isQueryLong: (query: string) => boolean;
      formatCost: (cost: number) => string;
    },
  ) {
    return n.renderString(content, reportContext);
  }
}
