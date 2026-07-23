import { describe, expect, it } from "vitest";
import { gateNewQuery } from "./new-query.ts";

describe("gateNewQuery", () => {
  it("blocks eligible new queries by default", () => {
    expect(gateNewQuery(2)).toEqual({ conclusion: "failure" });
  });

  it("softens to a non-blocking warning under a warn policy", () => {
    expect(
      gateNewQuery(2, { "new-query-index": "warn" })?.conclusion,
    ).toBe("neutral");
  });

  it("drops the gate under an off policy", () => {
    expect(gateNewQuery(2, { "new-query-index": "off" })).toBeNull();
  });

  it("passes when there are no eligible new queries", () => {
    expect(gateNewQuery(0)).toBeNull();
  });
});
