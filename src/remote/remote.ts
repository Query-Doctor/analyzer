import { PgIdentifier, type Postgres } from "@query-doctor/core";
import { type Connectable } from "../sync/connectable.ts";
import { DumpCommand, RestoreCommand } from "../sync/schema-link.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { type RecentQuery } from "../sql/recent-query.ts";
import { type FullSchema, SchemaDiffer } from "../sync/schema_differ.ts";
import { type RemoteSyncResponse } from "./remote.dto.ts";

/**
 * Represents a db for doing optimization work.
 * We only maintain one instance of this class as we only do
 * optimization against one physical postgres database.
 * But potentially more logical databases in the future.
 */
export class Remote {
  static readonly baseDbName = PgIdentifier.fromString("postgres");
  static readonly optimizingDbName = PgIdentifier.fromString(
    "optimizing_db",
  );

  private readonly differ = new SchemaDiffer();

  /**
   * We have to juggle 2 different connections to the Remote
   *
   * 1 -> connection to `/postgres` where we manage other databases.
   *      this pool stays connected long-term. That's this variable
   *
   * 2 -> connections to {@link Remote.databaseName}. This connection pool is
   *      destroyed and re-created on each successful sync along with the db itself
   */
  private readonly baseDb: Postgres;

  constructor(
    /** This has to be a local url. Very bad things will happen if this is a remote URL */
    private readonly targetURL: Connectable,
    private readonly manager: ConnectionManager,
  ) {
    const baseUrl = targetURL.withDatabaseName(Remote.baseDbName);
    this.baseDb = this.manager.getOrCreateConnection(baseUrl);
  }

  async syncFrom(source: Connectable): Promise<RemoteSyncResponse> {
    await this.resetDatabase();
    const target = this.targetURL.withDatabaseName(Remote.optimizingDbName);
    const sql = this.manager.getOrCreateConnection(source);
    const [_restoreResult, recentQueries, fullSchema] = await Promise
      .allSettled([
        // This potentially creates a lot of connections to the source
        this.pipeSchema(target, source),
        this.getRecentQueries(source),
        this.getFullSchema(source),
      ]);

    if (fullSchema.status === "fulfilled") {
      this.differ.put(sql, fullSchema.value);
    }

    const pg = this.manager.getOrCreateConnection(this.targetURL);
    await this.onSuccessfulSync(pg);

    return {
      queries: recentQueries.status === "fulfilled"
        ? {
          type: "ok",
          value: recentQueries.value,
        }
        : {
          type: "error",
          error: recentQueries.reason instanceof Error
            ? recentQueries.reason.message
            : "Unknown error",
        },
      schema: fullSchema.status === "fulfilled"
        ? { type: "ok", value: fullSchema.value }
        : {
          type: "error",
          error: fullSchema.reason instanceof Error
            ? fullSchema.reason.message
            : "Unknown error",
        },
    };
  }

  /**
   * Drops and recreates the {@link Remote.optimizingDbName} db.
   *
   * TODO: allow juggling multiple databases in the future
   */
  private async resetDatabase(): Promise<void> {
    const databaseName = Remote.optimizingDbName;
    // these cannot be run in the same `exec` block as that implicitly creates transactions
    await this.baseDb.exec(
      // drop database does not allow parameterization
      `drop database if exists ${databaseName} with (force);`,
    );
    await this.baseDb.exec(`create database ${databaseName};`);
  }

  private async pipeSchema(
    target: Connectable,
    source: Connectable,
  ): Promise<void> {
    const dump = DumpCommand.spawn(source, "native-postgres");
    const restore = RestoreCommand.spawn(target);
    const { dump: dumpResult, restore: restoreResult } = await dump.pipeTo(
      restore,
    );
    if (dumpResult.error) {
      console.error(dumpResult.error);
    }
    if (!dumpResult.status.success) {
      throw new Error(
        `Dump failed with status ${dumpResult.status.code}\n${dumpResult.error}`,
      );
    }
    if (restoreResult?.error) {
      console.error(restoreResult.error);
    }
    if (restoreResult && !restoreResult.status.success) {
      console.log(restoreResult.error);
      throw new Error(
        `Restore failed with status ${restoreResult.status.code}\n${restoreResult.error}`,
      );
    }
  }

  private getRecentQueries(
    source: Connectable,
  ): Promise<RecentQuery[]> {
    const connector = this.manager.getConnectorFor(source);
    return connector.getRecentQueries();
  }

  private getFullSchema(source: Connectable): Promise<FullSchema> {
    const connector = this.manager.getConnectorFor(source);
    return connector.getSchema();
  }

  /**
   * Process a successful sync and run any potential cleanup functions
   */
  private async onSuccessfulSync(postgres: Postgres): Promise<void> {
    if (this.targetURL.isSupabase()) {
      // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
      await postgres.exec("drop schema if exists extensions cascade");
    }
  }
}
