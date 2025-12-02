import type { Postgres } from "@query-doctor/core";
import { RawRecentQuery, RecentQuery } from "../sql/recent-query.ts";
interface CacheEntry {
  firstSeen: number;
  lastSeen: number;
}

type Query = string;

export class QueryCache {
  list: Record<Query, CacheEntry> = {};
  private readonly createdAt: number;

  constructor() {
    this.createdAt = Date.now();
  }

  isCached(key: string): boolean {
    const entry = this.list[key];
    if (!entry) {
      return false;
    }
    return true;
  }

  isNew(key: string): boolean {
    const entry = this.list[key];
    if (!entry) {
      return true;
    }
    return entry.firstSeen >= this.createdAt;
  }

  store(recentQuery: RawRecentQuery): string {
    // TODO: use fingerprint from @libpg-query/parser instead of the full query string
    const key = recentQuery.query;
    const now = Date.now();
    if (this.list[key]) {
      this.list[key].lastSeen = now;
    } else {
      this.list[key] = { firstSeen: now, lastSeen: now };
    }
    return key;
  }

  getFirstSeen(key: string): number {
    return this.list[key]?.firstSeen || Date.now();
  }

  sync(rawQueries: RawRecentQuery[]): RecentQuery[] {
    return rawQueries.map((rawQuery) => {
      const key = this.store(rawQuery);
      return new RecentQuery(rawQuery, this.getFirstSeen(key));
    });
  }

  reset(): void {
    this.list = {};
  }
}

/**
 * A top-level cache that segments queries by the db instance they're associated with
 */
export class SegmentedQueryCache {
  // weak reference to the db instance to allow cache to be garbage collected
  // when the connection to the database is closed.
  // Can be relevant for
  dbs: WeakMap<Postgres, QueryCache> = new WeakMap();

  sync(db: Postgres, queries: RawRecentQuery[]): RecentQuery[] {
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
