/**
 * Paired significance testing for benchmark timings.
 *
 * Benchmark durations are skewed and heavy-tailed: a slow sample can be
 * arbitrarily slow, a fast one is bounded below by the work itself. Comparing
 * means assumes a symmetry the data does not have, and one contended sample
 * moves a mean enough to invent or hide a regression. So the comparison here is
 * rank-based and paired.
 *
 * Pairing is what makes it cheap. Query *i* under the control and query *i*
 * under the experiment share their SQL, their schema and their statistics, so
 * the difference between them cancels the variation between queries, which is
 * the largest term by far. One pass over N queries yields N pairs, which is far
 * more power than repeating a whole run six times and comparing the means.
 *
 * References, implemented from the definitions:
 *   Wilcoxon, F. (1945). Individual comparisons by ranking methods.
 *   Hodges, J. L. & Lehmann, E. L. (1963). Estimates of location based on rank tests.
 */

/** Below this many pairs the exact null distribution is used. */
const EXACT_MAX_PAIRS = 50;

export type PairedComparison = {
  /** Pairs that survived the reduced-sample convention: zero differences drop. */
  n: number;
  /** Sum of ranks of the positive differences. */
  wPlus: number;
  /** Two-sided probability of a difference this extreme under the null. */
  p: number;
  /** Hodges-Lehmann estimate of the median difference, in input units. */
  medianDifference: number;
  /** The same estimate against the control's median, as a percentage. */
  percentChange: number;
  /** Whether the exact distribution was used, rather than the approximation. */
  exact: boolean;
};

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Ranks of |differences|, smallest first, with tied magnitudes sharing the
 * average of the ranks they span. Ties are common in millisecond timings, and
 * splitting them arbitrarily would make the result depend on input order.
 */
function rankByMagnitude(differences: number[]): number[] {
  const order = differences
    .map((value, index) => index)
    .sort((a, b) => Math.abs(differences[a]) - Math.abs(differences[b]));
  const ranks = new Array<number>(differences.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (
      j + 1 < order.length &&
      Math.abs(differences[order[j + 1]]) === Math.abs(differences[order[i]])
    ) {
      j++;
    }
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Exact distribution of W+ under the null, where each rank is equally likely to
 * carry a positive or a negative sign. Built by convolution: rank k either
 * contributes k or contributes nothing, each with probability one half.
 *
 * Only valid without ties, which is why the caller falls back to the normal
 * approximation when the ranks are not 1..n.
 */
function exactDistribution(n: number): number[] {
  const total = (n * (n + 1)) / 2;
  let pmf = new Array<number>(total + 1).fill(0);
  pmf[0] = 1;
  for (let k = 1; k <= n; k++) {
    const next = new Array<number>(total + 1).fill(0);
    for (let w = 0; w <= total; w++) {
      if (pmf[w] === 0) continue;
      next[w] += pmf[w] / 2;
      if (w + k <= total) next[w + k] += pmf[w] / 2;
    }
    pmf = next;
  }
  return pmf;
}

function exactTwoSidedP(ranks: number[], wPlus: number): number | undefined {
  const n = ranks.length;
  // The exact distribution assumes untied ranks 1..n.
  const sorted = [...ranks].sort((a, b) => a - b);
  if (sorted.some((rank, index) => rank !== index + 1)) return undefined;

  const total = (n * (n + 1)) / 2;
  const pmf = exactDistribution(n);
  const statistic = Math.min(wPlus, total - wPlus);
  let mass = 0;
  for (let w = 0; w <= total; w++) {
    if (Math.min(w, total - w) <= statistic) mass += pmf[w];
  }
  return Math.min(1, mass);
}

/** Abramowitz & Stegun 7.1.26, accurate to ~1.5e-7, which is far past what a p-value needs. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

/**
 * Normal approximation with a continuity correction, and a variance correction
 * for tied ranks. Used above `EXACT_MAX_PAIRS`, and whenever ties make the
 * exact distribution inapplicable.
 */
function approximateTwoSidedP(ranks: number[], wPlus: number): number {
  const n = ranks.length;
  const mean = (n * (n + 1)) / 4;
  let variance = (n * (n + 1) * (2 * n + 1)) / 24;

  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  for (const tied of counts.values()) {
    if (tied > 1) variance -= (tied ** 3 - tied) / 48;
  }
  if (variance <= 0) return 1;

  const deviation = Math.abs(wPlus - mean);
  const z = Math.max(0, deviation - 0.5) / Math.sqrt(variance);
  return Math.min(1, 2 * (1 - (1 + erf(z / Math.SQRT2)) / 2));
}

/**
 * The median of the pairwise averages of the differences. More resistant to a
 * single contended sample than a mean, and it estimates the same quantity the
 * signed-rank test is testing, so the two never disagree about direction.
 */
export function hodgesLehmann(differences: number[]): number {
  const walsh: number[] = [];
  for (let i = 0; i < differences.length; i++) {
    for (let j = i; j < differences.length; j++) {
      walsh.push((differences[i] + differences[j]) / 2);
    }
  }
  return median(walsh.sort((a, b) => a - b));
}

/**
 * Compare paired samples. `control[i]` and `experiment[i]` must be the same
 * unit of work measured under each version — a positive result means the
 * experiment took longer.
 */
export function comparePaired(
  control: number[],
  experiment: number[],
): PairedComparison {
  if (control.length !== experiment.length) {
    throw new Error(
      `Paired comparison needs equal lengths, got ${control.length} and ${experiment.length}`,
    );
  }

  const allDifferences = control.map((value, i) => experiment[i] - value);
  // Wilcoxon's reduced-sample convention: a pair that did not move carries no
  // rank and no sign, so it tells the *test* nothing.
  //
  // The *estimate* keeps them. Dropping them would push the reported median
  // away from zero exactly when most of the work was unaffected, which is the
  // case a reader most needs told plainly. Seven unchanged queries and one
  // outlier is a median difference of zero, not of the outlier.
  const differences = allDifferences.filter((difference) => difference !== 0);

  const n = differences.length;
  if (n === 0) {
    // Nothing moved anywhere, so there is nothing to test and nothing to report.
    return {
      n: 0,
      wPlus: 0,
      p: 1,
      medianDifference: 0,
      percentChange: 0,
      exact: true,
    };
  }

  const ranks = rankByMagnitude(differences);
  let wPlus = 0;
  for (let i = 0; i < n; i++) {
    if (differences[i] > 0) wPlus += ranks[i];
  }

  const exact = n <= EXACT_MAX_PAIRS ? exactTwoSidedP(ranks, wPlus) : undefined;
  const p = exact ?? approximateTwoSidedP(ranks, wPlus);

  const medianDifference = hodgesLehmann(allDifferences);
  const controlMedian = median([...control].sort((a, b) => a - b));

  return {
    n,
    wPlus,
    p,
    medianDifference,
    percentChange:
      controlMedian === 0 ? 0 : (medianDifference / controlMedian) * 100,
    exact: exact !== undefined,
  };
}
