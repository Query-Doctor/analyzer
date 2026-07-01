import * as prettier from "prettier";
import prettierPluginSql from "prettier-plugin-sql";
import {
  Analyzer,
  compactSelectList,
  DiscoveredColumnReference,
  Nudge,
  PostgresQueryBuilder,
  PssRewriter,
  SQLCommenterTag,
  type StatementType,
  type TableReference,
} from "@query-doctor/core";
import { parse } from "@libpg-query/parser";
import z from "zod";
import { log } from "../log.ts";
import type { LiveQueryOptimization } from "../remote/optimization.ts";

/**
 * Constructed by syncing with {@link syncQueries}
 */
export class RecentQuery {
  private static HARDCODED_LIMIT = 50;
  private static rewriter = new PssRewriter();

  readonly formattedQuery: string;
  readonly displayQuery?: string;
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
  optimization: LiveQueryOptimization;

  /** Use {@link RecentQuery.analyze} instead */
  constructor(
    data: RawRecentQuery,
    readonly tableReferences: TableReference[],
    readonly columnReferences: DiscoveredColumnReference[],
    readonly tags: SQLCommenterTag[],
    readonly nudges: Nudge[],
    readonly hash: QueryHash,
    readonly normalizedHash: QueryHash,
    analysisSkipped = false,
    statementType?: StatementType,
  ) {
    this.username = data.username;
    this.query = data.query;
    this.formattedQuery = data.formattedQuery;
    this.displayQuery = data.displayQuery;
    this.meanTime = data.meanTime;
    this.calls = data.calls;
    this.rows = data.rows;
    this.topLevel = data.topLevel;
    this.analysisSkipped = analysisSkipped;

    this.isSystemQuery = RecentQuery.isSystemQuery(tableReferences);
    this.isSelectQuery = statementType !== undefined
      ? statementType === "select"
      : RecentQuery.isSelectQuery(data);
    this.isIntrospection = RecentQuery.isIntrospection(data);
    this.isTargetlessSelectQuery = this.isSelectQuery
      ? RecentQuery.isTargetlessSelectQuery(tableReferences)
      : false;
    this.optimization = { state: "waiting" };
  }

  withOptimization(optimization: LiveQueryOptimization): OptimizedQuery {
    return Object.assign(this, { optimization });
  }

  toJSON() {
    // TODO: these fields should be calling toJSON recursively maybe?
    return JSON.parse(JSON.stringify({
      formattedQuery: this.formattedQuery,
      displayQuery: this.displayQuery,
      username: this.username,
      query: this.query,
      meanTime: this.meanTime,
      calls: this.calls,
      rows: this.rows,
      topLevel: this.topLevel,
      isSystemQuery: this.isSystemQuery,
      isSelectQuery: this.isSelectQuery,
      isIntrospection: this.isIntrospection,
      isTargetlessSelectQuery: this.isTargetlessSelectQuery,
      analysisSkipped: this.analysisSkipped,
      tableReferences: this.tableReferences,
      columnReferences: this.columnReferences,
      tags: this.tags,
      nudges: this.nudges,
      hash: this.hash,
      normalizedHash: this.normalizedHash,
      optimization: this.optimization,
    }));
  }

  /**
   * Queries beyond this size are included in results but skip expensive
   * prettier.format() and Analyzer.analyze() to avoid OOM from massive
   * extension bootstrap data (e.g. PostGIS's 800KB INSERT INTO spatial_ref_sys).
   */
  private static readonly MAX_ANALYZABLE_QUERY_SIZE = 50_000;

  static async analyze(
    data: RawRecentQuery,
    hash: QueryHash,
    normalizedHash: QueryHash,
  ) {
    if (data.query.length > RecentQuery.MAX_ANALYZABLE_QUERY_SIZE) {
      return new RecentQuery(
        { ...data, formattedQuery: data.query },
        [],
        [],
        [],
        [],
        hash,
        normalizedHash,
        true,
      );
    }

    const analyzer = new Analyzer(parse);
    const formattedQuery = await RecentQuery.formatQuery(
      data.query,
    );
    const analysis = await analyzer.analyze(formattedQuery);
    const query = this.rewriteQuery(analysis.queryWithoutTags);
    const strippedFormattedQuery = await RecentQuery.formatQuery(query);
    const displayQuery = await RecentQuery.computeDisplayQuery(query);
    return new RecentQuery(
      { ...data, query, formattedQuery: strippedFormattedQuery, displayQuery },
      analysis.referencedTables,
      analysis.indexesToCheck,
      analysis.tags,
      analysis.nudges,
      hash,
      normalizedHash,
      false,
      analysis.statementType,
    );
  }

  private static rewriteQuery(rawQuery: string): string {
    const query = new PostgresQueryBuilder(rawQuery).replaceLimit(
      RecentQuery.HARDCODED_LIMIT,
    ).build();
    return RecentQuery.rewriter.rewrite(query);
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

  private static async computeDisplayQuery(
    query: string,
  ): Promise<string | undefined> {
    try {
      return compactSelectList(query, await parse(query));
    } catch (error) {
      log.debug(
        `displayQuery: parse failed (${(error as Error).message})`,
        "display-query",
      );
      return undefined;
    }
  }

  static isSelectQuery(data: RawRecentQuery): boolean {
    return /^\s*select/i.test(data.query);
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
  displayQuery?: string;
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

export interface RecentQuerySource {
  getRecentQueries(): Promise<RecentQuery[]>;
}
