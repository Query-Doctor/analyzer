import { format } from "sql-formatter";
// deno-lint-ignore no-unused-vars
import type { SegmentedQueryCache } from "../sync/seen-cache.ts";

/**
 * Constructed by {@link SegmentedQueryCache} by supplying the
 * date the query was last seen
 */
export class RecentQuery {
  public readonly formattedQuery: string;
  public readonly username: string;
  public readonly query: string;
  public readonly meanTime: number;
  public readonly calls: string;
  public readonly rows: string;
  public readonly topLevel: boolean;

  constructor(
    data: RawRecentQuery,
    public readonly seenAt: number,
  ) {
    this.username = data.username;
    this.query = data.query;
    this.formattedQuery = format(data.query, {
      language: "postgresql",
      keywordCase: "lower",
      linesBetweenQueries: 2,
    });
    this.meanTime = data.meanTime;
    this.calls = data.calls;
    this.rows = data.rows;
    this.topLevel = data.topLevel;
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
