import { Pool, type PoolConfig } from "pg";
import Cursor from "pg-cursor";
import {
  type Postgres,
  type PostgresTransaction,
  PostgresVersion,
} from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { log } from "../log.ts";

const DEFAULT_ITEMS_PER_PAGE = 20;
// we want to set a very low idle timeout to prevent
// clogging up connections
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
// it's ok to recycle connections frequently if needed
const DEFAULT_MAX_LIFETIME_MS = 60 * 5 * 1000;

/**
 * Connecting to the local optimizer
 */
export function connectToOptimizer(connectable: Connectable) {
  const hostname = connectable.url.searchParams.get("host");
  const baseConfig: PoolConfig = {
    max: 100,
  };

  if (hostname) {
    const database = connectable.url.pathname.slice(1);
    const config: PoolConfig = {
      ...baseConfig,
      user: "postgres",
      database,
      host: hostname,
    };
    const pool = new Pool(config);
    return wrapPgPool(pool);
  } else {
    log.info(
      `Connecting to optimizing db ${connectable} using custom POSTGRES_URL`,
      "postgres",
    );
    return connect(connectable, baseConfig);
  }
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
  const config: PoolConfig = {
    max: 20,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };

  return connect(connectable, config);
}

/**
 * node-pg treats sslmode=require as rejectUnauthorized: true,
 * but PostgreSQL semantics for "require" only mean "encrypt the connection"
 * without verifying the server certificate. This breaks self-signed certs.
 */
export function getSslConfig(connectable: Connectable): PoolConfig["ssl"] {
  const sslmode = connectable.url.searchParams.get("sslmode");
  if (!sslmode || sslmode === "disable") return undefined;
  if (sslmode === "verify-full" || sslmode === "verify-ca") return true;
  // require, prefer, allow — encrypt but accept self-signed certificates
  return { rejectUnauthorized: false };
}

function connect(connectable: Connectable, config: PoolConfig) {
  const ssl = getSslConfig(connectable);
  // Strip sslmode from the connection string so pg-connection-string
  // doesn't override our explicit ssl config (it treats require as verify-full)
  const url = new URL(connectable.toString());
  url.searchParams.delete("sslmode");
  const pool = new Pool({
    ...config,
    connectionString: url.toString(),
    ...(ssl !== undefined && { ssl }),
  });
  return wrapPgPool(pool);
}

/**
 * Arrays are supported BUT only for primitive values.
 * For anything else jsonb has to be serialized
 */
function serializeArray(arr: unknown[]): unknown[] | string {
  const allPrimitiveValues = arr.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  if (allPrimitiveValues) {
    return arr;
  }
  return JSON.stringify(arr);
}

/**
 * node-postgres does not serialize jsonb in an expected way
 */
function serializeParams(params?: unknown[]): unknown[] | undefined {
  if (!params) return params;
  return params.map((p) => {
    if (p === null || p === undefined) {
      return p;
    }
    if (Array.isArray(p) && p.length > 0) {
      return serializeArray(p);
    }
    if (typeof p === "object" && !(p instanceof Buffer)) {
      return JSON.stringify(p);
    }
    return p;
  });
}

export function wrapPgPool(pool: Pool): Postgres {
  // Handle idle client errors to prevent process crashes.
  // Expected during DROP DATABASE ... WITH (FORCE) which terminates
  // all connections to the target database.
  pool.on("error", (err) => {
    log.warn(`Pool idle client error: ${err.message}`, "postgres");
  });

  return {
    exec: async (query, params) => {
      const result = await pool.query(query, serializeParams(params) as any[]);
      return result.rows;
    },
    serverNum: async () => {
      const result = await pool.query("show server_version_num");
      return PostgresVersion.parse(result.rows[0].server_version_num);
    },
    transaction: async <T>(
      callback: (tx: PostgresTransaction) => Promise<T>,
    ) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let savepointCounter = 0;
        // Serialize exec calls to prevent savepoint interleaving
        // when callers use Promise.all (matches postgres.js behavior)
        let queue: Promise<void> = Promise.resolve();
        const transaction: PostgresTransaction = {
          exec: (query, params) => {
            const doExec = async () => {
              const sp = "sp_" + savepointCounter++;
              await client.query("SAVEPOINT " + sp);
              try {
                const result = await client.query(query, serializeParams(params) as any[]);
                await client.query("RELEASE SAVEPOINT " + sp);
                return result.rows;
              } catch (error) {
                await client.query("ROLLBACK TO SAVEPOINT " + sp);
                throw error;
              }
            };
            const result = queue.then(doExec, doExec);
            queue = result.then(() => { }, () => { });
            return result;
          },
        };
        const result = await callback(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async *cursor<T>(
      query: string,
      params?: unknown[],
      options?: { size?: number },
    ) {
      const client = await pool.connect();
      try {
        const cursor = client.query(new Cursor(query, serializeParams(params) as any[]));
        const batchSize = options?.size ?? DEFAULT_ITEMS_PER_PAGE;
        let rows = await cursor.read(batchSize);
        while (rows.length > 0) {
          yield* rows as T[];
          rows = await cursor.read(batchSize);
        }
        await cursor.close();
      } finally {
        client.release();
      }
    },
    // @ts-expect-error | this will be added to the pg interface later
    close() {
      return pool.end();
    },
  };
}
