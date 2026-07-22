import { describe, expect, it } from "vitest";
import { gateRegression } from "./regression.ts";

describe("gateRegression", () => {
  it("blocks untriaged regressions by default", () => {
    expect(gateRegression(2)).toEqual({ conclusion: "failure" });
  });

  it("softens to a non-blocking warning under a warn policy", () => {
    expect(
      gateRegression(2, { "regression-beyond-threshold": "warn" })?.conclusion,
    ).toBe("neutral");
  });

  it("drops the gate under an off policy", () => {
    expect(
      gateRegression(2, { "regression-beyond-threshold": "off" }),
    ).toBeNull();
  });

  it("passes when there are no regressions", () => {
    expect(gateRegression(0)).toBeNull();
  });
});
