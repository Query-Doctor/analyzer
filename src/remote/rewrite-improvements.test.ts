import { expect, test } from "vitest";
import { assert, assertDefined } from "./test-utils.ts";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { QueryOptimizer } from "./query-optimizer.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Connectable } from "../sync/connectable.ts";
import {
  type OptimizedQuery,
  QueryHash,
  RecentQuery,
} from "../sql/recent-query.ts";

/**
 * A correlated `EXISTS` that aggregates per outer row. `item_modifiers` already
 * carries the only index the access path can use, so the index search comes back
 * empty and the query settles on `no_improvement_found` — the state that used to
 * end the analyzer's answer.
 */
const AGGREGATE_EXISTS_QUERY =
  "select count(*) from items where exists (select 1 from item_modifiers im " +
  "where im.item_id = items.id and im.stat = $1 having sum(im.value) >= $2);";

/**
 * Real rows, because stock Postgres sizes a relation from its own page count and
 * would price an empty fixture at nothing whatever statistics say.
 */
const SCHEMA = `
  create table items (id int primary key);
  create table item_modifiers (item_id int not null, stat text not null, value int not null);
  create index item_modifiers_item_id_stat_idx on item_modifiers (item_id, stat);

  insert into items (id) select g from generate_series(1, 3000) g;
  insert into item_modifiers (item_id, stat, value)
  select 1 + (g % 3000), (array['str','dex','vit'])[1 + (g % 3)], g % 40
  from generate_series(1, 9000) g;
  vacuum analyze;
`;

/** Through `analyze`, so the query costed is the one the pipeline would cost. */
function recentQuery(query: string): Promise<RecentQuery> {
  return RecentQuery.analyze(
    {
      calls: "1",
      formattedQuery: query,
      meanTime: 100,
      query,
      rows: "1",
      topLevel: true,
      username: "test",
    },
    QueryHash.parse("aggregate-exists"),
    QueryHash.parse("aggregate-exists"),
  );
}

test("a query no index can fix still carries the rewrite that can", async () => {
  const pg = await new PostgreSqlContainer("postgres:17")
    .withCopyContentToContainer([
      { content: SCHEMA, target: "/docker-entrypoint-initdb.d/init.sql" },
    ])
    .withCommand(["-c", "autovacuum=off"])
    .start();

  const manager = ConnectionManager.forLocalDatabase();
  const conn = Connectable.fromString(pg.getConnectionUri());
  const optimizer = new QueryOptimizer(manager, conn);

  const settled: OptimizedQuery[] = [];
  optimizer.addListener("noImprovements", (query) => settled.push(query));
  optimizer.addListener("improvementsAvailable", (query) => settled.push(query));
  optimizer.addListener("error", (query, error) => {
    console.error("error when running query", query);
    throw error;
  });

  try {
    await optimizer.start([], {
      kind: "fromStatisticsExport",
      source: { kind: "inline" },
      stats: [
        {
          tableName: "items",
          schemaName: "public",
          relpages: 14,
          reltuples: 3_000,
          relallvisible: 14,
          columns: [{ columnName: "id", stats: null, attlen: 4 }],
          indexes: [],
        },
        {
          tableName: "item_modifiers",
          schemaName: "public",
          relpages: 49,
          reltuples: 9_000,
          relallvisible: 49,
          columns: [
            { columnName: "item_id", stats: null, attlen: 4 },
            { columnName: "stat", stats: null, attlen: -1 },
            { columnName: "value", stats: null, attlen: 4 },
          ],
          indexes: [{
            indexName: "item_modifiers_item_id_stat_idx",
            relpages: 27,
            reltuples: 9_000,
            relallvisible: 27,
            amname: "btree",
            columns: [{ attlen: 4 }, { attlen: -1 }],
            fillfactor: 0.9,
          }],
        },
      ],
    });
    await optimizer.addQueries([await recentQuery(AGGREGATE_EXISTS_QUERY)]);

    expect(settled).toHaveLength(1);
    const { optimization } = settled[0];
    assert(optimization.state === "no_improvement_found");

    const [improvement] = optimization.improvements ?? [];
    assertDefined(improvement);
    assert(improvement.action.kind === "rewrite");
    expect(improvement.action.rule).toBe("HOIST_CORRELATED_EXISTS");
    // The saving is the reason the state is worth contradicting. Core owns what
    // the rewrite says; this owns that a settled query carries it at all.
    expect(improvement.costReductionPercentage).toBeGreaterThan(90);
  } finally {
    optimizer.stop();
    await pg.stop();
  }
}, 180_000);
