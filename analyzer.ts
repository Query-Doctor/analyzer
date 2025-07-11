import type { ParseResult, Node } from "@pgsql/types";
import { parse } from "@libpg-query/parser";
import { deparseSync } from "pgsql-deparser";
import { RootIndexCandidate } from "./optimizer/genalgo.ts";
import { ExportedStats } from "./optimizer/statistics.ts";
import {
  magenta,
  blue,
  yellow,
  bgMagenta,
  bgBrightMagenta,
} from "@std/fmt/colors";

export interface DatabaseDriver {
  query(query: string, params: unknown[]): Promise<unknown[]>;
}

export const ignoredIdentifier = "__qd_placeholder";

// type ColumnReferenceKind = "valid" | "select" | "" | "functionCallArg";

type TransactionResult<T> =
  | {
      kind: "commit";
      result: T;
    }
  | {
      kind: "rollback";
      result?: T;
    };

interface TransactionDatabaseDriver extends DatabaseDriver {
  transaction<T>(
    callback: (tx: DatabaseDriver) => Promise<TransactionResult<T>>
  ): Promise<TransactionResult<T>>;
}

type ColumnReferencePart = {
  /** the text of the column reference (excluding any potential quotes) */
  text: string;
  start?: number;
  quoted: boolean;
  alias?: string;
};

type DiscoveredColumnReference = {
  /** How often the column reference appears in the query. */
  frequency: number;
  /**
   * Representation of the column reference exactly
   * as it appears in the query.
   */
  representation: string;
  /**
   * Parts of the column reference separated by dots in the query.
   * The table reference (if it exists) is resolved if the query
   * uses an alias.
   *
   * Has 3 different potential configurations (in theory)
   * `a.b.c` - a column reference with a table and a schema reference
   * `a.b` - a column reference with a table reference but no schema
   * `a` - a column reference with no table reference.
   *
   * We use a simple array here to allow parsing of any syntactically correct
   * but logically incorrect query. The checks happen later when we're deriving
   * potential indexes from parts of a column reference in `deriveIndexes`
   */
  parts: ColumnReferencePart[];
  /**
   * Whether the column reference is invalid. This
   */
  ignored: boolean;
  /** The position of the column reference in the query. */
  position: {
    start: number;
    end: number;
  };
};

/**
 * Analyzes a query and returns a list of column references that
 * should be indexed.
 *
 * This should be instantiated once per analyzed query.
 */
export class Analyzer {
  private readonly mappings = new Map<string, ColumnReferencePart>();
  private readonly tempTables = new Set<string>();

  async analyze(
    query: string,
    /** We don't use parameters at all... for now */
    _params: unknown[]
  ): Promise<{
    indexesToCheck: DiscoveredColumnReference[];
    ansiHighlightedQuery: string;
    referencedTables: string[];
    shadowedAliases: ColumnReferencePart[];
  }> {
    this.mappings.clear();
    this.tempTables.clear();
    const highlightPositions = new Set<number>();
    // used for tallying the amount of times we see stuff so
    // we have a better idea of what to start off the algorithm with
    const seenReferences = new Map<string, number>();
    const ast = (await parse(query)) as ParseResult;
    const shadowedAliases: ColumnReferencePart[] = [];
    if (!ast.stmts) {
      throw new Error("Query did not have any statements");
    }
    const stmt = ast.stmts[0].stmt;
    if (!stmt) {
      throw new Error("Query did not have any statements");
    }
    const highlights: DiscoveredColumnReference[] = [];
    function add(
      node: Extract<Node, { ColumnRef: unknown }>,
      ignored?: boolean
    ) {
      if (!node.ColumnRef.location) {
        console.error(`Node did not have a location. Skipping`, node);
        return;
      }
      if (!node.ColumnRef.fields) {
        console.error(node);
        throw new Error("Column reference must have fields");
      }
      let runningLength: number = node.ColumnRef.location;
      const parts: ColumnReferencePart[] = node.ColumnRef.fields.map(
        (field, i, length) => {
          if (!is(field, "String") || !field.String.sval) {
            const out = deparseSync(field);
            ignored = true;
            return {
              quoted: out.startsWith('"'),
              text: out,
              start: runningLength,
            };
          }
          const start = runningLength;
          const size = field.String.sval?.length ?? 0;
          let quoted = false;
          if (node.ColumnRef.location !== undefined) {
            const boundary = query[runningLength];
            if (boundary === '"') {
              quoted = true;
            }
          }
          // +1 for the dot that comes after
          const isLastIteration = i === length.length - 1;
          runningLength += size + (isLastIteration ? 0 : 1) + (quoted ? 2 : 0);
          return {
            text: field.String.sval,
            start,
            quoted,
          };
        }
      );
      const end = runningLength;
      if (highlightPositions.has(node.ColumnRef.location)) {
        return;
      }
      highlightPositions.add(node.ColumnRef.location);
      const highlighted = `${query.slice(node.ColumnRef.location, end)}`;
      const seen = seenReferences.get(highlighted);
      if (!ignored) {
        seenReferences.set(highlighted, (seen ?? 0) + 1);
      }
      highlights.push({
        frequency: seen ?? 1,
        representation: highlighted,
        parts,
        ignored: ignored ?? false,
        position: {
          start: node.ColumnRef.location,
          end,
        },
      });
    }
    walk(stmt, [], (node, stack) => {
      // results cannot be indexed in any way
      // with alias as (select ...)
      //      ^^^^^
      if (is(node, "CommonTableExpr")) {
        if (node.CommonTableExpr.ctename) {
          this.tempTables.add(node.CommonTableExpr.ctename);
        }
      }
      // results cannot be indexed in any way
      // select ... from (...) as alias
      //                          ^^^^^
      if (is(node, "RangeSubselect")) {
        if (node.RangeSubselect.alias?.aliasname) {
          this.tempTables.add(node.RangeSubselect.alias.aliasname);
        }
      }
      // can be indexed as it refers to a regular table
      // select ... from table as alias
      if (is(node, "RangeVar") && node.RangeVar.relname) {
        this.mappings.set(node.RangeVar.relname, {
          text: node.RangeVar.relname,
          start: node.RangeVar.location,
          quoted: false,
        });
        // In theory we can't blindly map aliases to table names
        // it's possible that two aliases point to different tables
        // which postgres allows but is tricky to determine by just walking
        // the AST like we're doing currently.
        if (node.RangeVar.alias?.aliasname) {
          const aliasName = node.RangeVar.alias.aliasname;
          const existingMapping = this.mappings.get(aliasName);
          const part: ColumnReferencePart = {
            text: node.RangeVar.relname,
            start: node.RangeVar.location,
            // what goes here? the text here doesn't _really_ exist.
            // so it can't be quoted or not quoted.
            // Does it even matter?
            quoted: true,
            alias: aliasName,
          };
          // Postgres supports shadowing table aliases created in different levels of queries
          // but we're very unlikely to see this in practice. Every ORM I've seen so far
          // has produced globally unique aliases. This is not worth the complexity currently.
          if (existingMapping) {
            console.warn(
              `Ignoring alias ${aliasName} as it shadows an existing mapping. We currently do not support alias shadowing.`
            );
            console.log(query);
            // Let the user know what happened but don't stop the show.
            shadowedAliases.push(part);
            return;
          }
          this.mappings.set(aliasName, part);
        }
      }
      if (is(node, "JoinExpr") && node.JoinExpr.quals) {
        if (is(node.JoinExpr.quals, "A_Expr")) {
          if (
            node.JoinExpr.quals.A_Expr.lexpr &&
            is(node.JoinExpr.quals.A_Expr.lexpr, "ColumnRef")
          ) {
            add(node.JoinExpr.quals.A_Expr.lexpr);
          }
          if (
            node.JoinExpr.quals.A_Expr.rexpr &&
            is(node.JoinExpr.quals.A_Expr.rexpr, "ColumnRef")
          ) {
            add(node.JoinExpr.quals.A_Expr.rexpr);
          }
        }
      }
      if (is(node, "ColumnRef")) {
        for (let i = 0; i < stack.length; i++) {
          const inReturningList =
            stack[i] === "returningList" &&
            stack[i + 1] === "ResTarget" &&
            stack[i + 2] === "val" &&
            stack[i + 3] === "ColumnRef";
          if (inReturningList) {
            add(node, true);
            return;
          }
          if (
            // stack[i] === "SelectStmt" &&
            stack[i + 1] === "targetList" &&
            stack[i + 2] === "ResTarget" &&
            stack[i + 3] === "val" &&
            stack[i + 4] === "ColumnRef"
          ) {
            // we don't want to index the columns that are being selected
            add(node, true);
            return;
          }

          if (stack[i] === "FuncCall" && stack[i + 1] === "args") {
            // args of a function call can't be indexed (without functional indexes)
            add(node, true);
            return;
          }
        }
        add(node);
      }
    });
    const indexRepresentations = new Set<string>();
    const indexesToCheck: DiscoveredColumnReference[] = [];
    const sortedHighlights = highlights.sort(
      (a, b) => b.position.end - a.position.end
    );
    let currQuery = query;
    for (const highlight of sortedHighlights) {
      // our parts might have
      const parts = this.resolveTableAliases(highlight.parts);
      if (parts.length === 0) {
        console.error(highlight);
        throw new Error("Highlight must have at least one part");
      }
      let color = (a: string) => a;
      let skip = false;
      if (highlight.ignored) {
        color = yellow;
        skip = true;
      } else if (parts.length === 2 && this.tempTables.has(parts[0].text)) {
        color = blue;
        skip = true;
      } else {
        color = bgBrightMagenta;
      }
      const queryRepr = highlight.representation;
      currQuery = `${currQuery.slice(0, highlight.position.start)}${color(
        queryRepr
      )}${currQuery.slice(highlight.position.end)}`;
      if (indexRepresentations.has(queryRepr)) {
        skip = true;
      }
      if (!skip) {
        indexesToCheck.push(highlight);
        indexRepresentations.add(queryRepr);
      }
    }
    const referencedTables = Array.from(this.mappings.keys());
    return {
      indexesToCheck,
      ansiHighlightedQuery: currQuery,
      referencedTables,
      shadowedAliases,
    };
  }

  deriveIndexes(
    tables: ExportedStats[],
    discovered: DiscoveredColumnReference[]
  ): RootIndexCandidate[] {
    /**
     * There are 3 different kinds of parts a col reference can have
     * {a} = just a column within context. Find out the table
     * {a, b} = a column reference with a table reference. There's still ambiguity here
     * with what the schema could be in case there are 2 tables with the same name in different schemas.
     * {a, b, c} = a column reference with a table reference and a schema reference.
     * This is the best case scenario.
     */
    const allIndexes: RootIndexCandidate[] = [];
    const seenIndexes = new Set<string>();
    function addIndex(index: RootIndexCandidate) {
      const key = `${index.schema}:${index.table}:${index.column}`;
      if (seenIndexes.has(key)) {
        return;
      }
      seenIndexes.add(key);
      allIndexes.push(index);
    }
    for (const colReference of discovered) {
      const partsCount = colReference.parts.length;
      const columnOnlyReference = partsCount === 1;
      const tableReference = partsCount === 2;
      const fullReference = partsCount === 3;
      if (columnOnlyReference) {
        // select c from x
        const [column] = colReference.parts;
        const referencedColumn = this.normalize(column);
        // TODO: this is not a good guess
        // we can absolutely infer the schema name
        // much better from the surrounding context
        // this will lead to problems where we use
        // tables like `auth.users` instead of `public.users`
        // just because `auth` might have alphabetic priority
        const matchingTables = tables.filter((table) => {
          return (
            table.columns?.some((column) => {
              return column.columnName === referencedColumn;
            }) ?? false
          );
        });
        for (const table of matchingTables) {
          addIndex({
            schema: table.schemaName,
            table: table.tableName,
            column: referencedColumn,
          });
        }
      } else if (tableReference) {
        // select b.c from x
        const [table, column] = colReference.parts;
        const referencedTable = this.normalize(table);
        const referencedColumn = this.normalize(column);
        const matchingTable = tables.find((table) => {
          const hasMatchingColumn =
            table.columns?.some((column) => {
              return column.columnName === referencedColumn;
            }) ?? false;
          return table.tableName === referencedTable && hasMatchingColumn;
        });
        if (matchingTable) {
          addIndex({
            schema: matchingTable.schemaName,
            table: referencedTable,
            column: referencedColumn,
          });
        }
      } else if (fullReference) {
        // select a.b.c from x
        const [schema, table, column] = colReference.parts;
        const referencedSchema = this.normalize(schema);
        const referencedTable = this.normalize(table);
        const referencedColumn = this.normalize(column);
        addIndex({
          schema: referencedSchema,
          table: referencedTable,
          column: referencedColumn,
        });
      } else {
        // select huh.a.b.c from x
        console.error(
          "Column reference has too many parts. The query is malformed",
          colReference
        );
        continue;
      }
    }
    return allIndexes;
  }

  /**
   * Resolves aliases such as `a.b` to `x.b` if `a` is a known
   * alias to a table called x.
   *
   * Ignores all other combination of parts such as `a.b.c`
   */
  private resolveTableAliases(
    parts: ColumnReferencePart[]
  ): ColumnReferencePart[] {
    // we don't want to resolve aliases for references such as
    // `a.b.c` - this is fully qualified with a schema and can't be an alias
    // `c` - because there's no table reference here (as far as we can tell)
    if (parts.length !== 2) {
      return parts;
    }
    const tablePart = parts[0];
    const mapping = this.mappings.get(tablePart.text);
    if (mapping) {
      parts[0] = mapping;
    }
    return parts;
  }

  private normalize(columnReference: ColumnReferencePart): string {
    return columnReference.quoted
      ? columnReference.text
      : // postgres automatically lowercases column names if not quoted
        columnReference.text.toLowerCase();
  }
}

type KeysOfUnion<T> = T extends T ? keyof T : never;
export function is<K extends KeysOfUnion<Node>>(
  node: Node,
  kind: K
): node is Extract<Node, Record<K, unknown>> {
  return kind in node;
}

function getNodeKind(node: Node): KeysOfUnion<Node> {
  const keys = Object.keys(node);
  return keys[0] as KeysOfUnion<Node>;
}

function walk(
  node: unknown,
  stack: (KeysOfUnion<Node> | string)[],
  callback: (node: Node, stack: (KeysOfUnion<Node> | string)[]) => void
) {
  if (isANode(node)) {
    callback(node, [...stack, getNodeKind(node)]);
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (isANode(item)) {
        walk(item, stack, callback);
      }
    }
  } else if (isANode(node)) {
    const keys = Object.keys(node);
    // @ts-ignore
    walk(node[keys[0]], [...stack, getNodeKind(node)], callback);
  } else {
    for (const [key, child] of Object.entries(node)) {
      walk(child, [...stack, key as KeysOfUnion<Node>], callback);
    }
  }
}

function isANode(node: unknown): node is Node {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const keys = Object.keys(node);
  return keys.length === 1 && /^[A-Z]/.test(keys[0]);
}
