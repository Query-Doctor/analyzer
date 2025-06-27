import * as github from "@actions/github";

function pluralize(count: number, word: string, plural: string) {
  return count === 1 ? `${count} ${word}` : `${count} ${plural}`;
}

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
    const recommendations = ctx.recommendations.map((r, i) => {
      let fullQuery;
      if (r.formattedQuery.length > 100) {
        fullQuery = [
          "<details>",
          "<summary>Full query</summary>",
          "",
          "```sql",
          r.formattedQuery,
          "```",
          "",
          "</details>",
        ];
      } else {
        fullQuery = ["<h3>Full query</h3>", "```sql", r.formattedQuery, "```"];
      }
      return [
        `<h2>Query ${i + 1} cost reduced by <strong>${percentage(
          r
        )}%</strong> <code>(${r.baseCost} -> ${r.optimizedCost})</code></h2>`,
        `<h3>Missing ${pluralize(
          r.proposedIndexes.length,
          "index",
          "indexes"
        )}</h3>`,
        "<ul>",
        r.proposedIndexes
          .map((index) => `<li><code>${index}</code></li>`)
          .join("\n"),
        "</ul>",
        ...fullQuery,
        "",
        "<details>",
        "<summary>Optimized explain plan</summary>",
        "",
        "```json",
        r.explainPlan,
        "```",
        "",
        "</details>",
        "",
        "<table>",
        "<thead>",
        "<tr>",
        "<th>Cost with existing indexes</th>",
        "<th>Cost with new indexes</th>",
        "</tr>",
        "</thead>",
        "<tbody>",
        "<tr>",
        `<td><code>${r.baseCost}</code></td>`,
        `<td><code>${r.optimizedCost}</code></td>`,
        "</tr>",
        "</tbody>",
        "</table>",
        "",
        "<h4>Existing indexes</h4>",
        "<ul>",
        r.existingIndexes.map((i) => `<li><code>${i}</code></li>`).join("\n"),
        "</ul>",
      ].join("\n");
    });
    const explanation = [
      "<details>",
      "<summary>What does cost mean?</summary>",
      "Cost is an arbitrary amount value representing the amount of work postgres decided it needs to do to execute a query. <br />We use cost to look for improvements when checking if an index helps optimize a query in CI as the full production dataset is simply not available to work with.",
      "</details>",
    ].join("\n");
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
        `# Found ${pluralize(
          recommendations.length,
          "query",
          "queries"
        )} that could be optimized`,
        recommendations.join("\n"),
        explanation,
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
  explainPlan: string;
};
