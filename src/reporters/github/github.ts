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

n.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true });

type CommentState =
  | "all-clear"
  | "optimizations"
  | "regressions"
  | "review-required"
  | "no-baseline";

interface DisplayRecommendation extends ReportIndexRecommendation {
  queryPreview: string;
}

export function formatCost(cost: number): string {
  return Math.round(cost).toLocaleString("en-US");
}

export function queryPreview(formattedQuery: string): string {
  const firstLine = formattedQuery
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 2)
    .join(" ");
  if (firstLine.length > 80) {
    return firstLine.slice(0, 77) + "...";
  }
  return firstLine;
}

function addPreviews(
  recs: ReportIndexRecommendation[],
): DisplayRecommendation[] {
  return recs.map((r) => ({
    ...r,
    queryPreview: queryPreview(r.formattedQuery),
  }));
}

export function buildViewModel(ctx: ReportContext) {
  const hasComparison = !!ctx.comparison;

  if (!hasComparison) {
    return {
      state: "no-baseline" as CommentState,
      displayRecommendations: addPreviews(ctx.recommendations),
      totalRecommendations: ctx.recommendations.length,
      newQueryCount: 0,
      regressedCount: 0,
      disappearedCount: 0,
      hasComparison: false,
    };
  }

  const newQueryHashes = new Set(
    ctx.comparison!.newQueries.map((q) => q.hash),
  );

  const displayRecommendations = addPreviews(
    ctx.recommendations.filter((r) => newQueryHashes.has(r.fingerprint)),
  );
  const preExistingRecommendations = addPreviews(
    ctx.recommendations.filter((r) => !newQueryHashes.has(r.fingerprint)),
  );

  const hasRegressions = ctx.comparison!.regressed.length > 0;
  const hasOptimizations = displayRecommendations.length > 0;

  let state: CommentState;
  if (hasRegressions && hasOptimizations) state = "review-required";
  else if (hasRegressions) state = "regressions";
  else if (hasOptimizations) state = "optimizations";
  else state = "all-clear";

  return {
    state,
    displayRecommendations,
    preExistingRecommendations,
    totalRecommendations: ctx.recommendations.length,
    newQueryCount: ctx.comparison!.newQueries.length,
    regressedCount: ctx.comparison!.regressed.length,
    disappearedCount: ctx.comparison!.disappearedHashes.length,
    hasComparison: true,
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
    },
  ) {
    return n.renderString(content, reportContext);
  }
}
