/**
 * Records what one optimizer run cost, without changing the optimizer.
 *
 * The measurements are taken by replacing two methods on the prototype at
 * runtime and calling through to the originals. Nothing in `src/remote` knows
 * this happens, which is the point: the benchmark file is copied onto whichever
 * commit is being measured, so it has to work against code written before the
 * benchmark existed. A field added to the optimizer today would be absent from
 * every historical commit and the backfill would measure nothing.
 *
 * `private` in TypeScript is checked at compile time and gone at runtime, so
 * both methods are ordinary properties of the prototype here.
 */

/** The methods this depends on. Absent ones are reported, never worked around. */
const TIMED_METHOD = "optimizeQuery";
const CANDIDATES_METHOD = "getPotentialIndexCandidates";

export type Instrumentation = {
  /** Milliseconds spent optimizing each query, keyed by its hash. */
  timings: Map<string, number>;
  /** Index candidates derived for each query, keyed by its hash. */
  candidates: Map<string, number>;
  /**
   * The largest number of candidates any single table attracted. This is the
   * input to the permutation count, so it is the number that decides whether a
   * run is cheap or impossible.
   */
  maxCandidatesPerTable: number;
  /**
   * Methods that were not on the prototype. A commit predating one of them can
   * still be measured for everything else, and says so rather than quietly
   * reporting zero.
   */
  missing: string[];
  restore(): void;
};

type AnyFn = (...args: unknown[]) => unknown;
type Prototype = Record<string, unknown>;

/** Ordered subsets of n candidates, which is what the optimizer builds from them. */
export function permutationCount(n: number): number {
  let total = 0;
  let running = 1;
  for (let k = 1; k <= n; k++) {
    running *= n - k + 1;
    total += running;
  }
  return total;
}

function tableKey(candidate: unknown): string {
  const c = candidate as { schema?: string; table?: string };
  return `${c?.schema ?? "?"}.${c?.table ?? "?"}`;
}

export function instrument(optimizerClass: {
  prototype: unknown;
}): Instrumentation {
  const prototype = optimizerClass.prototype as Prototype;
  const timings = new Map<string, number>();
  const candidates = new Map<string, number>();
  const missing: string[] = [];
  const restores: Array<() => void> = [];
  let maxCandidatesPerTable = 0;

  // The most recent query to enter optimizeQuery. getPotentialIndexCandidates
  // is called from inside it, and receives the query too, so this is only a
  // fallback for a shape where that stops being true.
  let currentHash: string | undefined;

  const timed = prototype[TIMED_METHOD] as AnyFn | undefined;
  if (typeof timed !== "function") {
    missing.push(TIMED_METHOD);
  } else {
    prototype[TIMED_METHOD] = async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const recent = args[0] as { hash?: string } | undefined;
      // Queries run several at a time and finish out of order, so a timing has
      // to carry the identity of its query. Pairing by completion order would
      // line up different queries on the two sides and still produce a
      // confident p-value.
      const hash = recent?.hash ? String(recent.hash) : `unkeyed:${timings.size}`;
      currentHash = hash;
      const started = process.hrtime.bigint();
      try {
        return await (timed as AnyFn).apply(this, args);
      } finally {
        timings.set(hash, Number(process.hrtime.bigint() - started) / 1e6);
      }
    } as unknown as AnyFn;
    restores.push(() => {
      prototype[TIMED_METHOD] = timed;
    });
  }

  const deriving = prototype[CANDIDATES_METHOD] as AnyFn | undefined;
  if (typeof deriving !== "function") {
    missing.push(CANDIDATES_METHOD);
  } else {
    prototype[CANDIDATES_METHOD] = function (this: unknown, ...args: unknown[]) {
      const derived = (deriving as AnyFn).apply(this, args) as unknown[];
      const recent = args[1] as { hash?: string } | undefined;
      const hash = recent?.hash ? String(recent.hash) : currentHash;
      if (Array.isArray(derived)) {
        if (hash) candidates.set(hash, derived.length);
        const perTable = new Map<string, number>();
        for (const candidate of derived) {
          const key = tableKey(candidate);
          perTable.set(key, (perTable.get(key) ?? 0) + 1);
        }
        for (const count of perTable.values()) {
          maxCandidatesPerTable = Math.max(maxCandidatesPerTable, count);
        }
      }
      return derived;
    } as unknown as AnyFn;
    restores.push(() => {
      prototype[CANDIDATES_METHOD] = deriving;
    });
  }

  return {
    timings,
    candidates,
    get maxCandidatesPerTable() {
      return maxCandidatesPerTable;
    },
    missing,
    restore() {
      for (const undo of restores) undo();
      restores.length = 0;
    },
  };
}

/**
 * Timings in a fixed order, so two runs can be paired.
 *
 * Only queries measured on both sides are returned, in sorted hash order. A
 * query that one side never reached — it errored, or the commit did not have
 * it — would otherwise shift every pair after it by one.
 */
export function alignTimings(
  control: Map<string, number>,
  experiment: Map<string, number>,
): { hashes: string[]; control: number[]; experiment: number[] } {
  const shared = [...control.keys()]
    .filter((hash) => experiment.has(hash))
    .sort();
  return {
    hashes: shared,
    control: shared.map((hash) => control.get(hash)!),
    experiment: shared.map((hash) => experiment.get(hash)!),
  };
}
