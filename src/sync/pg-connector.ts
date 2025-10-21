import { format } from "sql-formatter";
import type {
  CursorOptions,
  DatabaseConnector,
  Dependency,
  DependencyAnalyzerOptions,
  Hash,
  TableRows,
} from "./dependency-tree.ts";
import { log } from "../log.ts";
import { shutdownController } from "../shutdown.ts";
import { withSpan } from "../otel.ts";
import { Postgres } from "@query-doctor/core";
import { SegmentedQueryCache } from "./seen-cache.ts";

const ctidSymbol = Symbol("ctid");
type Row = NonNullable<unknown> & {
  [ctidSymbol]: string;
};

type QuotedIdentifier = string;

type ColumnStats = {
  nullFraction: number;
  commonElems: unknown[] | null;
  commonElemFrequencies: number[] | null;
  distinctValues: number;
  histogramBounds: unknown[] | null;
  rangeBoundsHistogram: unknown[] | null;
};
export type ColumnMetadata = {
  columnName: QuotedIdentifier;
  dataType: string;
  isNullable: boolean;
  stats: ColumnStats | null;
};
export type TableMetadata = {
  tableName: QuotedIdentifier;
  schemaName: QuotedIdentifier;
  rowCountEstimate: number;
  pageCount: number;
  columns: ColumnMetadata[];
};

type PostgresTuple = { data: Row; table: TableName };
export type TableStats = {
  tupleEstimate: bigint;
  pageCount: number;
};

export type SerializeResult = {
  schema: TableMetadata[];
  serialized: string;
  sampledRecords: Record<TableName, number>;
};

export type RawRecentQuery = {
  username: string;
  query: string;
  formattedQuery: string;
  meanTime: number;
  calls: string;
  rows: string;
  topLevel: boolean;
};

export type RecentQuery = {
  firstSeen: number;
};

export type RecentQueriesError =
  | {
      kind: "error";
      type: "postgres_error";
      error: string;
    }
  | {
      kind: "error";
      type: "extension_not_installed";
      extensionName: string;
    };

export type RecentQueriesResult =
  | {
      kind: "ok";
      queries: RecentQuery[];
    }
  | RecentQueriesError;


export type ResetPgStatStatementsError =
  | {
  kind: "error";
  type: "postgres_error";
  error: string;
}
  | {
  kind: "error";
  type: "extension_not_installed";
  extensionName: string;
};

export type ResetPgStatStatementsResult =
  | {
    kind: "ok";
  }
  | ResetPgStatStatementsError;

export class PostgresConnector implements DatabaseConnector<PostgresTuple> {
  private static readonly QUERY_DOCTOR_USER = "query_doctor_db_link";
  private readonly tupleEstimates = new Map<TableName, number>();
  /**
   * The minimum size for a table to be considered for sampling.
   * Otherwise we use the `order by random()` instead.
   */
  private static readonly MIN_SIZE_FOR_TABLESAMPLE = 10_000;
  constructor(
    private readonly db: Postgres,
    private readonly segmentedQueryCache: SegmentedQueryCache,
  ) {}

  async onStartAnalyze(_schema: string): Promise<void> {
    const results = await this.db.exec<{ table: string; count: number }>(
      `SELECT relname AS table, n_live_tup AS count FROM pg_stat_user_tables`,
    );
    for (const result of results) {
      this.tupleEstimates.set(result.table, result.count);
    }
  }

  /**
   * Returns a list of dependencies for a given schema.
   *
   * The table and column names are quoted according to postgres rules
   */
  async dependencies(schema: string): Promise<Dependency[]> {
    const out = await withSpan("connector.dependencies", () =>
      this.db.exec<Dependency>(
        `
SELECT
    quote_ident(pg_tables.schemaname)  as "sourceSchema",
    quote_ident(pg_tables.tablename) AS "sourceTable",
    fk."sourceColumn" AS "sourceColumn",
    quote_ident(fk."referencedSchema") as "referencedSchema",
    quote_ident(fk."referencedTable") AS "referencedTable",
    fk."referencedColumn" AS "referencedColumn"
FROM
    pg_tables
LEFT JOIN LATERAL (
    SELECT
        ARRAY_AGG(pa.attname::TEXT ORDER BY conkey_unnest.ord) AS "sourceColumn",
        ref_ns.nspname AS "referencedSchema",
        ref_cl.relname AS "referencedTable",
        ARRAY_AGG(con_pk_att.attname::TEXT ORDER BY conkey_unnest.ord) AS "referencedColumn"
    FROM
        pg_constraint AS pc
    JOIN
        pg_class AS pgc
        ON pgc.oid = pc.conrelid
    JOIN
        pg_namespace AS pgn
        ON pgn.oid = pgc.relnamespace
    JOIN
        UNNEST(pc.conkey) WITH ORDINALITY AS conkey_unnest(attnum, ord)
        ON TRUE
    JOIN
        UNNEST(pc.confkey) WITH ORDINALITY AS confkey_unnest(attnum, ord)
        ON conkey_unnest.ord = confkey_unnest.ord -- Join by ordinality
    JOIN
        pg_attribute AS pa
        ON pa.attrelid = pc.conrelid AND pa.attnum = conkey_unnest.attnum
    JOIN
        pg_attribute AS con_pk_att
        ON con_pk_att.attrelid = pc.confrelid AND con_pk_att.attnum = confkey_unnest.attnum
    JOIN
        pg_class AS ref_cl -- Join to get referenced table name
        ON ref_cl.oid = pc.confrelid
    JOIN
        pg_namespace AS ref_ns -- Join to get referenced schema name
        ON ref_ns.oid = ref_cl.relnamespace
    WHERE
        pc.contype = 'f' -- 'f' stands for foreign key
        AND pa.attnum > 0 -- Skip system columns
        AND pa.attisdropped = false -- Skip dropped columns
        AND pgn.nspname = $1
        AND pgc.relname = pg_tables.tablename
    GROUP BY
        pgc.relname, pc.oid, ref_ns.nspname, ref_cl.relname
    ORDER BY
        pgc.relname
) AS fk ON TRUE
WHERE
    pg_tables.schemaname = $1
ORDER BY
    pg_tables.tablename, fk."referencedTable", fk."sourceColumn";-- @qd_introspection
    `,
        [schema],
      ),
    )();

    return out;
  }

  async get(schema: string, table: string, values: Record<string, unknown>) {
    const columnsText = Object.keys(values)
      .map((key, i) => `${doubleQuote(key)} = $${i + 1}`)
      .join(" AND ");
    // TODO: pass the schema along
    const sqlString = `select *, ctid from ${schema}.${table} where ${columnsText} limit 1 -- @qd_introspection`;
    const params = Object.values(values);
    log.debug(`${sqlString} : [${params.join(", ")}]`, "pg-connector:get");
    const data = await withSpan("connector.get", () =>
      this.db.exec<Row & { ctid?: string }>(sqlString, params),
    )();
    if (data.length === 0) {
      return;
    }
    const newValue = data[0];
    if (typeof newValue.ctid !== "undefined") {
      newValue[ctidSymbol] = newValue.ctid;
    }
    delete newValue.ctid;
    return {
      table,
      data: newValue,
    };
  }
  /**
   * Generate a stream of potentially new values to insert into the database
   *
   * Uses the good old `order by random()` for small tables.
   *
   * For larger tables, it uses the `bernoulli` tablesystem to get a random sample of the table.
   * @param table Table to source values from
   * @param options Options for the cursor
   * @returns
   */
  async *cursor(
    schema: string,
    table: string,
    options: CursorOptions,
  ): AsyncGenerator<PostgresTuple, void, unknown> {
    if (!this.db.cursor) {
      throw new Error("PostgresConnector.cursor is not supported");
    }
    const tupleEstimate = this.tupleEstimates.get(table);
    if (tupleEstimate === undefined) {
      console.warn(
        `No tuple estimate for ${table}. Falling back to slow query. Is the db vacuum analyzed?`,
      );
    }
    let cursor: AsyncIterable<Row & { ctid?: string }, void, unknown>;
    if (
      tupleEstimate === undefined ||
      tupleEstimate < PostgresConnector.MIN_SIZE_FOR_TABLESAMPLE
    ) {
      await this.db.exec("select setseed($1)", [options.seed]);
      cursor = this.db
        // we want to make sure the rows we get are deterministic
        .cursor(
          `select *, ctid from ${schema}.${table} order by random() -- @qd_introspection`,
        );
    } else {
      // this really needs to be tweaked lol
      cursor = this.db.cursor(
        `select *, ctid from ${schema}.${table} tablesample bernoulli(${
          options.requiredRows / tupleEstimate + 10
        }) repeatable(1) -- @qd_introspection`,
      );
    }
    for await (const data of cursor) {
      if (shutdownController.signal.aborted) {
        break;
      }
      if (data === undefined) {
        log.error(
          `Cursor for table ${table} returned an undefined value`,
          "pg-connector:cursor",
        );
        continue;
      }
      if (typeof data.ctid !== "undefined") {
        data[ctidSymbol] = data.ctid;
      }
      delete data.ctid;
      yield { data, table };
    }
  }
  /**
   * Serializes sampled data using postgres's `quote_literal` function
   * into batched INSERT statements that can be restored into IXR.
   */
  async serialize(
    schemaName: string,
    tables: TableRows<Row>,
    options: DependencyAnalyzerOptions,
  ): Promise<SerializeResult> {
    const schema = await this.getSchema(schemaName);
    const mkKey = (schema: string, table: string, column: string) =>
      `${schema.toLowerCase()}:${table.toLowerCase()}:${column}`;
    const schemaMap = new Map<string, ColumnMetadata>();
    for (const table of schema) {
      for (const column of table.columns) {
        schemaMap.set(
          mkKey(table.schemaName, table.tableName, column.columnName),
          column,
        );
      }
    }
    const comments = [
      `-- START:Sampled data`,
      `-- Sampled by @query-doctor/analyzer on ${new Date().toISOString()} | options = ${JSON.stringify(
        options,
      )}`,
      "--",
      "-- Note: Using session_replication_role to prevent foreign key constraints from being checked.",
      "-- If adding new rows manually, you might want to put new insert statements after the sampled data.",
    ];
    const directives = ["SET session_replication_role = 'replica';"];
    let out = `${comments.join("\n")}\n${directives.join("\n")}\n\n`;
    const sampledRecords: Record<TableName, number> = {};
    // In _theory_ the correct way to do this serialization is to first do
    // a topological sort on the dependency graph and then serialize the tables
    // in the order of the sort to prevent problems with foreign key constraints.
    //
    // We also have the option of using `SET CONSTRAINTS ALL DEFERRED;` to defer
    // the constraints until after the data is inserted BUT that requires a transaction
    // and using transactions in user schema restorations can prevent certain kinds of actions
    // (like vacuum) from being performed.
    //
    // Instead we restore tables using `set session_replication_role = 'replica';`
    // to prevent the constraints from being checked.

    // TODO: batch this into a single query
    for (const [table, rows] of Object.entries(tables)) {
      const tableSchema = schema.find(
        (s) => s.tableName === table && s.schemaName === schemaName,
      );
      if (!tableSchema) {
        console.warn(
          `No schema found for ${table}. Skipping. Is there a quoting mismatch with the table name?`,
        );
        continue;
      }
      const allCtids = rows.map((row) => row[ctidSymbol]);
      const columns = tableSchema.columns.map(
        (c) => `quote_literal(${c.columnName}) as ${c.columnName}`,
      );
      const query = `select ${columns.join(
        ", ",
      )} from (select * from ${schemaName}.${table} where ctid = any($1::tid[])) as samples -- @qd_introspection`;
      log.debug(
        `${query} : [${allCtids.join(", ")}]`,
        "pg-connector:serialize",
      );
      const serialized = await withSpan("connector.get", () =>
        this.db.exec(query, [allCtids]),
      )();

      const estimate = this.tupleEstimates.get(table) ?? "?";
      const comment = `-- ${table} | ${serialized.length} sampled out of ${estimate.toLocaleString()} (estimate)`;
      const insertStatement = `${comment}\nINSERT INTO ${schemaName}.${table} (${tableSchema.columns
        .map((c) => c.columnName)
        .join(", ")})\nOVERRIDING SYSTEM VALUE VALUES\n`;
      // overriding system value prevents breaking columns that are (generated always as)
      if (serialized.length === 0) {
        console.warn(`No rows found for ${table}. Skipping.`);
        continue;
      }
      const serializedRows = [];
      for (const row of serialized) {
        serializedRows.push(
          `(${tableSchema.columns
            .map((col) => {
              // TODO: find a better way to do this
              // We shouldn't just pass around a bare string representing identifiers
              // and it would be better to turn them into something like
              // ```ts
              // type Identifier = { name: string; quoted: boolean; };
              // ```
              // but the problem is we often need to use these identifiers as map keys
              // which doesn't work well with objects.
              const quotedStrippedColName = col.columnName.replace(
                /(^"|"$)/g,
                "",
              );
              const value = (row as Record<string, unknown>)[
                quotedStrippedColName
              ];
              if (value === null) {
                return "NULL";
              }
              return value;
            })
            .join(", ")})`,
        );
      }
      out += `${insertStatement}  ${serializedRows.join(",\n  ")};\n\n`;
      sampledRecords[table] = serialized.length;
    }
    log.info(
      `Serialized ${Object.keys(tables).length} tables`,
      "pg-connector:serialize",
    );
    out += `-- END:Sampled data\nSET session_replication_role = 'origin';\n\n`;
    return {
      schema,
      serialized: out,
      sampledRecords,
    };
  }

  hash(value: PostgresTuple): Hash {
    return `${value.table}:${value.data[ctidSymbol]}` as Hash;
  }

  public async getSchema(schemaName: string): Promise<TableMetadata[]> {
    const results = await withSpan("connector.getSchema", () =>
      this.db.exec<TableMetadata>(
        `SELECT
          quote_ident(c.table_name) as "tableName",
          quote_ident(n.nspname) as "schemaName",
          cl.reltuples as "rowCountEstimate",
          cl.relpages as "pageCount",
          json_agg(
            json_build_object(
              'columnName', quote_ident(c.column_name),
              'dataType', c.data_type,
              'isNullable', (c.is_nullable = 'YES')::boolean,
              'stats', (
                select json_build_object(
                  'nullFraction', s.null_frac,
                  'commonElems', s.most_common_elems,
                  'commonElemFrequencies', s.most_common_elem_freqs,
                  'distinctValues', s.n_distinct,
                  'histogramBounds', s.histogram_bounds
                )
                  from pg_stats s
                where
                  s.schemaname = n.nspname
                  and s.tablename = c.table_name
                  and s.attname = c.column_name
                  -- Skip dropped columns (they still exist in the schema)
                  and a.attisdropped = false
                  -- Skip system columns
                  and a.attnum > 0
              )
            )
          ORDER BY c.ordinal_position) as columns
      FROM
          information_schema.columns c
      JOIN
          pg_namespace n
          ON n.nspname = c.table_schema
      JOIN
          pg_class cl
          ON cl.relname = c.table_name and cl.relnamespace = n.oid
      JOIN
          pg_attribute a
          ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
          AND a.attname = c.column_name
      WHERE
          n.nspname = $1
          and c.table_name not like 'pg_%'
          and c.table_name not in ('pg_stat_statements', 'pg_stat_statements_info')
      GROUP BY
          n.nspname, c.table_name, cl.reltuples, cl.relpages; -- @qd_introspection
    `,
        [schemaName],
      ),
    )();
    return results;
  }

  public async getDatabaseInfo() {
    const results = await this.db.exec<{
      serverVersion: string;
      serverVersionNum: string;
    }>(
      'select version() as "serverVersion", current_setting(\'server_version_num\') as "serverVersionNum"; -- @qd_introspection',
    );
    return {
      serverVersion: results[0]!.serverVersion,
      serverVersionNum: results[0]!.serverVersionNum,
    };
  }

  public async getRecentQueries(): Promise<RecentQueriesResult> {
    try {
      const results = await this.db.exec<RawRecentQuery>(`
      SELECT
        pg_user.usename as "username",
        query,
        mean_exec_time as "meanTime",
        calls,
        rows,
        toplevel as "topLevel"
      FROM pg_stat_statements
      JOIN pg_user ON pg_user.usesysid = pg_stat_statements.userid
      WHERE query not like '%pg_stat_statements%'
        and dbid = (select oid from pg_database where datname = current_database())
        and query not like '%@qd_introspection%'
        and pg_user.usename not in (/* supabase */ 'supabase_admin', 'supabase_auth_admin', /* neon */ 'cloud_admin'); -- @qd_introspection
      `); // we're excluding `pg_stat_statements` from the results since it's almost certainly unrelated

      // this is a horrible place for this code to live, it doesn't belong here
      // the alternatives are equally as bad: repeat the logic 3 times in the various endpoints
      const resultsWithFormattedQueries = results.map((r) => {
        return {
          ...r,
          formattedQuery: format(r.query, {
            language: "postgresql",
            keywordCase: "upper",
            linesBetweenQueries: 2,
          })
        };
      });

      return {
        kind: "ok",
        queries: this.segmentedQueryCache.sync(this.db, resultsWithFormattedQueries),
      };
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('relation "pg_stat_statements" does not exist')
      ) {
        return {
          kind: "error",
          type: "extension_not_installed",
          extensionName: "pg_stat_statements",
        };
      }
      console.error(err);
      return {
        kind: "error",
        type: "postgres_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async resetPgStatStatements(): Promise<ResetPgStatStatementsResult> {
    try {
      await this.db.exec(`
          SELECT pg_stat_statements_reset(); -- @qd_introspection
      `);

      this.segmentedQueryCache.reset(this.db);

      return {
        kind: "ok",
      };
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('function pg_stat_statements_reset() does not exist')
      ) {
        return {
          kind: "error",
          type: "extension_not_installed",
          extensionName: "pg_stat_statements",
        };
      }
      console.error(err);
      return {
        kind: "error",
        type: "postgres_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async checkPrivilege(): Promise<{
    username: string;
    isSuperuser: boolean;
  }> {
    const [results] = await this.db.exec<{
      username: string;
      isSuperuser: boolean;
    }>(
      `SELECT usename as "username", usesuper as "isSuperuser" FROM pg_user WHERE usename = current_user; -- @qd_introspection`,
    );
    if (!results) {
      return { username: "unknown", isSuperuser: false };
    }
    return { username: results.username, isSuperuser: results.isSuperuser };
  }
}

const PROBABLY_NO_QUOTE_NEEDED = /^[a-z0-9_]+$/;
function doubleQuote(value: string) {
  if (PROBABLY_NO_QUOTE_NEEDED.test(value)) {
    return value;
  }
  return `"${value}"`;
}
type TableName = string;
