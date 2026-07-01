import { normalizedFingerprint } from "@query-doctor/core";
import {
  QueryHash,
  RawRecentQuery,
  RecentQuery,
} from "../sql/recent-query.ts";
import { fingerprint, parse } from "@libpg-query/parser";
import { Sema } from "async-sema";
import { log } from "../log.ts";

const MAX_CONCURRENCY = 10;

async function hash(query: string): Promise<QueryHash> {
  return QueryHash.parse(await fingerprint(query));
}

export async function syncQueries(
  rawQueries: RawRecentQuery[],
): Promise<RecentQuery[]> {
  const sema = new Sema(MAX_CONCURRENCY);
  const results = await Promise.allSettled(rawQueries.map(async (rawQuery) => {
    await sema.acquire();
    try {
      const key = await hash(rawQuery.query);
      const normalizedHash = QueryHash.parse(
        await normalizedFingerprint(await parse(rawQuery.query), fingerprint),
      );
      return await RecentQuery.analyze(rawQuery, key, normalizedHash);
    } catch (error) {
      log.error(`Failed to analyze query ${rawQuery.query}`, "query-sync");
      console.error(error);
      throw error;
    } finally {
      sema.release();
    }
  }));
  return results
    .filter((r): r is PromiseFulfilledResult<RecentQuery> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value);
}
