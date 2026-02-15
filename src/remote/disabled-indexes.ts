import { PgIdentifier } from "@query-doctor/core";

/**
 * A class representing disabled indexes for the
 * sole purpose of exposing a {@link PgIdentifier} interface.
 */
export class DisabledIndexes {
  private readonly disabledIndexNames = new Set<string>();

  add(indexName: PgIdentifier): void {
    this.disabledIndexNames.add(indexName.toString());
  }

  remove(indexName: PgIdentifier): boolean {
    return this.disabledIndexNames.delete(indexName.toString());
  }

  has(indexName: PgIdentifier): boolean {
    return this.disabledIndexNames.has(indexName.toString());
  }

  /**
   * Toggles the visibility of the index
   * @returns is the boolean disabled?
   */
  toggle(indexName: PgIdentifier): boolean {
    const deleted = this.remove(indexName);
    if (!deleted) {
      this.add(indexName);
      return true;
    }
    return false;
  }

  *[Symbol.iterator](): Iterator<PgIdentifier> {
    for (const indexName of this.disabledIndexNames) {
      yield PgIdentifier.fromString(indexName);
    }
  }
}
