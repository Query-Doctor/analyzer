from itertools import product
from fractions import Fraction

def exact_wilcoxon_two_sided(control, experiment):
    """Brute force over all 2^n sign assignments. No library, straight from the definition."""
    d = [e - c for c, e in zip(control, experiment)]
    d = [x for x in d if x != 0]                      # Wilcoxon's reduced-sample convention
    n = len(d)
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:                                       # average ranks for ties in |d|
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    w_plus = sum(r for r, x in zip(ranks, d) if x > 0)
    total = sum(ranks)
    T = min(w_plus, total - w_plus)
    # enumerate the exact null: every rank is + or - with prob 1/2
    count = 0
    for signs in product([0, 1], repeat=n):
        wp = sum(r for r, s in zip(ranks, signs) if s)
        if min(wp, total - wp) <= T:
            count += 1
    p = Fraction(count, 2 ** n)
    return n, w_plus, float(min(1.0, p))

def hodges_lehmann(control, experiment):
    d = [e - c for c, e in zip(control, experiment)]
    walsh = sorted((d[i] + d[j]) / 2 for i in range(len(d)) for j in range(i, len(d)))
    m = len(walsh)
    return walsh[m // 2] if m % 2 else (walsh[m // 2 - 1] + walsh[m // 2]) / 2

CASES = {
  "no-difference":      ([10,11,12,13,14,15,16,17],[10,11,12,13,14,15,16,17]),
  "uniform-regression": ([10,11,12,13,14,15,16,17],[12,13,14,15,16,17,18,19]),
  "small-n-3":          ([10,11,12],[12,13,14]),
  "mixed-noise":        ([10,11,12,13,14,15,16,17],[11,10,13,12,15,14,17,16]),
  "one-outlier":        ([10,11,12,13,14,15,16,17],[10,11,12,13,14,15,16,99]),
  "ten-percent-slower": ([100,102,98,101,99,103,97,104,96,105],[110,112,108,111,109,113,107,114,106,115]),
}
for name,(c,e) in CASES.items():
    n,wp,p = exact_wilcoxon_two_sided(c,e)
    print(f"{name:20s} n={n:2d} W+={wp:6.1f} p={p:.10f} HL={hodges_lehmann(c,e):.4f}")
