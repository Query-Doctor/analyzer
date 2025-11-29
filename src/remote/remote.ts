import { Postgres, PostgresFactory } from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { DumpCommand, RestoreCommand } from "../sync/schema-link.ts";

export class Remote {
  constructor(
    private readonly targetDb: Connectable,
    private createPool: PostgresFactory,
  ) {}

  async syncFrom(
    source: Connectable,
    databaseName?: string,
  ): Promise<Postgres> {
    const target = databaseName
      ? this.targetDb.withDatabaseName(databaseName)
      : this.targetDb;
    const dump = DumpCommand.spawn(source, "native-postgres");
    const restore = RestoreCommand.spawn(target);
    await dump.pipeTo(restore);
    return this.onSuccessfulSync(target);
  }

  /**
   * Process a successful sync and run any potential cleanup functions
   */
  private async onSuccessfulSync(
    newConnection: Connectable,
  ): Promise<Postgres> {
    const postgres = this.createPool({ url: newConnection.toString() });
    if (this.targetDb.isSupabase()) {
      // https://gist.github.com/Xetera/067c613580320468e8367d9d6c0e06ad
      await postgres.exec("drop schema if exists extensions cascade");
    }
    return postgres;
  }
}
