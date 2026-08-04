/**
 * What to log when no baseline exists for the comparison branch.
 *
 * The branch is resolved from the project's configured comparison branch, then
 * the pull request base, then the current branch, so it can come out empty on a
 * push run for a project that has not set one. Interpolating that empty string
 * produced `pushes to ""` and `push: branches: []`, which matches no branch at
 * all and reads as a broken instruction.
 */
export function baselineNotFoundMessage(
  comparisonBranch: string | undefined | null,
): string {
  if (!comparisonBranch) {
    return (
      "No comparison branch is set, so nothing was compared. " +
      "Set one in the project's CI settings, then push to it once so a baseline is recorded."
    );
  }
  return (
    `No baseline found on branch "${comparisonBranch}". Comparison will be skipped. ` +
    `A baseline is recorded when the analyzer runs on a push to "${comparisonBranch}"; ` +
    `if the workflow has no push trigger for it, add "push: branches: [${comparisonBranch}]".`
  );
}
