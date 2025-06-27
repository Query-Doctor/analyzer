import * as github from "@actions/github";

export class GithubReporter {
  private static readonly REVIEW_COMMENT_SUFFIX = "<!-- qd-review-comment -->";
  prNumber?: number;
  constructor(private readonly githubToken?: string) {
    this.prNumber = github.context.payload.pull_request?.number;
  }

  async report(ctx: ReportContext) {
    if (typeof this.prNumber === "undefined") {
      console.warn(`Not a PR, skipping report...`);
      return;
    }
    if (!this.githubToken) {
      console.warn(`No GitHub token provided, skipping report...`);
      return;
    }
    const octokit = github.getOctokit(this.githubToken);
    // check if a review from us already exists
    const reviews = await octokit.rest.pulls.listReviews({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: this.prNumber,
    });
    const existingReview = reviews.data.find(
      (r) => r.body && r.body.includes(GithubReporter.REVIEW_COMMENT_SUFFIX)
    );
    // use ejs or whatever
    const percentage = (r: ReportIndexRecommendation) =>
      (((r.baseCost - r.optimizedCost) / r.baseCost) * 100).toFixed(2);
    const recommendations = ctx.recommendations.map((r) =>
      [
        `<h2>Optimized query cost (${r.baseCost} -> ${
          r.optimizedCost
        }) by <strong>${percentage(r)}%</strong></h2>`,
        "<h2>Missing indexes</h2>",
        "<ul>",
        r.proposedIndexes
          .map((index) => `<li><code>${index}</code></li>`)
          .join("\n"),
        "</ul>",
        "<details>",
        "<summary>Query</summary>",
        "",
        "```sql",
        r.formattedQuery,
        "```",
        "",
        "</details>",
        "<dl>",
        "<dt>Current cost</dt>",
        `<dd><code>${r.baseCost}</code></dd>`,
        "<dt>Cost with new indexes</dt>",
        `<dd><code>${r.optimizedCost}</code></dd>`,
        "<dt>Existing indexes</dt>",
        `<dd>
        <ul>
        ${r.existingIndexes.map((i) => `<li><code>${i}</code></li>`).join("\n")}
        </ul>
        </dd>`,
        "</dl>",
        "",
      ].join("\n")
    );
    let review: string;
    const metadata = [
      "<details>",
      "<summary>Execution metadata</summary>",
      "<dl>",
      "<dt>Log size</dt>",
      `<dd>${ctx.metadata.logSize} bytes</dd>`,
      "<dt>Time elapsed</dt>",
      `<dd>${ctx.metadata.timeElapsed}ms</dd>`,
      "</dl>",
      "</details>",
    ].join("\n");
    if (recommendations.length > 0) {
      review = [
        `# Found ${recommendations.length} queries that could be optimized`,
        recommendations.join("\n"),
        metadata,
        GithubReporter.REVIEW_COMMENT_SUFFIX,
      ].join("\n");
    } else {
      review = [
        "# Your queries are optimized!",
        metadata,
        GithubReporter.REVIEW_COMMENT_SUFFIX,
      ].join("\n");
    }
    if (!existingReview) {
      await octokit.rest.pulls.createReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: this.prNumber,
        event: "COMMENT",
        body: review,
      });
    } else {
      await octokit.rest.pulls.updateReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: this.prNumber,
        review_id: existingReview.id,
        body: review,
      });
    }
  }
}

type ReportMetadata = {
  logSize: number;
  timeElapsed: number;
};

export type ReportContext = {
  recommendations: ReportIndexRecommendation[];
  metadata: ReportMetadata;
};

export type ReportIndexRecommendation = {
  formattedQuery: string;
  baseCost: number;
  optimizedCost: number;
  existingIndexes: string[];
  proposedIndexes: string[];
};
