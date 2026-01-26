import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { FullSchema, SchemaDiffer } from "../sync/schema_differ.ts";

export class SchemaLoader {
  constructor(
    private readonly sourceManager: ConnectionManager,
    private readonly connectable: Connectable,
  ) {}

  private readonly differ = new SchemaDiffer();

  async poll() {
    const connector = this.sourceManager.getConnectorFor(this.connectable);
    const schema = await connector.getSchema();

    const diffs = this.update(schema) ?? [];
    return { diffs };
  }

  update(fullSchema: FullSchema) {
    return this.differ.put(this.connectable, fullSchema);
  }
}
