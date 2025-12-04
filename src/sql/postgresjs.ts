import postgres from "postgresjs";
import {
  type Postgres,
  type PostgresTransaction,
  PostgresVersion,
} from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";

type PgConnectionOptions = postgres.Options<
  Record<string, postgres.PostgresType>
>;

const DEFAULT_ITEMS_PER_PAGE = 20;
// we want to set a very low idle timeout to prevent
// clogging up connections
const DEFAULT_IDLE_TIMEOUT_SECONDS = 15;
// it's ok to recycle connections frequently if needed
const DEFAULT_MAX_LIFETIME_SECONDS = 60 * 5;

/**
 * Connecting to the local optimizer
 */
export function connectToOptimizer(connectable: Connectable) {
  const connectionOptions: PgConnectionOptions = {
    max: 100,
  };

  return connect(connectable, connectionOptions);
}

/**
 * Connect to the source database to pull data out.
 * We have to be a lot more conservative here
 * and make sure the connections drop asap to prevent
 * exhausting them
 */
export function connectToSource(
  connectable: Connectable,
) {
  const connectionOptions: PgConnectionOptions = {
    max: 20,
    max_lifetime: DEFAULT_MAX_LIFETIME_SECONDS,
    idle_timeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
  };

  return connect(connectable, connectionOptions);
}

function connect(connectable: Connectable, options: PgConnectionOptions) {
  const pg = postgres(connectable.toString(), options);
  return wrapGenericPostgresInterface(pg);
}

export function wrapGenericPostgresInterface(pg: postgres.Sql): Postgres {
  return {
    exec: (query, params) => {
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
