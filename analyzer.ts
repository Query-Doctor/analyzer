import { ParseResult, Node } from "@pgsql/types";
import { parse } from "pgsql-parser";
import { deparseSync } from "pgsql-deparser";
import { BinaryHeap } from "@std/data-structures";
import { RootIndexCandidate } from "./optimizer/genalgo.ts";
import { TableMetadata } from "./optimizer/statistics.ts";

export interface DatabaseDriver {
  query(query: string, params: unknown[]): Promise<unknown[]>;
}

type CheckableIndex = string[];

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

export class Analyzer {
  async analyze(
    query: string,
    _params: unknown[]
  ): Promise<{
    indexesToCheck: DiscoveredColumnReference[];
    ansiHighlightedQuery: string;
    referencedTables: string[];
  }> {
    const mappings: Map<string, ColumnReferencePart> = new Map();
    const tempTables: Set<string> = new Set();
    const highlightPositions = new Set<number>();
    // used for tallying the amount of times we see stuff so
    // we have a better idea of what to start off the algorithm with
    const seenReferences = new Map<string, number>();
    const ast = (await parse(query)) as ParseResult;
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
      let columnQuoted = false;
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
        frequency: seen ?? 0,
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
      if (is(node, "CommonTableExpr")) {
        if (node.CommonTableExpr.ctename) {
          tempTables.add(node.CommonTableExpr.ctename);
        }
      }
      if (is(node, "RangeVar") && node.RangeVar.relname) {
        mappings.set(node.RangeVar.relname, {
          text: node.RangeVar.relname,
          start: node.RangeVar.location,
          quoted: false,
        });
        if (node.RangeVar.alias?.aliasname) {
          mappings.set(node.RangeVar.alias.aliasname, {
            text: node.RangeVar.alias.aliasname,
            start: node.RangeVar.location,
            quoted: false,
          });
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
          } else if (stack[i] === "FuncCall" && stack[i + 1] === "args") {
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
      const parts = highlight.parts.map((part) => {
        const mapping = mappings.get(part.text);
        if (mapping) {
          return mapping;
        }
        return part;
      });
      if (parts.length === 0) {
        console.error(highlight);
        throw new Error("Highlight must have at least one part");
      }
      let color;
      let skip = false;
      if (highlight.ignored) {
        color = "\x1b[33m";
        skip = true;
      } else if (tempTables.has(parts[0].text)) {
        color = "\x1b[34m";
        skip = true;
      } else {
        color = "\x1b[48;5;205m";
      }
      const queryRepr = highlight.representation;
      currQuery = `${currQuery.slice(
        0,
        highlight.position.start
      )}${color}${queryRepr}\x1b[0m${currQuery.slice(highlight.position.end)}`;
      if (indexRepresentations.has(queryRepr)) {
        skip = true;
      }
      if (!skip) {
        indexesToCheck.push(highlight);
        indexRepresentations.add(queryRepr);
      }
    }
    const referencedTables = Array.from(mappings.keys());
    return {
      indexesToCheck,
      ansiHighlightedQuery: currQuery,
      referencedTables,
    };
  }

  deriveIndexes(
    tables: TableMetadata[],
    discovered: DiscoveredColumnReference[]
  ): RootIndexCandidate[] {
    const allIndexes: RootIndexCandidate[] = [];
    for (const colReference of discovered) {
      const noPrefix = colReference.parts.length === 1;
      if (noPrefix) {
        // can we do this directly in postgres?
        const [column] = colReference.parts;
        const referencedColumn = column.quoted
          ? column.text
          : // postgres automatically lowercases column names if not quoted
            column.text.toLowerCase();
        const matchingTables = tables.filter((table) => {
          return table.columns.some((column) => {
            return column.columnName === referencedColumn;
          });
        });
        for (const table of matchingTables) {
          allIndexes.push({
            schema: table.schemaName,
            table: table.tableName,
            column: referencedColumn,
          });
        }
      } else {
        const [table, column] = colReference.parts;
        const referencedTable = table.quoted
          ? table.text
          : // postgres automatically lowercases column names if not quoted
            table.text.toLowerCase();
        const referencedColumn = column.quoted
          ? column.text
          : // postgres automatically lowercases column names if not quoted
            column.text.toLowerCase();
        const matchingTable = tables.find((table) => {
          const hasMatchingColumn = table.columns.some((column) => {
            return column.columnName === referencedColumn;
          });
          return table.tableName === referencedTable && hasMatchingColumn;
        });
        if (matchingTable) {
          allIndexes.push({
            schema: matchingTable.schemaName,
            table: referencedTable,
            column: referencedColumn,
          });
        }
      }
    }
    return allIndexes;
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

function buildFrequencyMap(heap: BinaryHeap<string>) {
  const map = new Map<string, number>();
  while (!heap.isEmpty()) {
    const reference = heap.pop();
    if (reference) {
      map.set(reference, (map.get(reference) ?? 0) + 1);
    }
  }
  return map;
}

function isANode(node: unknown): node is Node {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const keys = Object.keys(node);
  return keys.length === 1 && /^[A-Z]/.test(keys[0]);
}
