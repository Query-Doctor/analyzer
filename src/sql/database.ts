import { z } from "zod";
export const PostgresVersion = z.string().brand("PostgresVersion");
export type PostgresVersion = z.infer<typeof PostgresVersion>;

export interface PostgresTransaction {
  /**
   * Exec a query and return the result as an array of objects.
   */
  exec<T>(query: string, params?: unknown[]): Promise<T[]>;
}

/**
 * A shared interface for all postgres connections.
 * This is required to allow interop between pglite and regular postgres drivers
 */
export interface Postgres extends PostgresTransaction {
  transaction<T>(callback: (tx: PostgresTransaction) => Promise<T>): Promise<T>;
  cursor?<T>(
    query: string,
    params?: unknown[],
    options?: { size?: number },
  ): AsyncGenerator<T, void, unknown>;
  // postgres returns versions as a string
  serverNum(): Promise<PostgresVersion>;
}

export type PostgresConnectionInput = {
  url: string;
};

export type PostgresFactory = (input: PostgresConnectionInput) => Postgres;

// TODO: explain plan scaffolding
export type PostgresExplainPlan = any;

export type PostgresExplainResult = {
  "QUERY PLAN": {
    Plan: PostgresExplainPlan[];
  }[];
};
