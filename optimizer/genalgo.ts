import { gray, green, red } from "@std/fmt/colors";
import postgres from "postgresjs";
import { IndexedTable, TableMetadata } from "./statistics.ts";
import { IndexIdentifier } from "../reporters/reporter.ts";
import { DEBUG } from "../env.ts";

type IndexRecommendation = PermutedIndexCandidate & {
  definition: IndexIdentifier;
};

export class IndexOptimizer {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly existingIndexes: IndexedTable[]
  ) {}

  async run(
    query: string,
    params: string[],
    indexes: RootIndexCandidate[],
    tables: TableMetadata[]
  ): Promise<OptimizeResult> {
    const baseExplain = await this.runWithReltuples(query, params, tables);
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
    console.log(baseIndexes);
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
        const explain = await this.runWithReltuples(
          query,
          params,
          tables,
          async (sql) => {
            const indexName = `__qd_${schema}_${table}_${columns.join("_")}`;
            const indexDefinitionRaw = `${schema}.${table}(${columns
              .map((c) => `"${c}"`)
              .join(", ")})`;
            const shortenedSchema = schema === "public" ? "" : `${schema}.`;
            // TODO: this is silly, turn this into a data structure here ONLY
            const indexDefinitionClean = `${shortenedSchema}${table}(${columns
              .map((c) => `"${c}"`)
              .join(", ")})`;
            indexDefinition = `${shortenedSchema}${table}(${columns
              .map((c) => green(`"${c}"`))
              .join(", ")})`;
            const sqlString = `create index ${indexName} on ${indexDefinitionRaw};`;
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
                : ` ${red(
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
    const finalExplain = await this.runWithReltuples(
      query,
      params,
      tables,
      async (sql) => {
        for (const { table, schema, columns } of nextStage) {
          await sql.unsafe(
            `create index __qd_${schema}_${table}_${columns.join(
              "_"
            )} on ${schema}.${table}(${columns
              .map((c) => `"${c}"`)
              .join(",")}); -- @qd_introspection`
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
        ` 👍👍👍 ${gray("If there's a better index, we haven't tried it")}`
      );
    }
    const { newIndexes, existingIndexes: existingIndexesUsedByQuery } =
      this.findUsedIndexes(finalExplain);
    return {
      kind: "ok",
      baseCost,
      finalCost: Number(finalExplain["Total Cost"]),
      newIndexes,
      existingIndexes: existingIndexesUsedByQuery,
      triedIndexes,
      explainPlan: finalExplain,
    };
  }

  private indexAlreadyExists(
    table: string,
    columns: string[]
  ): IndexedTable | undefined {
    return this.existingIndexes.find(
      (index) =>
        index.index_type === "btree" &&
        index.table_name === table &&
        index.index_columns.length === columns.length &&
        index.index_columns.every((c, i) => columns[i] === c.name)
    );
  }

  async runWithReltuples(
    query: string,
    params: string[],
    allTableNames: TableMetadata[],
    f?: (sql: postgres.Sql) => Promise<void>
  ): Promise<any> {
    try {
      await this.sql.begin(async (sql) => {
        await f?.(sql);
        const reltuplesTrick = `update pg_class set reltuples = 1000000, relpages = 1000 where relname IN (${allTableNames
          .map((t) => `'${t.tableName}'`)
          .join(",")}); -- @qd_introspection`;
        await sql.unsafe(reltuplesTrick);
        const explainString = `explain (generic_plan, verbose, format json) ${query} -- @qd_introspection`;
        const result = await sql.unsafe(explainString, params as any);
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
      { schema: string; table: string; columns: Set<string> }
    > = new Map();
    for (const index of indexes) {
      const existing = tableColumns.get(`${index.schema}.${index.table}`);
      if (existing) {
        existing.columns.add(index.column);
      } else {
        tableColumns.set(`${index.schema}.${index.table}`, {
          table: index.table,
          schema: index.schema,
          columns: new Set([index.column]),
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
  // TODO: functional indexes
  column: string;
  where?: string;
};

export type PermutedIndexCandidate = {
  schema: string;
  table: string;
  columns: string[];
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
