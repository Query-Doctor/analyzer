import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import csv from "fast-csv";
import type { RawRecentQuery, RecentQuery } from "./recent-query.ts";
import { preprocessEncodedJson } from "./json.ts";
import { QueryCache } from "../sync/seen-cache.ts";
import type { RecentQuerySource } from "./recent-query.ts";

const INTROSPECTION_MARKER = "@qd_introspection";
const PLAN_PREFIX = "plan:";

export function rawQueryFromPgbadgerRow(
  chunk: readonly string[],
): RawRecentQuery | null {
  const loglevel = chunk[6];
  const queryString = chunk[9];
  if (loglevel !== "LOG" || !queryString || !queryString.startsWith(PLAN_PREFIX)) {
    return null;
  }

  const planString = queryString.slice(PLAN_PREFIX.length).trim();
  const json = preprocessEncodedJson(planString);
  if (!json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const query = (parsed as Record<string, unknown>)["Query Text"];
  if (typeof query !== "string") {
    return null;
  }
  if (query.includes(INTROSPECTION_MARKER)) {
    return null;
  }

  return {
    username: "",
    query,
    formattedQuery: query,
    meanTime: 0,
    calls: "1",
    rows: "0",
    topLevel: true,
  };
}

export class PgbadgerSource implements RecentQuerySource {
  totalRows = 0;
  streamError?: Error;
  readonly logSize: number;

  constructor(
    private readonly logPath: string,
    private readonly cache: QueryCache = new QueryCache(),
  ) {
    this.logSize = statSync(this.logPath).size;
    console.log(`logPath=${this.logPath},fileSize=${this.logSize}`);
  }

  async getRecentQueries(): Promise<RecentQuery[]> {
    const args = [
      "--dump-raw-csv",
      "--no-progressbar",
      "-f",
      "stderr",
      this.logPath,
    ];
    console.log(`pgbadger ${args.join(" ")}`);
    const child = spawn("pgbadger", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.pipe(process.stderr);

    const stream = csv
      .parseStream(child.stdout!, { headers: false })
      .on("error", (err) => {
        console.error("Got a pgbadger error", err);
        this.streamError = err;
      });

    const rawQueries: RawRecentQuery[] = [];
    for await (const chunk of stream) {
      const raw = rawQueryFromPgbadgerRow(chunk as string[]);
      if (!raw) continue;
      rawQueries.push(raw);
      this.totalRows++;
    }
    console.log("Finished pgbadger stream");
    return this.cache.sync(rawQueries);
  }
}
