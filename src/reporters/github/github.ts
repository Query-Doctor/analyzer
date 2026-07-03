import * as github from "@actions/github";
import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const success = readFileSync(join(__dirname, "success.md.j2"), "utf-8");
import n from "nunjucks";
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
  buildSchemaChangeView,
  schemaChangeHeading,
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
}

interface DisplayRegression extends RegressedQuery {
  queryPreview: string;
}

interface DisplayImprovement extends ImprovedQuery {
  queryPreview: string;
  indexesChanged: boolean;
}

interface DisplayNewQuery {
  hash: string;
  queryPreview: string;
  /** Pre-rendered "cost N" label, or "" when the query has no extractable cost. */
  costLabel: string;
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
): DisplayRecommendation[] {
  return recs.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
  }));
}

function addRegressionPreviews(
  regressions: RegressedQuery[],
): DisplayRegression[] {
  return regressions.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
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
  return buildSchemaChangeView(change.operations);
}

export function buildViewModel(ctx: ReportContext) {
  const hasComparison = !!ctx.comparison;
  const queryLinks = buildQueryLinks(ctx);
  const schemaChange = buildSchemaChange(ctx);

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
      schemaChangeHeading,
      schemaChangeLabel,
    };
  }

  const newQueryHashes = new Set(
    ctx.comparison!.newQueries.map((q) => q.hash),
  );
  const recommendedHashes = new Set(
    ctx.recommendations.map((r) => r.fingerprint),
  );

  const displayRecommendations = addPreviews(
    ctx.recommendations.filter((r) => newQueryHashes.has(r.fingerprint)),
  );
  const preExistingRecommendations = addPreviews(
    ctx.recommendations.filter((r) => !newQueryHashes.has(r.fingerprint)),
  );

  // New queries that carry no index recommendation are otherwise invisible:
  // counted in the "N new" tally but listed nowhere (Site#3287 follow-up). The
  // ones that DO have a recommendation already render under "introduces queries
  // with recommendations", so exclude them here to avoid double-listing.
  const displayNewQueries = addNewQueryPreviews(
    ctx.comparison!.newQueries.filter((q) => !recommendedHashes.has(q.hash)),
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
    schemaChangeHeading,
    schemaChangeLabel,
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
