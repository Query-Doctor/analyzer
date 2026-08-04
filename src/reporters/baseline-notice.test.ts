import { describe, expect, test } from "vitest";
import { baselineNotFoundMessage } from "./baseline-notice.ts";

describe("baselineNotFoundMessage", () => {
  test("names the branch and the trigger that records a baseline", () => {
    const message = baselineNotFoundMessage("main");

    expect(message).toContain("main");
    expect(message).toContain("push: branches: [main]");
  });

  // The branch resolves from the configured comparison branch, then the pull
  // request base, then the current branch. On a push run for a project with
  // none set, all three can be absent, which is how this reached a real log.
  test.each([
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
  ])("never names a branch it does not have: %s", (_case, branch) => {
    const message = baselineNotFoundMessage(branch);

    // What the real log read: `pushes to ""` and `push: branches: []`, which
    // matches no branch and reads as an instruction the user cannot follow.
    expect(message).not.toContain('""');
    expect(message).not.toContain("branches: []");
    expect(message).toContain("No comparison branch is set");
  });
});
