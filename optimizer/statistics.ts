import postgres from "postgresjs";
import dedent from "dedent";
import { gray } from "@std/fmt/colors";
import { z } from "zod";

declare const brand: unique symbol;
type PostgresVersion = string & { [brand]: never };

export async function getPostgresVersion(
  sql: postgres.Sql,
): Promise<PostgresVersion> {
  return (await sql`show server_version_num`)[0]
    .server_version_num as PostgresVersion;
}

type ColumnMappings = Map<string, Record<string, number>>;
type ValueKind = "real" | "text" | "boolean" | null;

export type Path = string;

export type StatisticsMode =
  | { kind: "fromAssumption"; reltuples: number; relpages: number }
  | { kind: "fromStatisticsExport"; stats: ExportedStats[] };

const DEFAULT_RELTUPLES = 10_000_000;
const DEFAULT_RELPAGES = 1_000;

export class Statistics {
  private statisticsMode: StatisticsMode = {
    kind: "fromAssumption",
    reltuples: DEFAULT_RELTUPLES,
    relpages: DEFAULT_RELPAGES,
  };
  constructor(
    private readonly sql: postgres.Sql,
    public readonly postgresVersion: PostgresVersion,
    private readonly exportedMetadata: ExportedStats[] | undefined,
    public readonly ownMetadata: ExportedStats[],
  ) {
    if (this.exportedMetadata) {
      this.statisticsMode = {
        kind: "fromStatisticsExport",
        stats: this.exportedMetadata,
      };
    }
  }

  static async fromPostgres(
    sql: postgres.Sql,
    postgresVersion: PostgresVersion,
    metadataOrPath?: Path | ExportedStats[],
  ): Promise<Statistics> {
    const ownStatsPromise = Statistics.dumpStats(sql, postgresVersion, "full");
    let stats: ExportedStats[] | undefined;
    if (typeof metadataOrPath === "string") {
      const text = await Deno.readTextFile(metadataOrPath);
      stats = z.array(ExportedStats).parse(JSON.parse(text));
    } else if (typeof metadataOrPath !== "undefined") {
      stats = metadataOrPath;
    }
    const ownStats = await ownStatsPromise;
    return new Statistics(sql, postgresVersion, stats, ownStats);
  }

  restoreStats(tx: postgres.TransactionSql) {
    // if (this.postgresVersion < "180000") {
    return this.restoreStats17(tx);
    // }
    // return this.restoreStats18(tx);
  }

  mode() {}

  private supportedStatisticKinds = [3, 5];

  private supportsKind(kind: number) {
    return this.supportedStatisticKinds.includes(kind);
  }

  /**
   * We have to cast stavaluesN to the correct type
   * This derives that type for us so it can be used in `array_in`
   */
  private stavalueKind(values: unknown[] | null): ValueKind {
    if (!values || values.length === 0) {
      return null;
    }
    const [elem] = values;
    if (typeof elem === "number") {
      return "real";
    } else if (typeof elem === "boolean") {
      return "boolean";
    }
    // is everything else a text? What about strinfied dates?
    // we might need column metadata access here if we do
    return "text";
  }

  private async restoreStats17(tx: postgres.TransactionSql) {
    const warnings = {
      tablesNotInExports: [] as string[],
      tablesNotInTest: [] as string[],
      tableNotAnalyzed: [] as string[],
      statsMissing: [] as {
        statistic: string;
        table: string;
        schema: string;
        column: string;
      }[],
    };
    const processedTables = new Set<string>();

    let columnStatsUpdatePromise: Promise<postgres.RowList<any>> | undefined;
    const columnStatsValues: Array<{
      schema_name: string;
      table_name: string;
      column_name: string;
      stainherit: boolean;
      stanullfrac: number;
      stawidth: number;
      stadistinct: number;
      stakind1: number;
      stakind2: number;
      stakind3: number;
      stakind4: number;
      stakind5: number;
      staop1: string;
      staop2: string;
      staop3: string;
      staop4: string;
      staop5: string;
      stacoll1: string;
      stacoll2: string;
      stacoll3: string;
      stacoll4: string;
      stacoll5: string;
      stanumbers1: number[] | null;
      stanumbers2: number[] | null;
      stanumbers3: number[] | null;
      stanumbers4: number[] | null;
      stanumbers5: number[] | null;
      stavalues1: any[] | null;
      stavalues2: any[] | null;
      stavalues3: any[] | null;
      stavalues4: any[] | null;
      stavalues5: any[] | null;
      _value_type1: ValueKind;
      _value_type2: ValueKind;
      _value_type3: ValueKind;
      _value_type4: ValueKind;
      _value_type5: ValueKind;
    }> = [];
    if (this.exportedMetadata) {
      for (const table of this.ownMetadata) {
        const targetTable = this.exportedMetadata.find(
          (m) =>
            m.tableName === table.tableName &&
            m.schemaName === table.schemaName,
        );
        if (!targetTable?.columns) {
          continue;
        }
        for (const column of targetTable.columns) {
          const { stats } = column;
          if (!stats) {
            continue;
          }
          // TODO: track processed columns too
          columnStatsValues.push({
            schema_name: table.schemaName,
            table_name: table.tableName,
            column_name: column.columnName,
            stainherit: stats.stainherit,
            stanullfrac: stats.stanullfrac,
            stawidth: stats.stawidth,
            stadistinct: stats.stadistinct,
            stakind1: stats.stakind1,
            stakind2: stats.stakind2,
            stakind3: stats.stakind3,
            stakind4: stats.stakind4,
            stakind5: stats.stakind5,
            staop1: stats.staop1,
            staop2: stats.staop2,
            staop3: stats.staop3,
            staop4: stats.staop4,
            staop5: stats.staop5,
            stacoll1: stats.stacoll1,
            stacoll2: stats.stacoll2,
            stacoll3: stats.stacoll3,
            stacoll4: stats.stacoll4,
            stacoll5: stats.stacoll5,
            stanumbers1: stats.stanumbers1,
            stanumbers2: stats.stanumbers2,
            stanumbers3: stats.stanumbers3,
            stanumbers4: stats.stanumbers4,
            stanumbers5: stats.stanumbers5,
            stavalues1: stats.stavalues1,
            stavalues2: stats.stavalues2,
            stavalues3: stats.stavalues3,
            stavalues4: stats.stavalues4,
            stavalues5: stats.stavalues5,
            _value_type1: this.stavalueKind(stats.stavalues1),
            _value_type2: this.stavalueKind(stats.stavalues2),
            _value_type3: this.stavalueKind(stats.stavalues3),
            _value_type4: this.stavalueKind(stats.stavalues4),
            _value_type5: this.stavalueKind(stats.stavalues5),
          });
          // TODO: support stavaluesN as well
        }
      }
      /**
       * Postgres has 5 different slots for storing statistics per column and a potentially unlimited
       * number of statistic types to choose from. Each code in `stakindN` can mean different things.
       * Some statistics are just numerical values such as `n_distinct` and `correlation`, meaning
       * they're only derived from `stanumbersN` and the value of `stanumbersN` is never read.
       * Others take advantage of the `stavaluesN` columns which use `anyarray` type to store
       * concrete values internally for things like histogram bounds.
       * Unfortunately we cannot change anyarrays without a C extension.
       *
       * (1) = most common values
       * (2) = scalar histogram
       * (3) = correlation <- can change
       * (4) = most common elements
       * (5) = distinct elem count histogram <- can change
       * (6) = length histogram (?) These don't appear in pg_stats
       * (7) = bounds histogram (?) These don't appear in pg_stats
       * (N) = potentially many more kinds of statistics. But postgres <=18 only uses these 7.
       *
       * What we're doing here is setting ANY statistic we cannot directly control
       * (anything that relies on stavaluesN) to 0 to make sure the planner isn't influenced by what
       * what the db collected from the test data.
       * Because we do our tests with `generic_plan` it seems it's already unlikely that the planner will be
       * using things like common values or histogram bounds to make the planning decisions we care about.
       * This is a just in case.
       */
      const sql = dedent`
    WITH input AS (
      SELECT
        c.oid AS starelid,
        a.attnum AS staattnum,
        v.stainherit,
        v.stanullfrac,
        v.stawidth,
        v.stadistinct,
        v.stakind1,
        v.stakind2,
        v.stakind3,
        v.stakind4,
        v.stakind5,
        v.staop1,
        v.staop2,
        v.staop3,
        v.staop4,
        v.staop5,
        v.stacoll1,
        v.stacoll2,
        v.stacoll3,
        v.stacoll4,
        v.stacoll5,
        v.stanumbers1,
        v.stanumbers2,
        v.stanumbers3,
        v.stanumbers4,
        v.stanumbers5,
        case
          when v.stavalues1 is null then null
          else array_in(v.stavalues1::text::cstring, v._value_type1::regtype::oid, -1)
        end as stavalues1,
        case
          when v.stavalues2 is null then null
          else array_in(v.stavalues2::text::cstring, v._value_type2::regtype::oid, -1)
        end as stavalues2,
        case
          when v.stavalues3 is null then null
          else array_in(v.stavalues3::text::cstring, v._value_type3::regtype::oid, -1)
        end as stavalues3,
        case
          when v.stavalues4 is null then null
          else array_in(v.stavalues4::text::cstring, v._value_type4::regtype::oid, -1)
        end as stavalues4,
        case
          when v.stavalues5 is null then null
          else array_in(v.stavalues5::text::cstring, v._value_type5::regtype::oid, -1)
        end as stavalues5
      FROM jsonb_to_recordset($1::jsonb) AS v(
        schema_name text,
        table_name text,
        column_name text,
        stainherit boolean,
        stanullfrac real,
        stawidth integer,
        stadistinct real,
        stakind1 real,
        stakind2 real,
        stakind3 real,
        stakind4 real,
        stakind5 real,
        staop1 oid,
        staop2 oid,
        staop3 oid,
        staop4 oid,
        staop5 oid,
        stacoll1 oid,
        stacoll2 oid,
        stacoll3 oid,
        stacoll4 oid,
        stacoll5 oid,
        stanumbers1 real[],
        stanumbers2 real[],
        stanumbers3 real[],
        stanumbers4 real[],
        stanumbers5 real[],
        stavalues1 text[],
        stavalues2 text[],
        stavalues3 text[],
        stavalues4 text[],
        stavalues5 text[],
        _value_type1 text,
        _value_type2 text,
        _value_type3 text,
        _value_type4 text,
        _value_type5 text
      )
      JOIN pg_class c ON c.relname = v.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = v.schema_name
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = v.column_name
    ),
    updated AS (
      UPDATE pg_statistic s
      SET
        stanullfrac = i.stanullfrac,
        stawidth = i.stawidth,
        stadistinct = i.stadistinct,
        stakind1 = i.stakind1,
        stakind2 = i.stakind2,
        stakind3 = i.stakind3,
        stakind4 = i.stakind4,
        stakind5 = i.stakind5,
        staop1 = i.staop1,
        staop2 = i.staop2,
        staop3 = i.staop3,
        staop4 = i.staop4,
        staop5 = i.staop5,
        stacoll1 = i.stacoll1,
        stacoll2 = i.stacoll2,
        stacoll3 = i.stacoll3,
        stacoll4 = i.stacoll4,
        stacoll5 = i.stacoll5,
        stanumbers1 = i.stanumbers1,
        stanumbers2 = i.stanumbers2,
        stanumbers3 = i.stanumbers3,
        stanumbers4 = i.stanumbers4,
        stanumbers5 = i.stanumbers5,
        stavalues1 = i.stavalues1,
        stavalues2 = i.stavalues2,
        stavalues3 = i.stavalues3,
        stavalues4 = i.stavalues4,
        stavalues5 = i.stavalues5
      FROM input i
      WHERE s.starelid = i.starelid AND s.staattnum = i.staattnum AND s.stainherit = i.stainherit
      RETURNING s.starelid, s.staattnum, s.stainherit, s.stakind1, s.stakind2, s.stakind3, s.stakind4, s.stakind5
    ),
    inserted as (
      INSERT INTO pg_statistic (
        starelid, staattnum, stainherit,
        stanullfrac, stawidth, stadistinct,
        stakind1, stakind2, stakind3, stakind4, stakind5,
        staop1, staop2, staop3, staop4, staop5,
        stacoll1, stacoll2, stacoll3, stacoll4, stacoll5,
        stanumbers1, stanumbers2, stanumbers3, stanumbers4, stanumbers5,
        stavalues1, stavalues2, stavalues3, stavalues4, stavalues5
      )
      SELECT
      i.starelid, i.staattnum, i.stainherit,
      i.stanullfrac, i.stawidth, i.stadistinct,
      i.stakind1, i.stakind2, i.stakind3, i.stakind4, i.stakind5,
      i.staop1, i.staop2, i.staop3, i.staop4, i.staop5,
      i.stacoll1, i.stacoll2, i.stacoll3, i.stacoll4, i.stacoll5,
      i.stanumbers1, i.stanumbers2, i.stanumbers3, i.stanumbers4, i.stanumbers5,
      i.stavalues1, i.stavalues2, i.stavalues3, i.stavalues4, i.stavalues5
      FROM input i
      LEFT JOIN updated u
        ON i.starelid = u.starelid AND i.staattnum = u.staattnum AND i.stainherit = u.stainherit
      WHERE u.starelid IS NULL
      returning starelid, staattnum, stainherit, stakind1, stakind2, stakind3, stakind4, stakind5
    )
    select * from updated union all (select * from inserted); -- @qd_introspection`;

      columnStatsUpdatePromise = tx
        .unsafe(sql, [columnStatsValues])
        .catch((err) => {
          console.error("Something wrong wrong updating column stats");
          console.error(err);
          throw err;
          // return err;
          // return Promise.reject(err)
        });
    }

    let reltuplesPromise: Promise<postgres.RowList<any>>;
    const reltuplesValues: Array<{
      reltuples: number;
      relpages: number;
      relname: string;
      schema_name: string;
    }> = [];
    for (const table of this.ownMetadata) {
      if (!table.columns) {
        continue;
      }
      processedTables.add(`${table.schemaName}.${table.tableName}`);
      let targetTable: ExportedStats | undefined;
      if (this.exportedMetadata) {
        targetTable = this.exportedMetadata.find(
          (m) =>
            m.tableName === table.tableName &&
            m.schemaName === table.schemaName,
        );
      }
      let reltuples: number;
      let relpages: number;
      if (targetTable) {
        // don't want to run our prod stats with -1 reltuples
        // we warn the user about this later
        // if (targetTable.reltuples < 10 || targetTable.reltuples > 10000) {
        reltuples = targetTable.reltuples;
        relpages = targetTable.relpages;
        // }
      } else if (this.statisticsMode.kind === "fromAssumption") {
        reltuples = this.statisticsMode.reltuples;
        relpages = this.statisticsMode.relpages;
      } else {
        // we want to warn about tables that are in the test but not in the exported stats
        // this can happen in case a new table is created in a PR
        warnings.tablesNotInExports.push(
          `${table.schemaName}.${table.tableName}`,
        );
        reltuples = DEFAULT_RELTUPLES;
        relpages = DEFAULT_RELPAGES;
      }
      reltuplesValues.push({
        relname: table.tableName,
        schema_name: table.schemaName,
        reltuples,
        relpages,
      });
    }

    const reltuplesQuery = dedent`
        update pg_class
        set reltuples = v.reltuples, relpages = v.relpages
        from jsonb_to_recordset($1::jsonb)
            as v(reltuples real, relpages integer, relname text, schema_name text)
        where pg_class.relname = v.relname
        and pg_class.relnamespace = (select oid from pg_namespace where nspname = v.schema_name)
        returning pg_class.relname, pg_class.relnamespace, pg_class.reltuples, pg_class.relpages;
        `;

    reltuplesPromise = tx
      .unsafe(reltuplesQuery, [reltuplesValues])
      .catch((err) => {
        console.error("Something went wrong updating reltuples/relpages");
        console.error(err);
        return err;
      });

    if (this.exportedMetadata) {
      for (const table of this.exportedMetadata) {
        const tableExists = processedTables.has(
          `${table.schemaName}.${table.tableName}`,
        );
        if (tableExists && table.reltuples === -1) {
          console.warn(
            `Table ${table.tableName} has reltuples -1. Your production database is probably not analyzed properly`,
          );
          // we expect production stats to have real numbers
          warnings.tableNotAnalyzed.push(
            `${table.schemaName}.${table.tableName}`,
          );
        }
        if (tableExists) {
          continue;
        }
        // there's a LOT of tables in statistics exports for things like timescaledb
        // that might not show up in the test data. This check might be too strict.
        warnings.tablesNotInTest.push(`${table.schemaName}.${table.tableName}`);
      }
    }
    const [statsUpdates, reltuplesUpdates] = await Promise.all([
      columnStatsUpdatePromise,
      reltuplesPromise,
    ]);
    const updatedColumnsProperly = statsUpdates
      ? statsUpdates.length === columnStatsValues.length
      : true;
    if (!updatedColumnsProperly) {
      console.error(`Did not update expected column stats`);
    }
    if (reltuplesUpdates.length !== reltuplesValues.length) {
      console.error(`Did not update expected reltuples/relpages`);
    }
    return warnings;
  }

  static async dumpStats(
    sql: postgres.Sql,
    postgresVersion: PostgresVersion,
    kind: "anonymous" | "full",
  ): Promise<ExportedStats[]> {
    const fullDump = kind === "full";
    console.log(`dumping stats for postgres ${gray(postgresVersion)}`);
    // certain things are only supported with pg17
    // if (postgresVersion < "170000") {
    const stats = await sql.unsafe<{ json_agg: ExportedStats[] }[]>(
      `
SELECT
  json_agg(t)
  FROM (
    SELECT
  c.table_name as "tableName",
  c.table_schema as "schemaName",
  cl.reltuples,
  cl.relpages,
  cl.relallvisible,
  n.nspname as "schemaName",
  json_agg(
    json_build_object(
      'columnName', c.column_name,
      'dataType', c.data_type,
      'isNullable', (c.is_nullable = 'YES')::boolean,
      'characterMaximumLength', c.character_maximum_length,
      'numericPrecision', c.numeric_precision,
      'numericScale', c.numeric_scale,
      'columnDefault', c.column_default,
      'stats', (
        select json_build_object(
          'starelid', s.starelid,
          'staattnum', s.staattnum,
          'stainherit', s.stainherit,
          'stanullfrac', s.stanullfrac,
          'stawidth', s.stawidth,
          'stadistinct', s.stadistinct,
          -- slot 1
          'stakind1', s.stakind1,
          'staop1', s.staop1,
          'stacoll1', s.stacoll1,
          'stanumbers1', s.stanumbers1,
          -- slot 2
          'stakind2', s.stakind2,
          'staop2', s.staop2,
          'stacoll2', s.stacoll2,
          'stanumbers2', s.stanumbers2,
          -- slot 3
          'stakind3', s.stakind3,
          'staop3', s.staop3,
          'stacoll3', s.stacoll3,
          'stanumbers3', s.stanumbers3,
          -- slot 4
          'stakind4', s.stakind4,
          'staop4', s.staop4,
          'stacoll4', s.stacoll4,
          'stanumbers4', s.stanumbers4,
          -- slot 5
          'stakind5', s.stakind5,
          'staop5', s.staop5,
          'stacoll5', s.stacoll5,
          'stanumbers5', s.stanumbers5,
          -- non-anonymous stats
          'stavalues1', case when $1 then s.stavalues1 else null end,
          'stavalues2', case when $1 then s.stavalues2 else null end,
          'stavalues3', case when $1 then s.stavalues3 else null end,
          'stavalues4', case when $1 then s.stavalues4 else null end,
          'stavalues5', case when $1 then s.stavalues5 else null end
        )
          from pg_statistic s
        where
          s.starelid = a.attrelid
          and s.staattnum = a.attnum
      )
    )
  ORDER BY c.ordinal_position) as columns
FROM
    information_schema.columns c
JOIN
    pg_attribute a
    ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
    AND a.attname = c.column_name
JOIN
    pg_class cl
    ON cl.relname = c.table_name
JOIN
    pg_namespace n
    ON n.oid = cl.relnamespace
WHERE
    c.table_name not like 'pg_%'
    and n.nspname <> 'information_schema'
    and c.table_name not in ('pg_stat_statements', 'pg_stat_statements_info')
GROUP BY
    c.table_name, c.table_schema, cl.reltuples, cl.relpages, cl.relallvisible, n.nspname /* @qd_introspection */
) t;
      `,
      [fullDump],
    );
    return stats[0].json_agg;
  }

  /**
   * Returns all indexes in the database.
   * ONLY handles regular btree indexes
   */
  async getExistingIndexes(): Promise<IndexedTable[]> {
    const indexes = await this.sql<IndexedTable[]>`
      WITH partitioned_tables AS (
          SELECT
              inhparent::regclass AS parent_table,
              inhrelid::regclass AS partition_table
          FROM
              pg_inherits
      )
      SELECT
          n.nspname AS schema_name,
          COALESCE(pt.parent_table::text, t.relname) AS table_name,
          i.relname AS index_name,
          am.amname AS index_type,
          array_agg(
              CASE
                  -- Handle regular columns
                  WHEN a.attname IS NOT NULL THEN
                    json_build_object('name', a.attname, 'order',
                      CASE
                          WHEN (indoption[array_position(ix.indkey, a.attnum)] & 1) = 1 THEN 'DESC'
                          ELSE 'ASC'
                      END)
                  -- Handle expressions
                  ELSE
                      json_build_object('name', pg_get_expr((ix.indexprs)::pg_node_tree, t.oid), 'order',
                      CASE
                          WHEN (indoption[array_position(ix.indkey, k.attnum)] & 1) = 1 THEN 'DESC'
                          ELSE 'ASC'
                      END)
              END
              ORDER BY array_position(ix.indkey, k.attnum)
          ) AS index_columns
      FROM
          pg_class t
          LEFT JOIN partitioned_tables pt ON t.oid = pt.partition_table
          JOIN pg_index ix ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_am am ON i.relam = am.oid
          LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum, ordinality) ON true
          LEFT JOIN pg_attribute a ON a.attnum = k.attnum AND a.attrelid = t.oid
          JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE
          n.nspname = 'public'
      GROUP BY
          n.nspname, COALESCE(pt.parent_table::text, t.relname), i.relname, am.amname
      ORDER BY
          COALESCE(pt.parent_table::text, t.relname), i.relname; -- @qd_introspection
      `;
    return indexes;
  }
}

export type ColumnMetadata = {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  stats: ColumnStats | null;
};

type ColumnStats = {
  stainherit: boolean;
  stanullfrac: number;
  stawidth: number;
  stadistinct: number;
  stakind1: number;
  stakind2: number;
  stakind3: number;
  stakind4: number;
  stakind5: number;
  staop1: number;
  staop2: number;
  staop3: number;
  staop4: number;
  staop5: number;
  stacoll1: number;
  stacoll2: number;
  stacoll3: number;
  stacoll4: number;
  stacoll5: number;
  stanumbers1: number;
  stanumbers2: number;
  stanumbers3: number;
  stanumbers4: number;
  stanumbers5: number;
};

export type TableMetadata = {
  tableName: string;
  schemaName: string;
  reltuples: number;
  relpages: number;
  relallvisible: number;
  relallfrozen?: number;
  columns: ColumnMetadata[];
};

type TableName = string;
export type TableStats = {
  tupleEstimate: bigint;
  pageCount: number;
};

export type SerializeResult = {
  schema: TableMetadata[];
  serialized: string;
  sampledRecords: Record<TableName, number>;
};

export type IndexOrder = "ASC" | "DESC";

export type IndexedTable = {
  index_columns: Array<{ name: string; order: IndexOrder }>;
  index_name: string;
  index_type: "btree" | "gin" | (string & {});
  // this is always public
  schema_name: string;
  table_name: string;
};

export const ExportedStatsStatistics = z.object({
  stawidth: z.number(),
  stainherit: z.boolean(),
  // 0 representing unknown
  stadistinct: z.number(),
  // this has no "nullable" state
  stanullfrac: z.number(),
  stakind1: z.number().min(0),
  stakind2: z.number().min(0),
  stakind3: z.number().min(0),
  stakind4: z.number().min(0),
  stakind5: z.number().min(0),
  staop1: z.string(),
  staop2: z.string(),
  staop3: z.string(),
  staop4: z.string(),
  staop5: z.string(),
  stacoll1: z.string(),
  stacoll2: z.string(),
  stacoll3: z.string(),
  stacoll4: z.string(),
  stacoll5: z.string(),
  stanumbers1: z.array(z.number()).nullable(),
  stanumbers2: z.array(z.number()).nullable(),
  stanumbers3: z.array(z.number()).nullable(),
  stanumbers4: z.array(z.number()).nullable(),
  stanumbers5: z.array(z.number()).nullable(),
  // theoretically... this could only be strings and numbers
  // but we don't have a crystal ball
  stavalues1: z.array(z.any()).nullable(),
  stavalues2: z.array(z.any()).nullable(),
  stavalues3: z.array(z.any()).nullable(),
  stavalues4: z.array(z.any()).nullable(),
  stavalues5: z.array(z.any()).nullable(),
});
export const ExportedStatsColumns = z.object({
  columnName: z.string(),
  stats: ExportedStatsStatistics.nullable(),
  dataType: z.string(),
  isNullable: z.boolean(),
  numericScale: z.number().nullable(),
  columnDefault: z.string().nullable(),
  numericPrecision: z.number().nullable(),
  characterMaximumLength: z.number().nullable(),
});

// This should match the output of the `_qd_dump_stats` function in README.md
// Need to make sure this is versioned to accept ALL potential outputs from every version of
// dump functions we make public
export const ExportedStatsV1 = z.object({
  tableName: z.string(),
  schemaName: z.string(),
  // can be negative
  relpages: z.number(),
  // can be negative
  reltuples: z.number(),
  relallvisible: z.number(),
  // only postgres 18+
  relallfrozen: z.number().optional(),
  columns: z.array(ExportedStatsColumns).nullable(),
});

export const ExportedStats = z.union([ExportedStatsV1]);

export type ExportedStats = z.infer<typeof ExportedStats>;
