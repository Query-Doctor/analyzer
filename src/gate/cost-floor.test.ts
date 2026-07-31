import { describe, expect, it } from "vitest";
import { comparisonClearsFloor, recommendationClearsFloor } from "./cost-floor.ts";

describe("comparisonClearsFloor", () => {
  it("reports a move when either side reaches the floor", () => {
    expect(comparisonClearsFloor(1500, 99, 100)).toBe(true);
    expect(comparisonClearsFloor(99, 1500, 100)).toBe(true);
  });

  it("hides a move that stays under the floor on both sides", () => {
    expect(comparisonClearsFloor(50, 99, 100)).toBe(false);
    expect(comparisonClearsFloor(99, 50, 100)).toBe(false);
  });

  it("reports everything when no floor is set", () => {
    expect(comparisonClearsFloor(1, 2, 0)).toBe(true);
  });
});

describe("recommendationClearsFloor", () => {
  it("needs the base cost to exceed the floor, not merely reach it", () => {
    expect(recommendationClearsFloor(101, 100)).toBe(true);
    expect(recommendationClearsFloor(100, 100)).toBe(false);
  });

  it("reports everything when no floor is set", () => {
    expect(recommendationClearsFloor(1, 0)).toBe(true);
  });
});
