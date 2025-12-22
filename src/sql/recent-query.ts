// import { format } from "sql-formatter";
// deno-lint-ignore no-unused-vars
import type { SegmentedQueryCache } from "../sync/seen-cache.ts";
import {
  Analyzer,
  DiscoveredColumnReference,
  SQLCommenterTag,
} from "@query-doctor/core";
import { parse } from "@libpg-query/parser";
import z from "zod";
import type { LiveQueryOptimization } from "../remote/optimization.ts";

/**
 * Constructed by syncing with {@link SegmentedQueryCache.sync}
 * and supplying the date the query was last seen
 */
export class RecentQuery {
  readonly formattedQuery: string;
  readonly username: string;
  readonly query: string;
  readonly meanTime: number;
  readonly calls: string;
  readonly rows: string;
  readonly topLevel: boolean;

  readonly isSystemQuery: boolean;
  readonly isSelectQuery: boolean;
  readonly isIntrospection: boolean;
  readonly isTargetlessSelectQuery: boolean;

  /** Use {@link RecentQuery.analyze} instead */
  constructor(
    data: RawRecentQuery,
    readonly tableReferences: string[],
    readonly columnReferences: DiscoveredColumnReference[],
    readonly tags: SQLCommenterTag[],
    readonly hash: QueryHash,
    readonly seenAt: number,
  ) {
    this.username = data.username;
    this.query = data.query;
    this.formattedQuery = data.query;
    this.meanTime = data.meanTime;
    this.calls = data.calls;
    this.rows = data.rows;
    this.topLevel = data.topLevel;

    this.isSystemQuery = RecentQuery.isSystemQuery(tableReferences);
    this.isSelectQuery = RecentQuery.isSelectQuery(data);
    this.isIntrospection = RecentQuery.isIntrospection(data);
    this.isTargetlessSelectQuery = this.isSelectQuery
      ? RecentQuery.isTargetlessSelectQuery(tableReferences)
      : false;
  }

  withOptimization(
    optimization: LiveQueryOptimization,
  ): OptimizedQuery {
    return Object.assign(this, { optimization });
  }

  static async analyze(
    data: RawRecentQuery,
    hash: QueryHash,
    seenAt: number,
  ) {
    const analyzer = new Analyzer(parse);
    const analysis = await analyzer.analyze(data.query);
    return new RecentQuery(
      { ...data, query: analysis.queryWithoutTags },
      analysis.referencedTables,
      analysis.indexesToCheck,
      analysis.tags,
      hash,
      seenAt,
    );
  }

  static isSelectQuery(data: RawRecentQuery): boolean {
    return /^select/i.test(data.query);
  }

  static isSystemQuery(referencedTables: string[]): boolean {
    return referencedTables.some((table) =>
      table.startsWith("pg_") ||
      /* timescaledb jobs */
      table.startsWith("bgw_job_stat_")
    );
  }

  static isIntrospection(data: RawRecentQuery): boolean {
    return data.query.match("@qd_introspection") !== null;
  }

  static isTargetlessSelectQuery(
    referencedTables: string[],
  ): boolean {
    return referencedTables.length === 0;
  }
}

export type RawRecentQuery = {
  username: string;
  query: string;
  formattedQuery: string;
  meanTime: number;
  calls: string;
  rows: string;
  topLevel: boolean;
};

export type OptimizedQuery = RecentQuery & {
  optimization: LiveQueryOptimization;
};

export const QueryHash = z.string().brand<"QueryHash">();
export type QueryHash = z.infer<typeof QueryHash>;
