// What `minimumCost` means, in the two places it means different things.
//
// A repo sets one number. The comparison path and the recommendation path then
// apply it differently, and neither says so:
//
//   comparison      report unless BOTH sides are under the floor
//   recommendation  report only when the base cost is strictly OVER the floor
//
// So with `minimumCost: 100`, a query at 99 that becomes 1500 is a reported
// regression, a query at 100 with an index recommendation is not reported, and a
// query moving 50 to 99 is invisible however far it moved in relative terms.
//
// This module does not change any of that. It gives both rules a name and a test
// so the difference is visible in one place, because today it is two inline
// conditions in two files that look like they should agree.
//
// The open question, which needs a product decision rather than a refactor: the
// comparison rule asks "is this query worth mentioning on either side", and the
// recommendation rule asks "is the query expensive enough to bother indexing".
// Those are defensible as separate ideas, but they are configured by one field.

/**
 * True when a cost change is worth reporting. Mirrors `compareRuns`: a move is
 * hidden only when the query is under the floor on both sides, so a query that
 * crosses the floor in either direction is always reported.
 */
export function comparisonClearsFloor(
  previousCost: number,
  currentCost: number,
  minimumCost: number,
): boolean {
  if (minimumCost <= 0) return true;
  return !(previousCost < minimumCost && currentCost < minimumCost);
}

/**
 * True when an index recommendation is worth showing. Mirrors `runner.ts`, which
 * uses a strict comparison against the base cost alone — a query costing exactly
 * the floor is dropped.
 */
export function recommendationClearsFloor(
  baseCost: number,
  minimumCost: number,
): boolean {
  if (minimumCost <= 0) return true;
  return baseCost > minimumCost;
}
