import * as github from "@actions/github";
import * as core from "@actions/core"
import success from "./success.md.j2" with { type: "text" };
import * as n from "nunjucks";
import {
  isQueryLong,
  renderExplain,
  ReportContext,
  Reporter,
} from "../reporter.ts";

n.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true });

export class GithubReporter implements Reporter {
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
    const output = this.renderToMd(success, {
      ...ctx,
      isQueryLong: isQueryLong,
      renderExplain: renderExplain,
    });
    return this.createReview(output, existingReview);
  }

  private async findExistingReview() {
    if (
      typeof this.octokit === "undefined" ||
      typeof this.prNumber === "undefined"
    ) {
      console.log("No GitHub token or PR number provided, review will not be created", this.prNumber);
      return;
    }
    try {
      const reviews = await this.octokit.rest.pulls.listReviews({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: this.prNumber,
      });
      return reviews.data.find(
        (r) => r.body && r.body.startsWith(GithubReporter.REVIEW_COMMENT_PREFIX),
      );
    } catch (err) {
      console.error(err);
      return;
    }
  }

  private async createReview(review: string, existingReview?: { id: number }) {
    if (
      typeof this.octokit === "undefined" ||
      typeof this.prNumber === "undefined"
    ) {
      console.log("No GitHub token or PR number provided, review will not be created", this.prNumber);
      if (this.isInGithubActions) {
        await core.summary.addRaw(review, true).write();
      }
      return;
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
