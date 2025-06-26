import postgres from "postgresjs";
import { TableMetadata } from "./statistics.ts";

type IndexRecommendation = PermutedIndexCandidate & {
  definition: string;
};

export class IndexOptimizer {
  constructor(private readonly sql: postgres.Sql) {}

  async run(
    query: string,
    params: unknown[],
    indexes: RootIndexCandidate[],
    tables: TableMetadata[]
  ) {
    const baseExplain = await this.runWithReltuples(query, params, tables);
    const baseCost = baseExplain["Total Cost"];
    console.log("Base cost with current indexes", baseCost);
    const permutedIndexes = this.tableColumnIndexCandidates(indexes);
    const nextStage: PermutedIndexCandidate[] = [];
    const triedIndexes: Map<string, IndexRecommendation> = new Map();
    // const permutedIndexes = permuteWithFeedback(indexes);
    await this.sql`vacuum;`;
    for (const { table, schema, columns } of permutedIndexes.values()) {
      const permutations = permuteWithFeedback(Array.from(columns));
      let iter;
      let previousCost: number = baseCost;
      let decision: typeof PROCEED | typeof SKIP = PROCEED;
      do {
        console.log(`Calling ${String(decision)} on ${table}`);
        iter = permutations.next(decision);
        if (iter.done) {
          console.log("No more reasonable permutations to try. Going to next");
          break;
        }
        const columns = iter.value;
        const explain = await this.runWithReltuples(
          query,
          params,
          tables,
          async (sql) => {
            const indexName = `__qd_${schema}_${table}_${columns.join("_")}`;
            const indexDefinition = `${schema}.${table}(${columns
              .map((c) => `"${c}"`)
              .join(", ")})`;
            const sqlString = `create index ${indexName} on ${indexDefinition};`;
            triedIndexes.set(indexName, {
              schema,
              table,
              columns,
              definition: indexDefinition,
            });
            console.log(sqlString);
            await sql.unsafe(`${sqlString} -- @qd_introspection`);
            console.log(
              `trying index ${table}(${Array.from(columns)
                .map((c) => `"${c}"`)
                .join(",")});`
            );
          }
        );
        console.log(
          "Previous cost",
          previousCost,
          "Current cost",
          explain["Total Cost"]
        );
        if (previousCost > explain["Total Cost"]) {
          decision = PROCEED;
          previousCost = explain["Total Cost"];
        } else {
          decision = SKIP;
          previousCost = baseCost;
        }
        console.log("Total cost", explain["Total Cost"]);
        console.log("--------------------------------");
        nextStage.push({
          schema,
          table,
          columns,
        });
      } while (!iter.done);
    }
    console.log("Adding ALL indexes");
    // console.log(nextStage);
    try {
      await this.sql`vacuum pg_class;`;
    } catch (err) {
      console.error(err);
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
    console.dir(finalExplain, { depth: null });
    console.log(
      "Final cost",
      finalExplain["Total Cost"],
      "Base cost",
      baseCost
    );
    const { newIndexes, existingIndexes } = this.findUsedIndexes(finalExplain);
    return {
      baseCost,
      finalCost: finalExplain["Total Cost"],
      newIndexes,
      existingIndexes,
      triedIndexes,
    };
  }

  async runWithReltuples(
    query: string,
    params: unknown[],
    allTableNames: TableMetadata[],
    f?: (sql: postgres.Sql) => Promise<void>
  ): Promise<any> {
    try {
      await this.sql.begin(async (sql) => {
        await f?.(sql);
        const reltuplesTrick = `update pg_class set reltuples = 1000000 where relname IN (${allTableNames
          .map((t) => `'${t.tableName}'`)
          .join(",")}) returning relname, reltuples; -- @qd_introspection`;
        // console.log(reltuplesTrick);
        const updateds = await sql.unsafe(reltuplesTrick);
        const explainString = `explain (analyze, verbose, format json) ${query} -- @qd_introspection`;
        // console.log(explainString);
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
