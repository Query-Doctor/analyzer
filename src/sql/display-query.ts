import { parse, scan } from "@libpg-query/parser";
import type { SelectStmt } from "@pgsql/types";
import { log } from "../log.ts";

const MAX_TARGETS_WITHOUT_COMPACTION = 2;
const MAX_WIDTH_WITHOUT_COMPACTION = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Human-readable preview of `query` with the top-level SELECT target list
 * replaced by "...". Not valid SQL — for display only. Returns undefined when
 * the query can't or shouldn't be compacted (non-SELECT, UNION, target list
 * already short, parse/scan failure).
 */
export async function computeDisplayQuery(
  query: string,
): Promise<string | undefined> {
  let parseResult;
  try {
    parseResult = await parse(query);
  } catch (error) {
    log.debug(
      `displayQuery: parse failed (${(error as Error).message})`,
      "display-query",
    );
    return undefined;
  }

  const firstStmt = parseResult.stmts?.[0]?.stmt;
  if (!firstStmt || !("SelectStmt" in firstStmt)) return undefined;

  const selectStmt: SelectStmt = firstStmt.SelectStmt;

  if (selectStmt.op && selectStmt.op !== "SETOP_NONE") return undefined;

  const targetList = selectStmt.targetList ?? [];
  const fromClause = selectStmt.fromClause ?? [];
  if (targetList.length === 0 || fromClause.length === 0) return undefined;

  const firstTargetNode = targetList[0];
  if (!firstTargetNode || !("ResTarget" in firstTargetNode)) return undefined;
  const start = firstTargetNode.ResTarget.location;
  if (start === undefined) return undefined;

  const end = await findTopLevelFrom(query, start);
  if (end === undefined || end <= start) return undefined;

  const width = end - start;
  if (
    targetList.length <= MAX_TARGETS_WITHOUT_COMPACTION &&
    width <= MAX_WIDTH_WITHOUT_COMPACTION
  ) {
    return undefined;
  }

  // libpg_query offsets are UTF-8 byte positions, not UTF-16 code units —
  // encode before slicing so multi-byte chars before FROM don't shift the cut.
  const bytes = encoder.encode(query);
  return decoder.decode(bytes.slice(0, start)) +
    "... " +
    decoder.decode(bytes.slice(end));
}

/**
 * Locate the FROM keyword that ends the top-level SELECT target list by
 * scanning tokens and tracking parenthesis depth, so FROMs inside subqueries
 * or function calls like TRIM(FROM …) are ignored.
 */
async function findTopLevelFrom(
  query: string,
  startOffset: number,
): Promise<number | undefined> {
  let scanResult;
  try {
    scanResult = await scan(query);
  } catch {
    return undefined;
  }

  let depth = 0;
  for (const token of scanResult.tokens ?? []) {
    if (token.start < startOffset) continue;
    if (token.text === "(") depth++;
    else if (token.text === ")") depth--;
    else if (depth === 0 && token.text.toUpperCase() === "FROM") {
      return token.start;
    }
  }
  return undefined;
}
