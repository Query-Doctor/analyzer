import { Postgres, PostgresFactory } from "@query-doctor/core";
import { SegmentedQueryCache } from "./seen-cache.ts";
import { Connectable } from "./connectable.ts";
import { PostgresConnector } from "./pg-connector.ts";

/**
 * Manages connections and query caches for each connection
 */
export class ConnectionManager {
  readonly segmentedQueryCache = new SegmentedQueryCache();

  // This prevents connections being garbage collected.
  // ConnectionMap should be responsible for closing connections
  private readonly connections = new Map<string, Postgres>();

  constructor(private readonly factory: PostgresFactory) {}

  getOrCreateConnection(connectable: Connectable): Postgres {
    const urlString = connectable.toString();
    let sql = this.connections.get(urlString);
    if (!sql) {
      sql = this.factory({ url: urlString });
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
