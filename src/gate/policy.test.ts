import { describe, expect, it } from "vitest";
import { resolveVerdict } from "./policy.ts";

const untested = {
  condition: "untested-data-access",
  verdictClass: "uncertain-conservative-flag" as const,
};

describe("resolveVerdict", () => {
  it("blocks an unverified data-access change by default", () => {
    expect(resolveVerdict(untested)).toEqual({
      policy: "fail",
      conclusion: "failure",
      surfaced: true,
    });
  });

  it("softens to a surfaced, non-blocking neutral under a warn policy", () => {
    expect(
      resolveVerdict(untested, { "untested-data-access": "warn" }),
    ).toEqual({
      policy: "warn",
      conclusion: "neutral",
      surfaced: true,
    });
  });

  it("suppresses the condition entirely under an off policy", () => {
    expect(
      resolveVerdict(untested, { "untested-data-access": "off" }),
    ).toEqual({
      policy: "off",
      conclusion: "success",
      surfaced: false,
    });
  });

  it("keeps a passing verdict green even under a fail policy — the taxonomy drives the conclusion", () => {
    expect(
      resolveVerdict(
        { condition: "untested-data-access", verdictClass: "pass" },
        { "untested-data-access": "fail" },
      ),
    ).toEqual({
      policy: "fail",
      conclusion: "success",
      surfaced: true,
    });
  });
});
