import { describe, expect, it } from "vitest";
import { comparePaired, hodgesLehmann } from "./stats.ts";

/**
 * Expected p-values come from enumerating all 2^n sign assignments of the ranks
 * straight from Wilcoxon's definition, not from a statistics library.
 *
 * Note that most cases use differences of distinct magnitude. A uniform shift —
 * every pair slower by exactly 10ms — ties every rank, and the exact
 * distribution does not apply to tied ranks, so those cases exercise the
 * approximation instead. Both paths are covered below.
 */
describe("comparePaired", () => {
  it("reports no difference when every pair is identical", () => {
    const values = [10, 11, 12, 13, 14, 15, 16, 17];
    const result = comparePaired(values, values);
    // Every difference is zero, so the reduced-sample convention drops them all.
    expect(result.n).toBe(0);
    expect(result.p).toBe(1);
    expect(result.medianDifference).toBe(0);
  });

  it("detects a regression across eight pairs", () => {
    const control = [10, 11, 12, 13, 14, 15, 16, 17];
    const experiment = [11, 13, 15, 17, 19, 21, 23, 25];
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(8);
    expect(result.wPlus).toBe(36);
    expect(result.p).toBeCloseTo(0.0078125, 10);
    expect(result.exact).toBe(true);
    expect(result.medianDifference).toBe(4.5);
    expect(result.percentChange).toBeGreaterThan(0);
  });

  it("detects an improvement, and reports it as a negative difference", () => {
    const control = [100, 102, 98, 101, 99, 103, 97, 104];
    const experiment = [92, 93, 85, 87, 84, 87, 80, 86];
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(8);
    expect(result.wPlus).toBe(0);
    expect(result.p).toBeCloseTo(0.0078125, 10);
    expect(result.exact).toBe(true);
    expect(result.medianDifference).toBe(-14);
    expect(result.percentChange).toBeLessThan(0);
  });

  it("detects a regression across ten pairs", () => {
    const control = [100, 102, 98, 101, 99, 103, 97, 104, 96, 105];
    const experiment = [108, 111, 108, 112, 111, 116, 111, 119, 112, 122];
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(10);
    expect(result.wPlus).toBe(55);
    expect(result.p).toBeCloseTo(0.001953125, 10);
    expect(result.exact).toBe(true);
    expect(result.medianDifference).toBe(12.5);
  });

  it("cannot reach significance with three pairs, however large the change", () => {
    // The smallest attainable two-sided p at n=3 is 2/2^3 = 0.25. A gate set at
    // 0.05 can never fire here, which is why the number of pairs matters more
    // than the size of the effect at small n.
    const result = comparePaired([10, 11, 12], [13, 15, 17]);
    expect(result.n).toBe(3);
    expect(result.p).toBeCloseTo(0.25, 10);
    expect(result.exact).toBe(true);
  });

  it("is not fooled by noise that has no net direction", () => {
    const control = [10, 11, 12, 13, 14, 15, 16, 17];
    const experiment = [11, 9, 15, 9, 19, 9, 23, 9];
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(8);
    expect(result.wPlus).toBe(16);
    expect(result.p).toBeCloseTo(0.84375, 10);
    expect(result.exact).toBe(true);
  });

  it("ignores a single wild outlier, which a mean would not", () => {
    const control = [10, 11, 12, 13, 14, 15, 16, 17];
    const experiment = [10, 11, 12, 13, 14, 15, 16, 99];
    const result = comparePaired(control, experiment);
    // Seven pairs did not move and drop out. One pair can never be significant.
    expect(result.n).toBe(1);
    expect(result.p).toBeCloseTo(1, 10);
    // The mean difference across the eight pairs is 10.25. This reports 0.
    expect(result.medianDifference).toBe(0);
  });

  it("falls back to the approximation when a uniform shift ties every rank", () => {
    const control = [10, 20, 30, 40, 50, 60, 70, 80];
    const experiment = control.map((value) => value + 10);
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(8);
    expect(result.exact).toBe(false);
    // Every pair moved the same way, so the direction is certain even though
    // the exact distribution is unavailable.
    expect(result.p).toBeLessThan(0.05);
    expect(result.medianDifference).toBe(10);
  });

  it("falls back to the approximation past the exact ceiling", () => {
    const control = Array.from({ length: 60 }, (_, i) => 100 + i);
    const experiment = control.map((value, i) => value + 5 + i * 0.1);
    const result = comparePaired(control, experiment);
    expect(result.n).toBe(60);
    expect(result.exact).toBe(false);
    expect(result.p).toBeLessThan(0.001);
  });

  it("refuses samples that are not paired", () => {
    expect(() => comparePaired([1, 2, 3], [1, 2])).toThrow(/equal lengths/);
  });
});

describe("hodgesLehmann", () => {
  it("is the median of the pairwise averages", () => {
    // Walsh averages of [1, 2, 9] are 1, 1.5, 5, 2, 5.5, 9; sorted median 3.5.
    expect(hodgesLehmann([1, 2, 9])).toBeCloseTo(3.5, 10);
  });

  it("resists a single extreme value", () => {
    // The mean of these is 100.9.
    expect(hodgesLehmann([1, 1, 1, 1, 1, 1, 1, 1, 1, 1000])).toBeLessThan(2);
  });
});
