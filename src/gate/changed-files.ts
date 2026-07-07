import * as github from "@actions/github";
import type { ChangedFile } from "./test-presence.ts";

/**
 * Fetch the PR's changed files from the GitHub API. Returns `null` when the run
 * isn't a pull request (e.g. a push to the comparison branch) — the gate is a
 * PR-diff heuristic, so with no PR there is nothing to evaluate.
 *
 * We use the API rather than `git diff` because a default `actions/checkout` is
 * shallow: the base ref often isn't fetched, so a local diff would be unreliable.
 * The `GITHUB_TOKEN` the action already receives has the `pull_requests: read`
 * scope this needs.
 */
export async function fetchPrChangedFiles(
  token: string,
): Promise<ChangedFile[] | null> {
  const prNumber = github.context.payload.pull_request?.number;
  if (typeof prNumber === "undefined") {
    return null;
  }
  const octokit = github.getOctokit(token);
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch,
  }));
}
