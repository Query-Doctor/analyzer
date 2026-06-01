import { create } from "jsondiffpatch";
import { format, type Op } from "jsondiffpatch/formatters/jsonpatch";
import { Connectable } from "./connectable.ts";
import { FullSchema } from "@query-doctor/core";

export class SchemaDiffer {
  private readonly differ = create({
    arrays: { detectMove: true },
    objectHash(obj, index) {
      // shouldn't happen but we don't want to throw an error for this
      if (!("type" in obj)) {
        return index?.toString();
      }
      // we want to use oid to determine a "unique" item
      // but not every identifer has a valid stable identifier
      // eg (individual column references of indexes)
      switch (obj.type) {
        case "table":
        case "index":
        case "constraint":
          if (!("oid" in obj)) {
            throw new Error("oid is required for index results");
          }
          return String(obj.oid);
        default:
          return index?.toString();
      }
    },
  });

  private readonly stats = new WeakMap<Connectable, FullSchema>();

  put(postgres: Connectable, schema: FullSchema): Op[] | undefined {
    const old = this.stats.get(postgres);
    if (!old) {
      this.stats.set(postgres, schema);
      return;
    }
    this.stats.set(postgres, schema);
    const results = this.differ.diff(old, schema);
    if (!results) {
      return;
    }
    return format(results);
  }
}

