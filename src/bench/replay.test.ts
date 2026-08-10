import { describe, expect, it } from "vitest";
import { buildReplay, columnType, schemaStatements } from "./replay.ts";

const table = (
  name: string,
  columns: [string, string | undefined][],
  reltuples = 1000,
) => ({
  schemaName: "public",
  tableName: name,
  reltuples,
  columns: columns.map(([columnName, dataType]) => ({
    columnName,
    attlen: null,
    dataType,
  })),
  indexes: [],
});

describe("columnType", () => {
  it("maps the types a dump reports to types CREATE TABLE accepts", () => {
    expect(columnType("int4")).toBe("integer");
    expect(columnType("character varying")).toBe("text");
    expect(columnType("timestamp with time zone")).toBe("timestamptz");
    expect(columnType("jsonb")).toBe("jsonb");
    expect(columnType("ARRAY")).toBe("text[]");
  });

  it("falls back to text for a type this database does not have", () => {
    // Enums and composites are reported under the name they were declared as,
    // which does not exist in a fresh database. These queries are costed, not
    // executed for their values, so text is close enough and always creatable.
    expect(columnType("optimization_state")).toBe("text");
    expect(columnType(undefined)).toBe("text");
  });
});

describe("schemaStatements", () => {
  it("creates a table and fills it", () => {
    const statements = schemaStatements([table("users", [["id", "int4"]])], 500);
    expect(statements[0]).toBe('CREATE TABLE "public"."users" ("id" integer);');
    expect(statements[1]).toContain("INSERT INTO");
    expect(statements[1]).toContain("generate_series(1, 500)");
  });

  it("creates a schema before a table that needs one", () => {
    const statements = schemaStatements(
      [{ ...table("t", [["id", "int4"]]), schemaName: "archive" }],
      10,
    );
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "archive";');
    expect(statements[1]).toContain('"archive"."t"');
  });

  it("does not put more rows in a table than it had", () => {
    // A four-row migrations table should stay small; filling every table to the
    // cap would make the replay slower than the project it came from.
    const statements = schemaStatements([table("tiny", [["id", "int4"]], 4)], 2000);
    expect(statements[1]).toContain("generate_series(1, 4)");
  });

  it("leaves a genuinely empty table empty", () => {
    // reltuples 0 means analyzed and empty. Filling it would overstate what the
    // project's own indexes cost to build.
    const statements = schemaStatements([table("empty", [["id", "int4"]], 0)], 100);
    expect(statements[1]).toContain("generate_series(1, 0)");
  });

  it("fills a table Postgres has never analyzed", () => {
    // -1 is "no idea", not "empty".
    const statements = schemaStatements([table("fresh", [["id", "int4"]], -1)], 100);
    expect(statements[1]).toContain("generate_series(1, 100)");
  });

  it("quotes identifiers that need it", () => {
    const statements = schemaStatements(
      [table("Grower Audits", [["Recorded At", "timestamptz"]])],
      1,
    );
    expect(statements[0]).toContain('"Grower Audits"');
    expect(statements[0]).toContain('"Recorded At" timestamptz');
  });

  it("skips a table with no columns rather than emitting invalid DDL", () => {
    expect(schemaStatements([table("nothing", [])], 10)).toStrictEqual([]);
  });

  it("gives every type a value of that type", () => {
    const statements = schemaStatements(
      [
        table("mixed", [
          ["a", "uuid"],
          ["b", "jsonb"],
          ["c", "boolean"],
          ["d", "timestamptz"],
          ["e", "ARRAY"],
        ]),
      ],
      5,
    );
    const insert = statements[1];
    expect(insert).toContain("md5(g::text)::uuid");
    expect(insert).toContain("jsonb_build_object");
    expect(insert).toContain("(g % 2 = 0)");
    expect(insert).toContain("interval");
    expect(insert).toContain("ARRAY[");
  });
});

describe("buildReplay", () => {
  const run = {
    repo: "owner/repo",
    statisticsMode: {
      kind: "fromStatisticsExport" as const,
      source: { kind: "inline" as const },
      stats: [table("users", [["id", "int4"]])],
    },
    queries: [
      { hash: "ccc", query: "SELECT 3" },
      { hash: "aaa", query: "SELECT 1" },
      { hash: "bbb", query: "   " },
    ],
  };

  it("orders queries by hash so both sides of a comparison match", () => {
    const replay = buildReplay(run as never);
    expect(replay.queries.map((q) => q.hash)).toStrictEqual(["aaa", "ccc"]);
  });

  it("drops a query with no text", () => {
    expect(buildReplay(run as never).queries).toHaveLength(2);
  });

  it("caps the query count when asked", () => {
    expect(buildReplay(run as never, { maxQueries: 1 }).queries).toHaveLength(1);
  });

  it("carries the run's own statistics through untouched", () => {
    // The queries were costed against these. Substituting anything else would
    // measure a different plan from the one the project actually got.
    expect(buildReplay(run as never).statistics).toBe(run.statisticsMode);
  });
});
