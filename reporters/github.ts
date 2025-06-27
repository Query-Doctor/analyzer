import * as github from "@actions/github";
import dedent from "dedent";

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
    const ourReview = reviews.data.find(
      (r) =>
        r.user &&
        r.body_html &&
        r.body_html.includes(GithubReporter.REVIEW_COMMENT_SUFFIX)
    );
    const recommendations = ctx.recommendations.map(
      (r) => dedent`
      <details>
      <summary>Optimized query cost (${r.baseCost} -> ${
        r.optimizedCost
      }) by <strong>${(
        ((r.baseCost - r.optimizedCost) / r.baseCost) *
        100
      ).toFixed(2)}%</strong></summary>
      \`\`\`sql
      ${r.formattedQuery}
      \`\`\`

      Base cost: ${r.baseCost}
      Optimized cost: ${r.optimizedCost}
      Existing indexes: ${r.existingIndexes.join(", ")}

      <h2>Proposed indexes</h2>
      <ul>
      ${r.proposedIndexes
        .map(
          (index) => dedent`
        <li>
          ${index}
        </li>
      `
        )
        .join("\n")}
      </ul>
      </details>
    `
    );
    let review: string;
    const metadata = dedent`
    <details>
      <summary>Metadata</summary>
      <dl>
        <dt>Log size</dt>
        <dd>${ctx.metadata.logSize} bytes</dd>
        <dt>Time elapsed</dt>
        <dd>${ctx.metadata.timeElapsed}ms</dd>
      </dl>
    </details>
    `;
    if (recommendations.length > 0) {
      review = dedent`
      # Found ${recommendations.length} queries that could be optimized
      ${recommendations.join("\n")}
      ${metadata}
      ${GithubReporter.REVIEW_COMMENT_SUFFIX}
    `;
    } else {
      review = dedent`
      # Your queries are optimized!
      ${metadata}
      ${GithubReporter.REVIEW_COMMENT_SUFFIX}
    `;
    }
    if (!ourReview) {
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
        review_id: ourReview.id,
        event: "COMMENT",
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
