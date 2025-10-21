import postgres from "postgresjs";
import {
  type Postgres,
  type PostgresConnectionInput,
  type PostgresTransaction,
  PostgresVersion,
} from "@query-doctor/core";

const DEFAULT_ITEMS_PER_PAGE = 20;

export function wrapGenericPostgresInterface(
  input: PostgresConnectionInput,
): Postgres {
  let pg: postgres.Sql;
  if ("url" in input) {
    pg = postgres(input.url, { max: 20 });
  } else {
    throw new Error("Invalid input");
  }
  return {
    exec: async (query, params) => {
      return pg.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
    },
    serverNum: async () =>
      PostgresVersion.parse(
        (await pg.unsafe(`show server_version_num`))[0].server_version_num,
      ),
    transaction: async <T>(
      callback: (tx: PostgresTransaction) => Promise<T>,
    ) => {
      const result = await pg.begin<T>((tx) => {
        const transaction: PostgresTransaction = {
          exec: tx.unsafe,
        };
        return callback(transaction);
      });
      // TODO: is this safe?
      return result as Promise<T>;
    },
    async *cursor<T>(
      query: string,
      params?: unknown[],
      options?: { size?: number },
    ) {
      const result = pg
        .unsafe(query, params as postgres.ParameterOrJSON<never>[])
        .cursor(options?.size ?? DEFAULT_ITEMS_PER_PAGE);
      for await (const row of result) {
        // TODO: is this safe?
        yield* row as T[];
      }
    },
  };
}
