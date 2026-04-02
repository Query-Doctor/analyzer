import * as prettier from "prettier";
import prettierPluginSql from "prettier-plugin-sql";
import type { SegmentedQueryCache } from "../sync/seen-cache.ts";
import {
  Analyzer,
  DiscoveredColumnReference,
  Nudge,
  PostgresQueryBuilder,
  PssRewriter,
  SQLCommenterTag,
  type TableReference,
} from "@query-doctor/core";
import { parse } from "@libpg-query/parser";
import { Sema } from "async-sema";
import z from "zod";
import type { LiveQueryOptimization } from "../remote/optimization.ts";

/**
 * Constructed by syncing with {@link SegmentedQueryCache.sync}
 * and supplying the date the query was last seen
 */
export class RecentQuery {
  private static HARDCODED_LIMIT = 50;
  private static rewriter = new PssRewriter();
  private static prettierMutex = new Sema(1);

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
  readonly analysisSkipped: boolean;

  /** Use {@link RecentQuery.analyze} instead */
  constructor(
    data: RawRecentQuery,
    readonly tableReferences: TableReference[],
    readonly columnReferences: DiscoveredColumnReference[],
    readonly tags: SQLCommenterTag[],
    readonly nudges: Nudge[],
    readonly hash: QueryHash,
    readonly seenAt: number,
    analysisSkipped = false,
  ) {
    this.username = data.username;
    this.query = data.query;
    this.formattedQuery = data.formattedQuery;
    this.meanTime = data.meanTime;
    this.calls = data.calls;
    this.rows = data.rows;
    this.topLevel = data.topLevel;
    this.analysisSkipped = analysisSkipped;

    this.isSystemQuery = RecentQuery.isSystemQuery(tableReferences);
    this.isSelectQuery = RecentQuery.isSelectQuery(data);
    this.isIntrospection = RecentQuery.isIntrospection(data);
    this.isTargetlessSelectQuery = this.isSelectQuery
      ? RecentQuery.isTargetlessSelectQuery(tableReferences)
      : false;
  }

  withOptimization(optimization: LiveQueryOptimization): OptimizedQuery {
    return Object.assign(this, { optimization });
  }

  /**
   * Queries beyond this size are included in results but skip expensive
   * prettier.format() and Analyzer.analyze() to avoid OOM from massive
   * extension bootstrap data (e.g. PostGIS's 800KB INSERT INTO spatial_ref_sys).
   */
  private static readonly MAX_ANALYZABLE_QUERY_SIZE = 50_000;

  static fromLogEntry(query: string, hash: QueryHash, seenAt: number = Date.now()) {
    return RecentQuery.analyze(
      {
        query,
        formattedQuery: query,
        username: "",
        meanTime: 0,
        calls: "1",
        rows: "0",
        topLevel: true,
      },
      hash,
      seenAt,
    );
  }

  static async analyze(
    data: RawRecentQuery,
    hash: QueryHash,
    seenAt: number,
  ) {
    if (data.query.length > RecentQuery.MAX_ANALYZABLE_QUERY_SIZE) {
      return new RecentQuery(
        { ...data, formattedQuery: data.query },
        [],
        [],
        [],
        [],
        hash,
        seenAt,
        true,
      );
    }

    const analyzer = new Analyzer(parse);
    const formattedQuery = await RecentQuery.formatQuery(
      data.query,
    );
    const analysis = await analyzer.analyze(formattedQuery);
    const query = this.rewriteQuery(analysis.queryWithoutTags);
    return new RecentQuery(
      { ...data, query, formattedQuery },
      analysis.referencedTables,
      analysis.indexesToCheck,
      analysis.tags,
      analysis.nudges,
      hash,
      seenAt,
    );
  }

  private static rewriteQuery(rawQuery: string): string {
    const query = new PostgresQueryBuilder(rawQuery).replaceLimit(
      RecentQuery.HARDCODED_LIMIT,
    ).build();
    return RecentQuery.rewriter.rewrite(query);
  }

  private static async formatQuery(query: string): Promise<string> {
    await RecentQuery.prettierMutex.acquire();
    try {
      return await prettier.format(query, {
        parser: "sql",
        plugins: [prettierPluginSql],
        language: "postgresql",
        keywordCase: "upper",
      });
    } catch (error) {
      console.error(`[prettier] Failed to format query: ${error}`);
      return query;
    } finally {
      RecentQuery.prettierMutex.release();
    }
  }

  static isSelectQuery(data: RawRecentQuery): boolean {
    return /select/i.test(data.query);
  }

  static isSystemQuery(referencedTables: TableReference[]): boolean {
    return referencedTables.some((ref) =>
      ref.table.startsWith("pg_") ||
      ref.schema &&
      (ref.schema.startsWith("_timescale") ||
        ref.schema === "timescaledb_information")
    );
  }

  static isIntrospection(data: RawRecentQuery): boolean {
    return data.query.match("@qd_introspection") !== null;
  }

  static isTargetlessSelectQuery(
    referencedTables: TableReference[],
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
