WITH all_indexes AS (
  SELECT
    jsonb_strip_nulls(
      jsonb_build_object(
        'type', 'index',
        'oid', i.oid::integer,
        'schemaName', quote_ident(n.nspname),
        'tableName', quote_ident(t.relname),
        'indexName', quote_ident(i.relname),
        'indexType', am.amname,
        'isUnique', ix.indisunique,
        'isPrimary', ix.indisprimary,
        'isClustered', ix.indisclustered,
        'wherePredicate', pg_get_expr(ix.indpred, t.oid),
        'tablespace', ts.spcname,
        'keyColumns', (
          SELECT
            jsonb_agg(
              jsonb_strip_nulls(jsonb_build_object(
                'type', 'indexColumn',
                'name',
                  pg_get_indexdef(i.oid, k.ordinality, true),
                'order',
                  -- bit 1 = DESC
                  CASE WHEN (ix.indoption[k.ordinality - 1] & 1) = 1 THEN 'DESC' ELSE 'ASC' END,
                'nulls',
                  -- bit 2 = NULLS FIRST, bit 4 = NULLS LAST
                  CASE
                    WHEN (ix.indoption[k.ordinality - 1] & 2) = 2 THEN 'FIRST'
                    WHEN (ix.indoption[k.ordinality - 1] & 4) = 4 THEN 'LAST'
                    ELSE NULL -- Default
                  END,
                'opclass',
                   (SELECT opcname FROM pg_opclass WHERE oid = ix.indclass[k.ordinality - 1]),
                'collation',
                  -- Only show collation if it's not the default
                  (SELECT collname FROM pg_collation WHERE oid = ix.indcollation[k.ordinality - 1] AND collname <> 'default')
              ))
              ORDER BY k.ordinality
            )
          FROM
            generate_series(1, ix.indnkeyatts) AS k(ordinality)
        ),

        -- Included columns (Postgres 11+)
        'includedColumns', (
          -- Only build this object if there are included columns
          CASE WHEN ix.indnatts = ix.indnkeyatts THEN NULL
          ELSE (
            SELECT
              jsonb_agg(
                jsonb_build_object(
                  'type', 'indexColumnIncluded',
                  'name', pg_get_indexdef(i.oid, k.ordinality, true)
                )
                ORDER BY k.ordinality
              )
            FROM
              -- Iterate from (key_cols + 1) to (total_cols)
              generate_series(ix.indnkeyatts + 1, ix.indnatts) AS k(ordinality)
          )
          END
        )
      )
    ) AS index_metadata
  FROM
    pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_am am ON i.relam = am.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    LEFT JOIN pg_tablespace ts ON i.reltablespace = ts.oid
  WHERE
    n.nspname not like 'pg_%' AND
    -- Filter out timescaledb system catalogs
    n.nspname not like '_timescaledb_%' AND
    t.relispartition = false  -- Only list indexes on parent/non-partitioned tables
  ORDER BY
    n.nspname, t.relname, i.relname
),
all_tables as (
SELECT
  jsonb_strip_nulls(
    jsonb_build_object(
      'type', 'table',
      'oid', c.oid::integer,
      'schemaName', quote_ident(n.nspname),
      'tableName', quote_ident(c.relname),
      'tablespace', quote_ident(ts.spcname),
      'partitionKeyDef', pg_get_partkeydef(c.oid), -- NULL if not a partitioned table
      'columns', (
        SELECT
          jsonb_agg(
            jsonb_strip_nulls(
              jsonb_build_object(
                'type', 'column',
                'name', quote_ident(a.attname),
                'order', a.attnum,
                'columnType', format_type(a.atttypid, a.atttypmod),
                'isNullable', NOT a.attnotnull,
                'defaultValue', pg_get_expr(ad.adbin, c.oid),
                'dropped', a.attisdropped,
                'collation', (
                  SELECT quote_ident(coll.collname)
                  FROM pg_collation coll
                  WHERE a.attcollation = coll.oid AND coll.collname <> 'default'
                ),
                'storage',
                  CASE a.attstorage
                    WHEN 'p' THEN 'plain'
                    WHEN 'm' THEN 'main'
                    WHEN 'e' THEN 'external'
                    WHEN 'x' THEN 'extended'
                  END,
                'isIdentity',
                  CASE a.attidentity
                    WHEN 'a' THEN 'always'
                    WHEN 'd' THEN 'by default'
                  END
              )
            )
            ORDER BY a.attnum
          )
        FROM
          pg_attribute a
          LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE
          a.attrelid = c.oid
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
    )
  ) AS table_metadata
FROM
  pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_tablespace ts ON c.reltablespace = ts.oid
WHERE
  n.nspname not like 'pg_%'
  AND n.nspname <> 'information_schema'
  AND c.relkind in ('r', 'm')
  AND c.relispartition = false
ORDER BY
  n.nspname, c.relname
),
all_constraints as (
SELECT
  jsonb_strip_nulls(
    jsonb_build_object(
      'type', 'constraint',
      'oid', con.oid::integer,
      'schemaName', quote_ident(n.nspname),
      'tableName', quote_ident(c.relname),
      'constraintName', quote_ident(con.conname),
      'constraintType',
        CASE con.contype
          WHEN 'c' THEN 'check'
          WHEN 'f' THEN 'foreign_key'
          WHEN 'n' THEN 'not_null'
          WHEN 'p' THEN 'primary_key'
          WHEN 'u' THEN 'unique'
          WHEN 't' THEN 'trigger'
          WHEN 'x' THEN 'exclusion'
          ELSE con.contype
        END,

      -- pg_get_constraintdef is the easiest way to get the full definition
      'definition', pg_get_constraintdef(con.oid),
      -- nullable
      'isDeferrable', con.condeferrable,
      -- nullable
      'isInitiallyDeferred', con.condeferred,
      -- nullable
      'isValidated', con.convalidated,
      -- The OID of the index that enforces a PK, UNIQUE, or EXCLUSION constraint
      -- nullable
      'backingIndexOid',
        CASE
          WHEN con.conindid = 0 THEN NULL
          ELSE con.conindid::integer
        END
    )
  ) AS constraint_metadata
FROM
  pg_constraint con
  -- Join to table
  JOIN pg_class c ON con.conrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE
  n.nspname not like 'pg_%'        -- Or your target schema
  and n.nspname <> 'information_schema'
  AND con.conrelid <> 0         -- Only constraints on relations (tables), not types/domains
  AND c.relispartition = false  -- Exclude constraints on child partitions
ORDER BY
  n.nspname, c.relname, con.conname
),
all_functions as (
  SELECT
    jsonb_build_object(
      'type', 'function',
      'schemaName', quote_ident(n.nspname),
      'objectName', quote_ident(pro.proname),
      'objectType',
        CASE pro.prokind
          WHEN 'f' THEN 'function'
          WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate'
          WHEN 'w' THEN 'window function'
        END,

      -- Clean, human-readable argument list (e.g., "(arg1 integer, arg2 text)")
      'identityArguments', pg_get_function_identity_arguments(pro.oid),

      -- This function generates the full "CREATE OR REPLACE..." DDL.
      'definition', pg_get_functiondef(pro.oid)

    ) AS function_metadata
  FROM
    pg_proc pro
    JOIN pg_namespace n ON pro.pronamespace = n.oid
    -- Dependency check to filter out objects created by extensions
    LEFT JOIN pg_depend d ON d.objid = pro.oid AND d.deptype = 'e'
  WHERE
    n.nspname not like 'pg_%'
    AND n.nspname <> 'information_schema'
    AND d.objid IS NULL
    -- Exclude bit_xor aggregate as pg_get_functiondef doesn't work on it
    AND NOT (pro.proname = 'bit_xor' AND pro.prokind = 'a')
  ORDER BY
    n.nspname, pro.proname, pg_get_function_identity_arguments(pro.oid)
),
all_extensions as (
  SELECT
    jsonb_build_object(
      'type', 'extension',
      'extensionName', ext.extname,
      'version', ext.extversion,
      'schemaName', quote_ident(n.nspname)
    ) AS extension_metadata
  FROM
    pg_extension ext
    JOIN pg_namespace n ON ext.extnamespace = n.oid
  WHERE
    n.nspname not like 'pg_%'
    AND n.nspname <> 'information_schema'
  ORDER BY
    ext.extname
),
all_views as (
  SELECT
    jsonb_strip_nulls(
      jsonb_build_object(
        'type', 'view',
        'schemaName', quote_ident(n.nspname),
        'viewName', quote_ident(c.relname),
        'objectType',
          CASE c.relkind
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materialized_view'
          END,
        'definition', pg_get_viewdef(c.oid),
        'tablespace', ts.spcname
      )
    ) AS view_metadata
  FROM
    pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    LEFT JOIN pg_tablespace ts ON c.reltablespace = ts.oid
  WHERE
    n.nspname not like 'pg_%'
    AND n.nspname <> 'information_schema'
    AND n.nspname <> 'timescaledb_information'
    AND n.nspname not like '_timescaledb_%'
    AND c.relkind IN ('v' /* views */, 'm' /* materialized views */)
  ORDER BY
    n.nspname, c.relname
),
all_types as (
  SELECT
    jsonb_strip_nulls(
      jsonb_build_object(
        'type', 'type',
        'schemaName', quote_ident(n.nspname),
        'typeName', quote_ident(t.typname),
        'typeCategory',
          CASE t.typtype
            WHEN 'e' THEN 'enum'
            WHEN 'd' THEN 'domain'
            WHEN 'c' THEN 'composite'
          END,

        'enumLabels', (
          CASE WHEN t.typtype = 'e' THEN (
            SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
            FROM pg_enum e
            WHERE e.enumtypid = t.oid
          ) ELSE NULL END
        ),

        -- DOMAIN specific: Base type, nullability, default, and constraints
        'domainBaseType', (
          CASE WHEN t.typtype = 'd' THEN
            format_type(t.typbasetype, t.typtypmod)
          ELSE NULL END
        ),
        'domainIsNotNull', (
          CASE WHEN t.typtype = 'd' THEN
            t.typnotnull
          ELSE NULL END
        ),
        'domainDefault', (
          CASE WHEN t.typtype = 'd' THEN
            t.typdefault
          ELSE NULL END
        ),
        'domainConstraints', (
          CASE WHEN t.typtype = 'd' THEN (
            SELECT jsonb_agg(
              jsonb_build_object(
                'name', quote_ident(con.conname),
                'definition', pg_get_constraintdef(con.oid)
              )
              ORDER BY con.conname
            )
            FROM pg_constraint con
            WHERE con.contypid = t.oid
          ) ELSE NULL END
        ),
        'compositeAttributes', (
          CASE WHEN t.typtype = 'c' THEN (
            SELECT jsonb_agg(
              jsonb_strip_nulls(jsonb_build_object(
                'type', 'compositeAttribute',
                'name', quote_ident(a.attname),
                'attributeType', format_type(a.atttypid, a.atttypmod),
                'collation', (
                    SELECT coll.collname
                    FROM pg_collation coll
                    WHERE a.attcollation = coll.oid AND coll.collname <> 'default'
                  )
              ))
              ORDER BY a.attnum
            )
            FROM pg_attribute a
            WHERE a.attrelid = t.typrelid
              AND a.attnum > 0
              AND NOT a.attisdropped
          ) ELSE NULL END
        )
      )
    ) AS type_metadata
  FROM
    pg_type t
    JOIN pg_namespace n ON t.typnamespace = n.oid
    LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
  WHERE
    n.nspname not like 'pg_%'
    AND n.nspname <> 'information_schema'
    AND t.typtype IN ('e', 'd', 'c')
    AND d.objid IS NULL
    AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) not in ('r', 'v', 'w'))
  ORDER BY
    n.nspname, t.typname
),
all_triggers as (
  SELECT
    jsonb_strip_nulls(
      jsonb_build_object(
        'type', 'trigger',
        'schemaName', quote_ident(n.nspname),
        'tableName', quote_ident(c.relname),
        'triggerName', quote_ident(t.tgname),
        'definition', pg_get_triggerdef(t.oid),
        -- 'O' = ONCE, 'A' = ALWAYS, 'R' = REPLICA, 'D' = DISABLED
        'enabledMode', t.tgenabled
      )
    ) AS trigger_metadata
  FROM
    pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    -- Dependency check to filter out triggers created by extensions
    LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
  WHERE
    n.nspname not like 'pg_%'
    AND n.nspname <> 'information_schema'
     -- Exclude internal/system-generated triggers
    AND t.tgisinternal = false
    AND d.objid IS NULL
    AND c.relispartition = false
  ORDER BY
    n.nspname, c.relname, t.tgname
)
SELECT
jsonb_strip_nulls(
  jsonb_build_object(
    'indexes', (select jsonb_agg(all_indexes.index_metadata) from all_indexes),
    'tables', (select jsonb_agg(all_tables.table_metadata) from all_tables),
    'constraints', (select jsonb_agg(all_constraints.constraint_metadata) from all_constraints),
    'functions', (select jsonb_agg(all_functions.function_metadata) from all_functions),
    'extensions', (select jsonb_agg(all_extensions.extension_metadata) from all_extensions),
    'views', (select jsonb_agg(all_views.view_metadata) from all_views),
    'types', (select jsonb_agg(all_types.type_metadata) from all_types),
    'triggers', (select jsonb_agg(all_triggers.trigger_metadata) from all_triggers)
  )
) as result; -- @qd_introspection
