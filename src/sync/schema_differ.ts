import type { Postgres } from "@query-doctor/core";
import { create } from "jsondiffpatch";
import { format, type Op } from "jsondiffpatch/formatters/jsonpatch";
import { z } from "zod";

export class SchemaDiffer {
  private differ = create({
    arrays: { detectMove: true, },
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

  private stats: Map<Postgres, FullSchema> = new Map();

  put(postgres: Postgres, schema: FullSchema): Op[] | undefined {
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

export const FullSchemaKeyColumn = z.object({
  type: z.literal("indexColumn"),
  name: z.string(),
  order: z.enum(["ASC", "DESC"]).optional(),
  nulls: z.enum(["FIRST", "LAST"]).optional(),
  opclass: z.string().optional(),
  collation: z.string().optional(),
});

export type FullSchemaKeyColumn = z.infer<typeof FullSchemaKeyColumn>;

export const FullSchemaIncludedColumn = z.object({
  name: z.string(),
});

export type FullSchemaIncludedColumn = z.infer<typeof FullSchemaIncludedColumn>;

export const FullSchemaIndex = z.object({
  type: z.literal("index"),
  oid: z.number(),
  schemaName: z.string(),
  tableName: z.string(),
  indexName: z.string(),
  indexType: z.string(),
  isUnique: z.boolean(),
  isPrimary: z.boolean(),
  isClustered: z.boolean(),
  wherePredicate: z.string().optional(),
  tablespace: z.string().optional(),
  keyColumns: z.array(FullSchemaKeyColumn),
  includedColumns: z.array(FullSchemaIncludedColumn).optional(),
});

export type FullSchemaIndex = z.infer<typeof FullSchemaIndex>;

export const FullSchemaColumn = z.object({
  type: z.literal("column"),
  name: z.string(),
  order: z.number(),
  columnType: z.string(),
  isNullable: z.boolean(),
  defaultValue: z.string().optional(),
  dropped: z.boolean(),
  collation: z.string().optional(),
  storage: z.enum(["plain", "main", "external", "extended"]).optional(),
  isIdentity: z.enum(["always", "by default"]).optional(),
});

export type FullSchemaColumn = z.infer<typeof FullSchemaColumn>;

export const FullSchemaTable = z.object({
  type: z.literal("table"),
  oid: z.number(),
  schemaName: z.string(),
  tableName: z.string(),
  tablespace: z.string().optional(),
  partitionKeyDef: z.string().optional(),
  // tables without columns do exist
  columns: z.array(FullSchemaColumn).default([]),
});

export type FullSchemaTable = z.infer<typeof FullSchemaTable>;

export const FullSchemaConstraint = z.object({
  type: z.literal("constraint"),
  oid: z.number(),
  schemaName: z.string(),
  tableName: z.string(),
  constraintName: z.string(),
  constraintType: z.enum([
    "check",
    "foreign_key",
    "primary_key",
    "unique",
    "exclusion",
  ]),
  definition: z.string(),
  isDeferrable: z.boolean().optional(),
  isInitiallyDeferred: z.boolean().optional(),
  isValidated: z.boolean().optional(),
  backingIndexOid: z.number().optional(),
});

export type FullSchemaConstraint = z.infer<typeof FullSchemaConstraint>;

export const FullSchemaFunction = z.object({
  type: z.literal("function"),
  schemaName: z.string(),
  objectName: z.string(),
  objectType: z.enum(["function", "procedure", "aggregate", "window function"]),
  identityArguments: z.string().optional(),
  definition: z.string(),
});

export type FullSchemaFunction = z.infer<typeof FullSchemaFunction>;

export const FullSchemaExtension = z.object({
  extensionName: z.string(),
  version: z.string(),
  schemaName: z.string(),
});

export type FullSchemaExtension = z.infer<typeof FullSchemaExtension>;

export const FullSchemaView = z.object({
  type: z.literal("view"),
  schemaName: z.string(),
  viewName: z.string(),
  objectType: z.enum(["view", "materialized_view"]),
  definition: z.string(),
  tablespace: z.string().optional(),
});

export type FullSchemaView = z.infer<typeof FullSchemaView>;

export const FullSchemaTypeConstraint = z.object({
  name: z.string(),
  definition: z.string(),
});

export type FullSchemaTypeConstraint = z.infer<typeof FullSchemaTypeConstraint>;

export const FullSchemaCompositeAttribute = z.object({
  type: z.literal("compositeAttribute"),
  name: z.string(),
  attributeType: z.string(),
  collation: z.string().optional(),
});

export type FullSchemaCompositeAttribute = z.infer<
  typeof FullSchemaCompositeAttribute
>;

export const FullSchemaType = z.object({
  type: z.literal("type"),
  schemaName: z.string(),
  typeName: z.string(),
  typeCategory: z.enum(["enum", "domain", "composite"]),
  enumLabels: z.array(z.string()).optional(),
  domainBaseType: z.string().optional(),
  domainIsNotNull: z.boolean().optional(),
  domainDefault: z.string().optional(),
  domainConstraints: z.array(FullSchemaTypeConstraint).optional(),
  compositeAttributes: z.array(FullSchemaCompositeAttribute).optional(),
});

export type FullSchemaType = z.infer<typeof FullSchemaType>;

export const FullSchemaTrigger = z.object({
  schemaName: z.string(),
  tableName: z.string(),
  triggerName: z.string(),
  definition: z.string(),
  enabledMode: z.string(),
});

export type FullSchemaTrigger = z.infer<typeof FullSchemaTrigger>;

export const FullSchema = z.object({
  indexes: z.array(FullSchemaIndex).default([]),
  tables: z.array(FullSchemaTable).default([]),
  constraints: z.array(FullSchemaConstraint).default([]),
  functions: z.array(FullSchemaFunction).default([]),
  extensions: z.array(FullSchemaExtension).default([]),
  views: z.array(FullSchemaView).default([]),
  types: z.array(FullSchemaType).default([]),
  triggers: z.array(FullSchemaTrigger).default([]),
});

export type FullSchema = z.infer<typeof FullSchema>;
