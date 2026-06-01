import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { SchemaDiffer } from "../sync/schema_differ.ts";
import { dumpSchema, FullSchema } from "@query-doctor/core";

export class SchemaLoader {
  constructor(
    private readonly sourceManager: ConnectionManager,
    private readonly connectable: Connectable,
  ) { }

  private readonly differ = new SchemaDiffer();
  private latestSchema?: FullSchema;

  getLatestSchema(): FullSchema | undefined {
    return this.latestSchema;
  }

  async poll() {
    const connector = this.sourceManager.getOrCreateConnection(this.connectable);
    const schema = await dumpSchema(connector);
    const diffs = this.update(schema) ?? [];
    return { diffs };
  }

  update(schema: FullSchema) {
    this.latestSchema = schema;
    return this.differ.put(this.connectable, schema);
  }
}
