import type { Op } from "jsondiffpatch/formatters/jsonpatch";
import type { NamedSchemaChange } from "../site-api.ts";

export type SchemaChangeKind = "added" | "removed" | "changed";

export interface SchemaChangeEntry {
  kind: SchemaChangeKind;
  /** Human label for the object class, e.g. "table", "index", "column". */
  object: string;
  /** Best-effort display name, e.g. "public.users" or "users.users_email_idx". */
  name: string;
  /** For "changed" entries, the dotted sub-path that changed, e.g. "isUnique". */
  detail?: string;
}

export interface SchemaChangeGroup {
  kind: SchemaChangeKind;
  entries: SchemaChangeEntry[];
}

export interface SchemaChangeView {
  hasChanges: boolean;
  total: number;
  groups: SchemaChangeGroup[];
}

const COLLECTION_LABELS: Record<string, string> = {
  tables: "table",
  indexes: "index",
  constraints: "constraint",
  functions: "function",
  extensions: "extension",
  views: "view",
  types: "type",
  triggers: "trigger",
};

const KIND_ORDER: SchemaChangeKind[] = ["added", "removed", "changed"];

interface ParsedPath {
  collection: string;
  /** Remaining segments after the collection + element index. */
  rest: string[];
}

function parsePath(path: string): ParsedPath | null {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const [collection, , ...rest] = segments;
  if (!(collection in COLLECTION_LABELS)) return null;
  return { collection, rest };
}

/**
 * Best-effort display name for a schema object pulled from an add/replace op's
 * `value`. Each FullSchema collection carries different identifying fields, so
 * fall back through the plausible name keys and qualify with the schema where
 * one exists. Returns null when nothing nameable is present (e.g. a `remove` op,
 * which carries no value).
 */
function objectName(collection: string, value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof v[key] === "string" ? (v[key] as string) : undefined;

  const schema = str("schemaName");
  const qualify = (name: string | undefined): string | null => {
    if (!name) return null;
    return schema ? `${schema}.${name}` : name;
  };

  switch (collection) {
    case "tables":
      return qualify(str("tableName"));
    case "indexes": {
      const table = str("tableName");
      const index = str("indexName");
      if (index && table) return `${table}.${index}`;
      return qualify(index);
    }
    case "constraints": {
      const table = str("tableName");
      const constraint = str("constraintName");
      if (constraint && table) return `${table}.${constraint}`;
      return qualify(constraint);
    }
    case "functions":
      return qualify(str("objectName"));
    case "extensions":
      return str("extensionName") ?? null;
    case "views":
      return qualify(str("viewName"));
    case "types":
      return qualify(str("typeName"));
    case "triggers": {
      const table = str("tableName");
      const trigger = str("triggerName");
      if (trigger && table) return `${table}.${trigger}`;
      return qualify(trigger);
    }
    default:
      return null;
  }
}

function entryFromOp(op: Op): SchemaChangeEntry | null {
  if (op.op === "move") return null;
  const parsed = parsePath(op.path);
  if (!parsed) return null;
  const object = COLLECTION_LABELS[parsed.collection];

  // A `replace`/`add` op deeper than the element root (e.g. /indexes/0/isUnique)
  // is a property change on an existing object, not a whole-object add. A `remove`
  // carries no value, so we can only name a whole-object removal, not a property one.
  const isElementRoot = parsed.rest.length === 0;

  if (op.op === "add" && isElementRoot) {
    const name = objectName(parsed.collection, op.value);
    return { kind: "added", object, name: name ?? "(unknown)" };
  }
  if (op.op === "remove" && isElementRoot) {
    // A `remove` op carries no value, so there is no name to print. The line
    // reads "removed index" — the kind prefix already says what happened, which
    // the old "(removed)" placeholder was standing in for.
    return { kind: "removed", object, name: "" };
  }
  // Property-level add/replace, or a nested remove — all "changed" on the object.
  const detail = parsed.rest.length > 0 ? parsed.rest.join(".") : undefined;
  return { kind: "changed", object, name: "", detail };
}

export function buildSchemaChangeView(operations: Op[]): SchemaChangeView {
  const byKind: Record<SchemaChangeKind, SchemaChangeEntry[]> = {
    added: [],
    removed: [],
    changed: [],
  };

  for (const op of operations) {
    const entry = entryFromOp(op);
    if (!entry) continue;
    byKind[entry.kind].push(entry);
  }

  const groups: SchemaChangeGroup[] = KIND_ORDER
    .map((kind) => ({ kind, entries: byKind[kind] }))
    .filter((g) => g.entries.length > 0);

  const total = groups.reduce((sum, g) => sum + g.entries.length, 0);

  return {
    hasChanges: total > 0,
    total,
    groups,
  };
}

/**
 * The view built from the API's named changes. Nothing is inferred here: the
 * API compared the two schemas and says which object changed, so this only
 * groups the entries the way the patch-derived view does.
 */
export function buildNamedSchemaChangeView(
  changes: NamedSchemaChange[],
): SchemaChangeView {
  const byKind: Record<SchemaChangeKind, SchemaChangeEntry[]> = {
    added: [],
    removed: [],
    changed: [],
  };

  for (const change of changes) {
    byKind[change.kind].push({
      kind: change.kind,
      object: change.object,
      name: change.name,
      detail: change.properties?.length
        ? change.properties.join(", ")
        : undefined,
    });
  }

  const groups: SchemaChangeGroup[] = KIND_ORDER
    .map((kind) => ({ kind, entries: byKind[kind] }))
    .filter((g) => g.entries.length > 0);

  const total = groups.reduce((sum, g) => sum + g.entries.length, 0);

  return { hasChanges: total > 0, total, groups };
}

const KIND_LABELS: Record<SchemaChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

/**
 * One-line label for an entry, e.g. "Added table public.users" or
 * "Changed index users.idx · isUnique". Each line states its own kind, so the
 * entries need no group heading above them — which is what lets the block sit
 * tight under its gate row the way every other expansion does.
 */
export function schemaChangeLabel(entry: SchemaChangeEntry): string {
  const object = entry.name ? `${entry.object} ${entry.name}` : entry.object;
  const base = `${KIND_LABELS[entry.kind]} ${object}`;
  return entry.detail ? `${base} · ${entry.detail}` : base;
}
