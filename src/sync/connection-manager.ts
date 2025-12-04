import type { Postgres } from "@query-doctor/core";
import { SegmentedQueryCache } from "./seen-cache.ts";
import { Connectable } from "./connectable.ts";
import { PostgresConnector } from "./pg-connector.ts";
import { connectToOptimizer, connectToSource } from "../sql/postgresjs.ts";

/**
 * Manages connections and query caches for each connection
 */
export class ConnectionManager {
  readonly segmentedQueryCache = new SegmentedQueryCache();

  // This prevents connections being garbage collected.
  // ConnectionMap should be responsible for closing connections
  private readonly connections = new Map<string, Postgres>();

  constructor(
    private readonly factory: (connectable: Connectable) => Postgres,
  ) {}

  /**
   * Create a connection manager with default settings
   * optimized for connecting to local dbs (used for optimizing)
   */
  static forLocalDatabase() {
    return new ConnectionManager(connectToOptimizer);
  }

  /**
   * Create a connection manager with default settings
   * optimized for connecting to remote dbs (given by users)
   */
  static forRemoteDatabase() {
    return new ConnectionManager(connectToSource);
  }

  getOrCreateConnection(connectable: Connectable): Postgres {
    const urlString = connectable.toString();
    let sql = this.connections.get(urlString);
    if (!sql) {
      sql = this.factory(connectable);
      this.connections.set(urlString, sql);
    }
    return sql;
  }

  getConnectorFor(input: Connectable | Postgres): PostgresConnector {
    const sql = input instanceof Connectable
      ? this.getOrCreateConnection(input)
      : input;
    return new PostgresConnector(sql, this.segmentedQueryCache);
  }
}
