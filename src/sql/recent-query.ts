import * as prettier from "prettier";
import prettierPluginSql from "prettier-plugin-sql";
// deno-lint-ignore no-unused-vars
import type { SegmentedQueryCache } from "../sync/seen-cache.ts";
import {
  Analyzer,
  DiscoveredColumnReference,
  Nudge,
  PssRewriter,
  SQLCommenterTag,
  type PostgresExplainStage,
  type TableReference,
} from "@query-doctor/core";
import { parse } from "@libpg-query/parser";
import z from "zod";
import type { LiveQueryOptimization } from "../remote/optimization.ts";

/**
 * Constructed by syncing with {@link SegmentedQueryCache.sync}
 * and supplying the date the query was last seen
 */
export class RecentQuery {
  private static rewriter = new PssRewriter();

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
    readonly tableReferences: TableReference[],
    readonly columnReferences: DiscoveredColumnReference[],
    readonly tags: SQLCommenterTag[],
    readonly nudges: Nudge[],
    readonly hash: QueryHash,
    readonly seenAt: number,
  ) {
    this.username = data.username;
    this.query = data.query;
    this.formattedQuery = data.formattedQuery;
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
    explainPlan?: PostgresExplainStage,
  ): OptimizedQuery {
    return Object.assign(this, { optimization, explainPlan });
  }

  static async analyze(
    data: RawRecentQuery,
    hash: QueryHash,
    seenAt: number,
  ) {
    const analyzer = new Analyzer(parse);
    const rewrittenQuery = RecentQuery.rewriter.rewrite(data.query);
    const analysis = await analyzer.analyze(rewrittenQuery);
    const formattedQuery = await RecentQuery.formatQuery(
      analysis.queryWithoutTags,
    );
    return new RecentQuery(
      { ...data, query: analysis.queryWithoutTags, formattedQuery },
      analysis.referencedTables,
      analysis.indexesToCheck,
      analysis.tags,
      analysis.nudges,
      hash,
      seenAt,
    );
  }

  private static async formatQuery(query: string): Promise<string> {
    try {
      return await prettier.format(query, {
        parser: "sql",
        plugins: [prettierPluginSql],
        language: "postgresql",
        keywordCase: "upper",
      });
    } catch {
      return query;
    }
  }

  static isSelectQuery(data: RawRecentQuery): boolean {
    return /^select/i.test(data.query);
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
  explainPlan?: PostgresExplainStage;
};

export const QueryHash = z.string().brand<"QueryHash">();
export type QueryHash = z.infer<typeof QueryHash>;
