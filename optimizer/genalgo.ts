import { blue, gray, green, magenta, red, yellow } from "@std/fmt/colors";
import postgres from "postgresjs";
import { IndexedTable, Statistics } from "./statistics.ts";
import { IndexIdentifier } from "../reporters/reporter.ts";
import { DEBUG } from "../env.ts";
import { SortContext } from "../analyzer.ts";
import { NullTestType } from "@pgsql/types";

type IndexRecommendation = PermutedIndexCandidate & {
  definition: IndexIdentifier;
};
type Color = (a: string) => string;

export class IndexOptimizer {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly statistics: Statistics,
    private readonly existingIndexes: IndexedTable[]
  ) {}

  async run(
    query: string,
    params: string[],
    indexes: RootIndexCandidate[]
  ): Promise<OptimizeResult> {
    const baseExplain = await this.testQueryWithStats(query, params);
    const baseCost: number = Number(baseExplain["Total Cost"]);
    if (baseCost === 0) {
      return {
        kind: "zero_cost_plan",
        table: baseExplain["Relation Name"],
        explainPlan: baseExplain,
      };
    }
    console.log("Base cost with current indexes", baseCost);
    const permutedIndexes = this.tableColumnIndexCandidates(indexes);
    const nextStage: PermutedIndexCandidate[] = [];
    const triedIndexes: Map<string, IndexRecommendation> = new Map();
    // const permutedIndexes = permuteWithFeedback(indexes);
    // await this.sql`vacuum;`;
    const baseIndexes = this.findUsedIndexes(baseExplain);
    console.log(baseIndexes.existingIndexes);
    for (const { table, schema, columns } of permutedIndexes.values()) {
      const permutations = permuteWithFeedback(Array.from(columns));
      let iter = permutations.next(PROCEED);
      let previousCost: number = baseCost;
      while (!iter.done) {
        const columns = iter.value;
        const existingIndex = this.indexAlreadyExists(table, columns);
        if (existingIndex) {
          console.log(` <${gray("skip")}> ${gray(existingIndex.index_name)}`);
          iter = permutations.next(PROCEED);
          continue;
        }
        let indexDefinition: string = "?";
        const explain = await this.testQueryWithStats(
          query,
          params,
          async (sql) => {
            const indexName = `__qd_${schema}_${table}_${columns
              .map((c) => c.column)
              .join("_")}`;
            const { raw, colored } = this.toDefinition({
              columns,
              schema,
              table,
            });
            const shortenedSchema = schema === "public" ? "" : `${schema}.`;
            // TODO: this is silly, turn this into a data structure here ONLY
            const indexDefinitionClean = `${shortenedSchema}${table}(${columns
              .map((c) => `"${c.column}"`)
              .join(", ")})`;
            indexDefinition = colored;
            const sqlString = `create index ${indexName} on ${raw};`;
            triedIndexes.set(indexName, {
              schema,
              table,
              columns,
              definition: indexDefinitionClean as IndexIdentifier,
            });
            await sql.unsafe(`${sqlString} -- @qd_introspection`);
          }
        );
        const costDeltaPercentage =
          ((previousCost - explain["Total Cost"]) / previousCost) * 100;
        if (previousCost > explain["Total Cost"]) {
          console.log(
            `${green(
              `+${costDeltaPercentage.toFixed(2).padStart(5, "0")}%`
            )} ${indexDefinition} `
          );
          iter = permutations.next(PROCEED);
          previousCost = explain["Total Cost"];
        } else {
          console.log(
            `${
              previousCost === explain["Total Cost"]
                ? ` ${gray("00.00%")}`
                : `${red(
                    `-${Math.abs(costDeltaPercentage)
                      .toFixed(2)
                      .padStart(5, "0")}%`
                  )}`
            } ${indexDefinition}`
          );
          // TODO: can we safely call skip?
          // iter = permutations.next(SKIP);
          iter = permutations.next(PROCEED);
          previousCost = baseCost;
        }
        nextStage.push({
          schema,
          table,
          columns,
        });
      }
    }
    const finalExplain = await this.testQueryWithStats(
      query,
      params,
      async (sql) => {
        for (const permutation of nextStage) {
          const { table, schema, columns } = permutation;
          await sql.unsafe(
            `create index __qd_${schema}_${table}_${columns
              .map((c) => c.column)
              .join("_")} on ${
              this.toDefinition(permutation).raw
            }; -- @qd_introspection`
          );
        }
      }
    );
    if (DEBUG) {
      console.dir(finalExplain, { depth: null });
    }
    const deltaPercentage =
      ((baseCost - finalExplain["Total Cost"]) / baseCost) * 100;
    if (finalExplain["Total Cost"] < baseCost) {
      console.log(
        ` 🎉🎉🎉 ${green(`+${deltaPercentage.toFixed(2).padStart(5, "0")}%`)}`
      );
    } else if (finalExplain["Total Cost"] > baseCost) {
      console.log(
        `${red(
          `-${Math.abs(deltaPercentage).toFixed(2).padStart(5, "0")}%`
        )} ${gray("If there's a better index, we haven't tried it")}`
      );
    }
    const { newIndexes, existingIndexes: existingIndexesUsedByQuery } =
      this.findUsedIndexes(finalExplain);
    const finalCost = Number(finalExplain["Total Cost"]);
    return {
      kind: "ok",
      baseCost,
      finalCost,
      newIndexes,
      existingIndexes: existingIndexesUsedByQuery,
      triedIndexes,
      explainPlan: finalExplain,
    };
  }

  private indexAlreadyExists(
    table: string,
    columns: RootIndexCandidate[]
  ): IndexedTable | undefined {
    return this.existingIndexes.find(
      (index) =>
        index.index_type === "btree" &&
        index.table_name === table &&
        index.index_columns.length === columns.length &&
        index.index_columns.every((c, i) => columns[i].column === c.name)
    );
  }

  private toDefinition(permuted: PermutedIndexCandidate) {
    const make = (col: Color, order: Color, where: Color, keyword: Color) => {
      // let clauses: string[] = [];
      // const columns = [...permuted.columns];
      // // TODO
      // for (let i = columns.length - 1; i >= 0; i--) {
      //   const c = columns[i];
      //   const clause = this.whereClause(c, col, where);
      //   if (clause) {
      //     clauses.push(clause);
      //     // TODO: make this
      //     if (columns.length > 1) {
      //       columns.splice(i, 1);
      //     }
      //   }
      // }
      const baseColumn = `${permuted.schema}.${
        permuted.table
      }(${permuted.columns
        .map((c) => {
          const direction = c.sort && this.sortDirection(c.sort);
          const nulls = c.sort && this.nullsOrder(c.sort);
          let sort = col(`"${c.column}"`);
          if (direction) {
            sort += ` ${order(direction)}`;
          }
          if (nulls) {
            sort += ` ${order(nulls)}`;
          }
          return sort;
        })
        .join(", ")})`;
      // TODO: add support for generating partial indexes
      // if (clauses.length > 0) {
      //   return `${baseColumn} ${where("where")} ${clauses.join(" and ")}`;
      // }
      return baseColumn;
    };
    const id: Color = (a) => a;
    const raw = make(id, id, id, id);
    const colored = make(green, yellow, magenta, blue);
    return { raw, colored };
  }

  private whereClause(c: RootIndexCandidate, col: Color, keyword: Color) {
    if (!c.where) {
      return "";
    }
    if (c.where.nulltest === "IS_NULL") {
      return `${col(`"${c.column}"`)} is ${keyword("null")}`;
    }
    if (c.where.nulltest === "IS_NOT_NULL") {
      return `${col(`"${c.column}"`)} is not ${keyword("null")}`;
    }
    return "";
  }

  private nullsOrder(s: SortContext) {
    if (!s.nulls) {
      return "";
    }
    switch (s.nulls) {
      case "SORTBY_NULLS_FIRST":
        return "nulls first";
      case "SORTBY_NULLS_LAST":
        return "nulls last";
      case "SORTBY_NULLS_DEFAULT":
      default:
        return "";
    }
  }

  private sortDirection(s: SortContext) {
    if (!s.dir) {
      return "";
    }
    switch (s.dir) {
      case "SORTBY_DESC":
        return "desc";
      case "SORTBY_ASC":
        return "asc";
      case "SORTBY_DEFAULT":
      // god help us if we ever run into this
      case "SORTBY_USING":
      default:
        return "";
    }
  }

  async testQueryWithStats(
    query: string,
    params: string[],
    f?: (sql: postgres.Sql) => Promise<void>
  ): Promise<any> {
    try {
      await this.sql.begin(async (tx) => {
        await f?.(tx);
        await this.statistics.restoreStats(tx);
        const explainString = `explain (generic_plan, verbose, format json) ${query}; -- @qd_introspection`;
        // should params be passed in here?
        const result = await tx.unsafe(explainString);
        const out = result[0]["QUERY PLAN"][0].Plan;
        throw new RollbackError(out);
      });
    } catch (error) {
      if (error instanceof RollbackError) {
        return error.value;
      }
      throw error;
    }
    throw new Error("Unreachable");
  }

  private tableColumnIndexCandidates(indexes: RootIndexCandidate[]) {
    const tableColumns: Map<
      string,
      { schema: string; table: string; columns: RootIndexCandidate[] }
    > = new Map();
    for (const index of indexes) {
      const existing = tableColumns.get(`${index.schema}.${index.table}`);
      if (existing) {
        existing.columns.push(index);
      } else {
        tableColumns.set(`${index.schema}.${index.table}`, {
          table: index.table,
          schema: index.schema,
          columns: [index],
        });
      }
    }
    return tableColumns;
  }

  private findUsedIndexes(explain: Record<string, any>) {
    const newIndexes: Set<string> = new Set();
    const existingIndexes: Set<string> = new Set();
    function go(plan: any) {
      const indexName = plan["Index Name"];
      if (indexName) {
        if (indexName.startsWith("__qd_")) {
          newIndexes.add(indexName);
        } else {
          existingIndexes.add(indexName);
        }
      }
      if (plan.Plans) {
        for (const p of plan.Plans) {
          go(p);
        }
      }
    }
    // console.log("explain", explain);
    go(explain);
    return {
      newIndexes,
      existingIndexes,
    };
  }
}

export type OptimizeResult =
  | {
      kind: "ok";
      baseCost: number;
      finalCost: number;
      newIndexes: Set<string>;
      existingIndexes: Set<string>;
      triedIndexes: Map<string, IndexRecommendation>;
      explainPlan: object;
    }
  | {
      kind: "zero_cost_plan";
      table: string;
      explainPlan: object;
    };

class RollbackError<T> {
  constructor(public readonly value?: T) {}
}

export type RootIndexCandidate = {
  schema: string;
  table: string;
  column: string;
  sort?: SortContext;
  where?: { nulltest?: NullTestType };
};

export type PermutedIndexCandidate = {
  schema: string;
  table: string;
  columns: RootIndexCandidate[];
  // TODO: functional indexes
  where?: string;
};

export const PROCEED = Symbol("PROCEED");
export const SKIP = Symbol("SKIP");

/**
 * Allows permuting over an array of items.
 * The generator allows the caller to prematurely stop the permutation chain.
 */
export function* permuteWithFeedback<T>(
  arr: T[]
): Generator<T[], void, typeof PROCEED | typeof SKIP> {
  function* helper(
    path: T[],
    rest: T[]
  ): Generator<T[], void, typeof PROCEED | typeof SKIP> {
    let i = 0;
    while (i < rest.length) {
      const nextPath = [...path, rest[i]];
      const nextRest = [...rest.slice(0, i), ...rest.slice(i + 1)];
      const input = yield nextPath;

      if (input === PROCEED) {
        yield* helper(nextPath, nextRest);
      }

      i++;
    }
  }

  yield* helper([], arr);
}
