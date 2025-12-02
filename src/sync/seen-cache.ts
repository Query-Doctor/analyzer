import type { Postgres } from "@query-doctor/core";
import { RawRecentQuery, RecentQuery } from "../sql/recent-query.ts";
import { fingerprint } from "@libpg-query/parser";
import z from "zod";

interface CacheEntry {
  firstSeen: number;
  lastSeen: number;
}

const QueryHash = z.string().brand<"QueryHash">();
type QueryHash = z.infer<typeof QueryHash>;

export class QueryCache {
  private list: Record<QueryHash, CacheEntry> = {};
  private readonly createdAt: number;

  constructor() {
    this.createdAt = Date.now();
  }

  isCached(key: QueryHash): boolean {
    const entry = this.list[key];
    if (!entry) {
      return false;
    }
    return true;
  }

  isNew(key: QueryHash): boolean {
    const entry = this.list[key];
    if (!entry) {
      return true;
    }
    return entry.firstSeen >= this.createdAt;
  }

  async store(recentQuery: RawRecentQuery): Promise<QueryHash> {
    const key = await this.hash(recentQuery.query);
    const now = Date.now();
    if (this.list[key]) {
      this.list[key].lastSeen = now;
    } else {
      this.list[key] = { firstSeen: now, lastSeen: now };
    }
    return key;
  }

  getFirstSeen(key: QueryHash): number {
    return this.list[key]?.firstSeen || Date.now();
  }

  async sync(rawQueries: RawRecentQuery[]): Promise<RecentQuery[]> {
    // TODO: bound the concurrency
    return await Promise.all(rawQueries.map(async (rawQuery) => {
      const key = await this.store(rawQuery);
      return RecentQuery.analyze(rawQuery, this.getFirstSeen(key));
    }));
  }

  reset(): void {
    this.list = {};
  }

  private async hash(query: string): Promise<QueryHash> {
    return QueryHash.parse(await fingerprint(query));
  }
}

/**
 * A top-level cache that segments queries by the db instance they're associated with
 */
export class SegmentedQueryCache {
  // weak reference to the db instance to allow cache to be garbage collected
  // when the connection to the database is closed.
  // Can be relevant for
  private readonly dbs: WeakMap<Postgres, QueryCache> = new WeakMap();

  sync(db: Postgres, queries: RawRecentQuery[]): Promise<RecentQuery[]> {
    const cache = this.getOrCreateCache(db);
    return cache.sync(queries);
  }

  store(db: Postgres, query: RawRecentQuery) {
    const cache = this.getOrCreateCache(db);
    return cache.store(query);
  }

  reset(db: Postgres) {
    const cache = this.getOrCreateCache(db);
    return cache.reset();
  }

  private getOrCreateCache(db: Postgres): QueryCache {
    let cache = this.dbs.get(db);
    if (!cache) {
      cache = new QueryCache();
      this.dbs.set(db, cache);
    }
    return cache;
  }
}
