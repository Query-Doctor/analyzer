import postgres from "postgresjs";
import dedent from "dedent";

export class Statistics {
  constructor(private readonly sql: postgres.Sql) {}

  async restoreStats(metadata: TableMetadata[]) {
    this.sql.begin(async (query) => {
      for (const table of metadata) {
        let sql = "";
        sql += dedent`
        SELECT * FROM pg_catalog.pg_restore_relation_stats(
          'version', '180000'::integer,
          'schemaname', '${table.schemaName}',
          'relname', '${table.tableName}',
          'relpages', '${table.relpages}'::integer,
          'reltuples', '${table.reltuples}'::real,
          'relallvisible', '${table.relallvisible}'::integer,
          'relallfrozen', '${table.relallfrozen}'::integer
        ); -- @qd_introspection\n
      `;
        await query.unsafe(sql);
        for (const column of table.columns) {
          let args = [];
          let index = 1;
          // console.log(column);
          const columns: string[] = [];
          if (!column.stats) {
            console.error(
              `No stats for column ${column.columnName} in table ${table.tableName}`
            );
            continue;
          }
          if (column.stats.inherited != undefined) {
            columns.push(`'inherited', '${column.stats.inherited}'::boolean`);
          }
          if (column.stats.null_frac != undefined) {
            columns.push(`'null_frac', '${column.stats.null_frac}'::real`);
          }
          if (column.stats.avg_width != undefined) {
            columns.push(`'avg_width', '${column.stats.avg_width}'::integer`);
          }
          if (column.stats.n_distinct != undefined) {
            columns.push(`'n_distinct', '${column.stats.n_distinct}'::real`);
          }
          if (column.stats.most_common_vals != undefined) {
            columns.push(`'most_common_vals', $${index++}::text`);
            args.push(column.stats.most_common_vals);
          }
          if (column.stats.most_common_freqs != undefined) {
            columns.push(
              `'most_common_freqs', string_to_array($${index++}, ',')::real[]`
            );
            args.push(column.stats.most_common_freqs);
          }
          if (column.stats.histogram_bounds != undefined) {
            columns.push(
              `'histogram_bounds', string_to_array($${index++}, ',')::text`
            );
            args.push(column.stats.histogram_bounds);
          }
          if (column.stats.correlation != undefined) {
            columns.push(`'correlation', '${column.stats.correlation}'::real`);
          }
          if (column.stats.most_common_elems != undefined) {
            columns.push(
              `'most_common_elems', string_to_array($${index++}, ',')::text`
            );
            args.push(column.stats.most_common_elems);
          }
          if (column.stats.most_common_elem_freqs != undefined) {
            columns.push(
              `'most_common_elem_freqs', string_to_array($${index++}, ',')::real`
            );
            args.push(column.stats.most_common_elem_freqs);
          }
          if (column.stats.elem_count_histogram != undefined) {
            columns.push(
              `'elem_count_histogram', string_to_array($${index++}, ',')::text`
            );
            args.push(column.stats.elem_count_histogram);
          }
          if (column.stats.range_length_histogram != undefined) {
            columns.push(`'range_length_histogram', $${index++}::real[]`);
            args.push(column.stats.range_length_histogram);
          }
          if (column.stats.range_empty_frac != undefined) {
            columns.push(`'range_empty_frac', $${index++}::real[]`);
            args.push(column.stats.range_empty_frac);
          }
          const sql = dedent`
          SELECT * FROM pg_catalog.pg_restore_attribute_stats(
            'version', '180000'::integer,
            'schemaname', '${table.schemaName}',
            'relname', '${table.tableName}',
            'attname', '${column.columnName}'${columns.length > 0 ? "," : ""}
            ${columns
              .map((c, i) => `${c}${i < columns.length - 1 ? "," : ""}`)
              .join("\n            ")}
          ); -- @qd_introspection\n
        `;
          console.log(sql);
          await query.unsafe(sql, args as any);
        }
      }
      // throw new Error("Not implemented");
    });
    // console.log(args);
    // return this.sql.unsafe(sql);
  }

  async dumpStats() {
    return this.sql<TableMetadata[]>`
SELECT
    c.table_name as "tableName",
    c.table_schema as "schemaName",
    cl.reltuples,
    cl.relpages,
    cl.relallvisible,
    -- cl.relallfrozen,
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
            'schemaname', s.schemaname,
            'relname', s.tablename,
            'attname', s.attname,
            'inherited', s.inherited,
            'null_frac', s.null_frac,
            'avg_width', s.avg_width,
            'n_distinct', s.n_distinct,
            'most_common_vals', s.most_common_vals,
            'most_common_freqs', s.most_common_freqs,
            'histogram_bounds', s.histogram_bounds,
            'correlation', s.correlation,
            'most_common_elems', s.most_common_elems,
            'most_common_elem_freqs', s.most_common_elem_freqs,
            'elem_count_histogram', s.elem_count_histogram
            -- 'range_length_histogram', s.range_length_histogram,
            -- 'range_empty_frac', s.range_empty_frac,
            -- 'range_bounds_histogram', s.range_bounds_histogram
          )
            from pg_stats s
          where
            s.tablename = c.table_name
            and s.attname = c.column_name
        )
      )
    ORDER BY c.ordinal_position) as columns
FROM
    information_schema.columns c
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
    c.table_name, c.table_schema, cl.reltuples, cl.relpages, cl.relallvisible, n.nspname; -- @qd_introspection
`;
  }
}

export type ColumnMetadata = {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  stats: ColumnStats | null;
};

type ColumnStats = {
  schemaname: string;
  relname: string;
  attname: string;
  inherited?: boolean;
  null_frac?: number;
  avg_width?: number;
  n_distinct?: number;
  most_common_vals?: unknown[] | null;
  most_common_freqs?: unknown[] | null;
  histogram_bounds?: unknown[] | null;
  correlation?: number;
  most_common_elems?: unknown[] | null;
  most_common_elem_freqs?: unknown[] | null;
  elem_count_histogram?: unknown[] | null;
  // available after pg 17
  range_length_histogram?: unknown[] | null;
  range_empty_frac?: number;
  range_bounds_histogram?: unknown[] | null;
};

export type TableMetadata = {
  tableName: string;
  schemaName: string;
  reltuples: number;
  relpages: number;
  relallvisible: number;
  relallfrozen: number;
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
