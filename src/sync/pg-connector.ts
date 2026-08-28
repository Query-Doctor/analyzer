import type {
  CursorOptions,
  DatabaseConnector,
  DependenciesOptions,
  Dependency,
  DependencyAnalyzerOptions,
  FullyQualifiedTableName,
  Hash,
  TableRows,
} from "./dependency-tree.ts";
import { log } from "../log.ts";
import { shutdownController } from "../shutdown.ts";
import { withSpan } from "../otel.ts";
import {
  PgIdentifier,
  Postgres,
  PostgresQueryBuilder,
  dumpQueriesSql,
} from "@query-doctor/core";
import { syncQueries } from "./query-sync.ts";
import { FullSchema, FullSchemaColumn } from "@query-doctor/core";
import { ExtensionNotInstalledError, PostgresError } from "./errors.ts";
import { RawRecentQuery, RecentQuery } from "../sql/recent-query.ts";
import type { RecentQuerySource } from "../sql/recent-query.ts";


/**
 * Whether an error means the extension's table or function isn't there.
 *
 * Matching the message text does not work: every statement we send is
 * schema-qualified, so Postgres names the schema in the message and a check for
 * the bare `pg_stat_statements` never fires. The SQLSTATE is stable — 42P01 for
 * a missing relation, 42883 for a missing function, and 3F000 when the schema
 * itself is gone, which is what a qualified function call reports.
 */
export function isMissingExtensionObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42883" || code === "3F000";
}

const ctidSymbol = Symbol("ctid");
type Row = NonNullable<unknown> & {
  [ctidSymbol]: string;
};

type QuotedIdentifier = string;

export type ColumnMetadata = {
  columnName: QuotedIdentifier;
};
export type TableMetadata = {
  tableName: QuotedIdentifier;
  schemaName: QuotedIdentifier;
  columns: ColumnMetadata[];
};

type PostgresTuple = { data: Row; table: TableName };

export type SerializeResult = {
  serialized: string;
  sampledRecords: Record<TableName, number>;
};

export type RecentQueriesError = {
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

/**
 * Use {@link ConnectionManager.getConnectorFor} to grab an instance of this class
 */
export class PostgresConnector implements DatabaseConnector<PostgresTuple>, RecentQuerySource {
  private static readonly QUERY_DOCTOR_USER = "query_doctor_db_link";
  /**
   * Where {@link installPgStatStatements} puts the extension when the caller
   * doesn't say. Never `public`: the extension owns views a migration tool
   * reconciling `public` will try to drop, and fail on.
   */
  public static readonly EXTENSION_SCHEMA = "query_doctor";
  private readonly tupleEstimates = new Map<TableName, number>();
  private querySource: QuerySourceExtension | null = null;
  /**
   * Keyed by connection, because the connector is rebuilt on every poll — an
   * instance flag would re-warn every ten seconds for the whole run — while a
   * process-wide flag would silence every source database after the first.
   * ConnectionManager caches one Postgres per database, so it is the identity
   * that matches "warn once about this database".
   */
  private static readonly warnedAboutPublicSchema = new WeakMap<
    Postgres,
    Set<string>
  >();
  private static extensionNotInstalledError = new ExtensionNotInstalledError([
    "pg_stat_statements",
    "pg_stat_monitor"
  ])
  /**
   * The minimum size for a table to be considered for sampling.
   * Otherwise we use the `order by random()` instead.
   */
  private static readonly MIN_SIZE_FOR_TABLESAMPLE = 10_000;
  constructor(
    private readonly db: Postgres,
  ) { }

  async onStartAnalyze(): Promise<void> {
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
  async dependencies(
    options: DependenciesOptions,
  ): Promise<Dependency[]> {
    const out = await withSpan(
      "connector.dependencies",
      () =>
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
        AND (cardinality($1::text[]) = 0 or pgn.nspname <> ANY($1))
        AND pgn.nspname not like 'pg_%'
        AND pgn.nspname <> 'information_schema'
        AND pgc.relname = pg_tables.tablename
    GROUP BY
        pgc.relname, pc.oid, ref_ns.nspname, ref_cl.relname
    ORDER BY
        pgc.relname
) AS fk ON TRUE
WHERE
    (cardinality($1::text[]) = 0 or pg_tables.schemaname <> ANY($1))
    AND pg_tables.schemaname not like 'pg_%'
    AND pg_tables.schemaname <> 'information_schema'
ORDER BY
    pg_tables.tablename, fk."referencedTable", fk."sourceColumn";-- @qd_introspection
    `,
          [
            options.excludedSchemas,
          ],
        ),
    )();

    return out;
  }

  async get(
    fullyQualifiedTable: FullyQualifiedTableName,
    values: Record<string, unknown>,
  ) {
    const columnsText = Object.keys(values)
      .map((rawKey, i) => {
        const key = PgIdentifier.fromString(rawKey);
        return `${key} = $${i + 1}`;
      })
      .join(" AND ");
    // TODO: pass the schema along
    const sqlString =
      `select *, ctid from ${fullyQualifiedTable} where ${columnsText} limit 1 -- @qd_introspection`;
    const params = Object.values(values);
    log.debug(`${sqlString} : [${params.join(", ")}]`, "pg-connector:get");
    const data = await withSpan(
      "connector.get",
      () => this.db.exec<Row & { ctid?: string }>(sqlString, params),
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
      table: fullyQualifiedTable,
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
    fullyQualifiedTable: string,
    options: CursorOptions,
  ): AsyncGenerator<PostgresTuple, void, unknown> {
    if (!this.db.cursor) {
      throw new Error("PostgresConnector.cursor is not supported");
    }
    const tupleEstimate = this.tupleEstimates.get(fullyQualifiedTable);
    if (tupleEstimate === undefined) {
      console.warn(
        `No tuple estimate for ${fullyQualifiedTable}. Falling back to slow query. Is the db vacuum analyzed?`,
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
          `select *, ctid from ${fullyQualifiedTable} order by random() -- @qd_introspection`,
        );
    } else {
      // this really needs to be tweaked lol
      cursor = this.db.cursor(
        `select *, ctid from ${fullyQualifiedTable} tablesample bernoulli(${options.requiredRows / tupleEstimate + 10
        }) repeatable(1) -- @qd_introspection`,
      );
    }
    for await (const data of cursor) {
      if (shutdownController.signal.aborted) {
        break;
      }
      if (data === undefined) {
        log.error(
          `Cursor for table ${fullyQualifiedTable} returned an undefined value`,
          "pg-connector:cursor",
        );
        continue;
      }
      if (typeof data.ctid !== "undefined") {
        data[ctidSymbol] = data.ctid;
      }
      delete data.ctid;
      yield { data, table: fullyQualifiedTable };
    }
  }
  /**
   * Serializes sampled data using postgres's `quote_literal` function
   * into batched INSERT statements that can be restored into IXR.
   */
  async serialize(
    tables: TableRows<Row>,
    options: DependencyAnalyzerOptions,
    schema: FullSchema,
  ): Promise<SerializeResult> {
    const mkKey = (
      schema: PgIdentifier,
      table: PgIdentifier,
      column: PgIdentifier,
    ) => `${schema}:${table}:${column}`;
    const schemaMap = new Map<string, FullSchemaColumn>();
    if (schema.tables) {
      for (const table of schema.tables) {
        for (const column of table.columns) {
          schemaMap.set(
            mkKey(table.schemaName, table.tableName, column.name),
            column,
          );
        }
      }
    }
    const comments = [
      `-- START:Sampled data`,
      `-- Sampled by @query-doctor/analyzer on ${new Date().toISOString()
      } | options = ${JSON.stringify(
        options,
      )
      }`,
      "--",
      "-- Note: Using session_replication_role to prevent foreign key constraints from being checked.",
      "-- If adding new rows manually, you might want to put new insert statements after the sampled data.",
    ];
    const directives = ["SET session_replication_role = 'replica';"];
    let out = `${comments.join("\n")}\n${directives.join("\n")}\n\n`;
    const sampledRecords: Record<FullyQualifiedTableName, number> = {};
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
    for (const [fullyQualifiedTable, rows] of Object.entries(tables)) {
      const tableSchema = schema.tables?.find((s) => {
        return `${s.schemaName}.${s.tableName}` === fullyQualifiedTable;
      });
      if (!tableSchema) {
        console.warn(
          `No schema found for ${fullyQualifiedTable}. Skipping. Is there a quoting mismatch with the table name?`,
        );
        continue;
      }
      const allCtids = rows.map((row) => row[ctidSymbol]);
      const columns = tableSchema.columns.map(
        (c) => `quote_literal(${c.name}) as ${c.name}`,
      );
      const query = `select ${columns.join(
        ", ",
      )
        } from (select * from ${fullyQualifiedTable} where ctid = any($1::tid[])) as samples -- @qd_introspection`;
      log.debug(
        `${query} : [${allCtids.join(", ")}]`,
        "pg-connector:serialize",
      );
      const serialized = await withSpan(
        "connector.get",
        () => this.db.exec(query, [allCtids]),
      )();

      const estimate = this.tupleEstimates.get(fullyQualifiedTable) ?? "?";
      const comment =
        `-- ${fullyQualifiedTable} | ${serialized.length} sampled out of ${estimate.toLocaleString()} (estimate)`;
      const insertStatement =
        `${comment}\nINSERT INTO ${fullyQualifiedTable} (${tableSchema.columns
          .map((c) => c.name)
          .join(", ")
        })\nOVERRIDING SYSTEM VALUE VALUES\n`;
      // overriding system value prevents breaking columns that are (generated always as)
      if (serialized.length === 0) {
        console.warn(`No rows found for ${fullyQualifiedTable}. Skipping.`);
        continue;
      }
      const serializedRows = [];
      for (const row of serialized) {
        serializedRows.push(
          `(${tableSchema.columns
            .map((col) => {
              const value =
                (row as Record<string, unknown>)[col.name.toString()];
              if (value === null) {
                return "NULL";
              }
              return value;
            })
            .join(", ")
          })`,
        );
      }
      out += `${insertStatement}  ${serializedRows.join(",\n  ")};\n\n`;
      sampledRecords[fullyQualifiedTable] = serialized.length;
    }
    log.info(
      `Serialized ${Object.keys(tables).length} tables`,
      "pg-connector:serialize",
    );
    out += `-- END:Sampled data\nSET session_replication_role = 'origin';\n\n`;
    return {
      serialized: out,
      sampledRecords,
    };
  }

  hash(value: PostgresTuple): Hash {
    return `${value.table}:${value.data[ctidSymbol]}` as Hash;
  }

  /**
   * Per-table `reltuples` for every user table, keyed `"schema.table"`.
   *
   * The Size/Shape Drift probe (ADR 0007 §2). Reads `pg_class` only — never
   * `pg_statistic` — so it is cheap enough to fold into the 60s schema poll,
   * unlike the full statistics dump it decides whether to run.
   */
  public async getReltuplesByTable(): Promise<Map<string, number>> {
    const results = await this.db.exec<{
      schema_name: string;
      table_name: string;
      reltuples: string;
    }>(
      `SELECT n.nspname AS schema_name, c.relname AS table_name, c.reltuples::bigint AS reltuples
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'tiger', 'tiger_data', 'topology')
         AND c.relname NOT IN ('pg_stat_statements', 'pg_stat_statements_info')`,
    );
    const byTable = new Map<string, number>();
    for (const row of results) {
      // A never-analyzed table reports -1; treat it as 0 so it doesn't read as
      // a size change on the next poll.
      const reltuples = Math.max(0, Number(row.reltuples));
      byTable.set(`${row.schema_name}.${row.table_name}`, reltuples);
    }
    return byTable;
  }

  public async getTotalRowCount(
    tables: { schemaName: PgIdentifier; tableName: PgIdentifier }[],
  ): Promise<number> {
    if (tables.length === 0) return 0;

    const schemaNames = tables.map((t) => t.schemaName.toString());
    const tableNames = tables.map((t) => t.tableName.toString());

    const results = await this.db.exec<{ total_rows: string }>(
      `SELECT COALESCE(SUM(c.reltuples), 0)::bigint as total_rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'm')
         AND (n.nspname, c.relname) = ANY(
           SELECT s, t FROM unnest($1::text[], $2::text[]) AS x(s, t)
         )`,
      [schemaNames, tableNames],
    );
    return Number(results[0]?.total_rows ?? 0);
  }

  public async getDatabaseInfo() {
    const results = await this.db.exec<{
      serverVersion: string;
      serverVersionNum: string;
      username: string;
      isSuperuser: boolean;
    }>(
      `select
          version() as "serverVersion",
          current_setting('server_version_num') as "serverVersionNum",
          usename as "username",
          usesuper as "isSuperuser"
          FROM pg_user WHERE usename = current_user; -- @qd_introspection`,
    );
    return {
      serverVersion: results[0]!.serverVersion,
      serverVersionNum: results[0]!.serverVersionNum,
      username: results[0]!.username,
      isSuperuser: results[0]!.isSuperuser,
    };
  }

  private async getQuerySource(): Promise<QuerySourceExtension> {
    // The marker must sit before the terminating semicolon — Postgres strips
    // trailing comments past `;` from the text that pg_stat_statements stores,
    // which would let this query bypass the introspection filter in
    // getRecentQueries() and surface after pg_stat_statements_reset().
    const results = await this.db.exec<{ schema: string; extension: string }>(`
      SELECT e.extname as extension, n.nspname as schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname IN ('pg_stat_statements', 'pg_stat_monitor') -- @qd_introspection
    `);
    const firstResult = results[0];
    if (!firstResult) {
      this.querySource = null;
      throw new ExtensionNotInstalledError([
        "pg_stat_statements",
        "pg_stat_monitor"
      ]);
    }
    this.querySource = {
      extensionName: PgIdentifier.fromString(firstResult.extension),
      schema: PgIdentifier.fromString(firstResult.schema)
    };
    // A run that reads the statistics and a run that silently found nothing
    // used to look identical in the logs. Name what was resolved.
    log.debug(
      `query source: ${firstResult.extension} in schema ${firstResult.schema}`,
      "postgres",
    );
    this.warnIfExtensionIsInPublic(this.querySource);
    return this.querySource;
  }

  /**
   * An extension in `public` is a landmine for any migration tool that
   * reconciles that schema, and nothing at the point of failure names it. We
   * resolve the schema on every read, so this is the one place that knows.
   */
  private warnIfExtensionIsInPublic(source: QuerySourceExtension): void {
    const extension = source.extensionName.unquoted();
    if (source.schema.unquoted() !== "public") {
      return;
    }
    let warned = PostgresConnector.warnedAboutPublicSchema.get(this.db);
    if (!warned) {
      warned = new Set();
      PostgresConnector.warnedAboutPublicSchema.set(this.db, warned);
    }
    if (warned.has(extension)) {
      return;
    }
    warned.add(extension);
    log.warn(
      `${extension} is installed in the public schema. A migration tool that reconciles public cannot drop its extension-owned views and will abort mid-run (SQLSTATE 2BP01). Move it with: CREATE SCHEMA IF NOT EXISTS ${PostgresConnector.EXTENSION_SCHEMA}; ALTER EXTENSION ${extension} SET SCHEMA ${PostgresConnector.EXTENSION_SCHEMA};`,
      "postgres",
    );
  }

  /**
   * The schema one named extension lives in. {@link getQuerySource} answers the
   * broader "where do the queries come from", which can resolve to
   * `pg_stat_monitor`; a caller that installed a specific extension needs to
   * probe that one.
   *
   * @throws {ExtensionNotInstalledError}
   */
  private async getExtensionSchema(extension: string): Promise<PgIdentifier> {
    const [row] = await this.db.exec<{ schema: string }>(
      `SELECT n.nspname AS schema
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = $1 -- @qd_introspection`,
      [extension],
    );
    if (!row) {
      throw new ExtensionNotInstalledError([extension]);
    }
    return PgIdentifier.fromString(row.schema);
  }

  /**
   * Get the latest queries using pg_stat_statements
   * @throws {ExtensionNotInstalledError} - pg_stat_statements is not installed
   * @throws {PostgresError} - Not regular Error
   */
  public async getRecentQueries(): Promise<RecentQuery[]> {
    const source = await this.getQuerySource();
    try {
      if (
        source.extensionName.toString() === "pg_stat_statements" ||
        source.extensionName.toString() === "pg_stat_monitor"
      ) {
        const sql = dumpQueriesSql(
          source.schema.toString(),
          source.extensionName.toString() as "pg_stat_statements" | "pg_stat_monitor",
        );
        const results = await this.db.exec<RawRecentQuery>(sql);
        return await syncQueries(results);
      }
    } catch (err) {
      if (isMissingExtensionObject(err)) {
        throw PostgresConnector.extensionNotInstalledError;
      }
      console.error(err);
      throw new PostgresError(err instanceof Error ? err.message : String(err));
    }

    throw PostgresConnector.extensionNotInstalledError;
  }

  /**
   * @throws {ExtensionNotInstalledError}
   * @throws {PostgresError}
   */
  public async resetPgStatStatements(): Promise<void> {
    const source = await this.getQuerySource();
    try {
      if (source.extensionName.toString() === "pg_stat_statements") {
        await this.db.exec(`
            SELECT ${source.schema}.pg_stat_statements_reset(); -- @qd_introspection
        `);
      } else if (source.extensionName.toString() === "pg_stat_monitor") {
        await this.db.exec(`
            SELECT ${source.schema}.pg_stat_monitor_reset(); -- @qd_introspection
        `);
      }
    } catch (err) {
      if (isMissingExtensionObject(err)) {
        throw PostgresConnector.extensionNotInstalledError;
      }
      throw new PostgresError(err instanceof Error ? err.message : String(err));
    }
  }

  public async vacuum(): Promise<void> {
    const vacuumAnalyze = new PostgresQueryBuilder("vacuum analyze")
      .introspect()
      .build();
    try {
      await this.db.exec(vacuumAnalyze);
    } catch (err) {
      throw new PostgresError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Installs `pg_stat_statements` into {@link options.schema}, defaulting to
   * {@link PostgresConnector.EXTENSION_SCHEMA}.
   *
   * An extension already installed elsewhere is left where it is — relocating
   * it needs an ownership we may not hold, and moving a schema object out from
   * under whoever put it there is not ours to decide. The resolver warns about
   * a `public` placement on every read instead.
   *
   * @throws {PostgresError}
   * @throws {ExtensionNotInstalledError} - the install ran but left nothing behind
   */
  public async installPgStatStatements(
    options: { schema?: string } = {},
  ): Promise<{ preloadUpdated: boolean; schema: string }> {
    let preloadUpdated = false;
    const targetSchema = PgIdentifier.fromString(
      options.schema ?? PostgresConnector.EXTENSION_SCHEMA,
    );

    const [preload] = await this.db.exec<{ setting: string }>(`
      SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'; -- @qd_introspection
    `);
    const current = preload?.setting ?? "";
    const libs = current.split(",").map((s) => s.trim()).filter(Boolean);
    if (!libs.includes("pg_stat_statements")) {
      const updated = [...libs, "pg_stat_statements"].join(",");
      try {
        await this.db.exec(`ALTER SYSTEM SET shared_preload_libraries = '${updated}';`);
        preloadUpdated = true;
      } catch (err) {
        throw new PostgresError(err instanceof Error ? err.message : String(err));
      }
    }

    const [result] = await this.db.exec<{ exists: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      ) AS exists; -- @qd_introspection
    `);
    if (!result?.exists) {
      try {
        await this.db.exec(`CREATE SCHEMA IF NOT EXISTS ${targetSchema};`);
        await this.db.exec(
          `CREATE EXTENSION pg_stat_statements SCHEMA ${targetSchema};`,
        );
      } catch (err) {
        throw new PostgresError(err instanceof Error ? err.message : String(err));
      }
    }

    // Resolve the schema rather than assume it. The extension may predate this
    // call, and an unqualified probe reads through the search_path — which
    // reports 42P01 for the very placement the branch above just produced.
    const schema = await this.getExtensionSchema("pg_stat_statements");
    this.warnIfExtensionIsInPublic({
      extensionName: PgIdentifier.fromString("pg_stat_statements"),
      schema,
    });
    try {
      await this.db.exec(
        `SELECT 1 FROM ${schema}.pg_stat_statements LIMIT 1; -- @qd_introspection`,
      );
    } catch (err) {
      throw new PostgresError(err instanceof Error ? err.message : String(err));
    }

    return { preloadUpdated, schema: schema.unquoted() };
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

interface QuerySourceExtension {
  schema: PgIdentifier;
  extensionName: PgIdentifier;
}

type TableName = string;
