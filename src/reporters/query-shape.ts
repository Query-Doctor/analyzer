import { normalizedFingerprint, type SQLCommenterTag } from "@query-doctor/core";
import { fingerprint, parse } from "@libpg-query/parser";

/**
 * A query's shape key: core's normalized fingerprint, which strips bare column
 * references from every SELECT list (top-level, CTEs, subqueries, set-op arms)
 * so that adding a column to a SELECT does not change the key — while a change
 * to the FROM / WHERE / ORDER / LIMIT / aggregates still does.
 *
 * This is how we recognise "the same query, columns added" across a raw-hash
 * change (#3367): a column added to a SELECT changes the exact hash, so without
 * a shape key the same call site reads as one `removed` + one `new` query
 * instead of one changed query. Returns null when the query can't be parsed —
 * it then simply can't be shape-matched and falls back to new/removed.
 */
export async function shapeKey(query: string): Promise<string | null> {
  try {
    return await normalizedFingerprint(await parse(query), fingerprint);
  } catch {
    return null;
  }
}

/**
 * The query's own call site: the first entry of the sqlcommenter `file` tag
 * (packed most-specific-first, `;`-separated), read the same way test-origin
 * detection reads origin. Used to keep shape-matching from merging
 * identically-shaped queries issued from different call sites. Null when the
 * query carries no `file` tag.
 */
export function originFile(
  tags: readonly SQLCommenterTag[] | undefined,
): string | null {
  if (!tags) return null;
  for (const tag of tags) {
    if (tag.key !== "file") continue;
    const first = tag.value.split(";")[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * Whether two queries' origins are compatible for shape-matching. When both
 * carry a `file` tag they must name the same call site; when either is untagged
 * we allow the match, since the shape key (same table + WHERE/ORDER/LIMIT,
 * differing only in bare columns) is already specific enough that a collision is
 * the same access pattern.
 */
export function originsCompatible(
  a: readonly SQLCommenterTag[] | undefined,
  b: readonly SQLCommenterTag[] | undefined,
): boolean {
  const fa = originFile(a);
  const fb = originFile(b);
  if (fa && fb) return fa === fb;
  return true;
}
