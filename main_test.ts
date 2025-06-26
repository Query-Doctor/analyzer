import { assertEquals } from "@std/assert";
import { Analyzer, DatabaseDriver } from "./analyzer.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.7/mod.js";
import { Introspector } from "./introspect.ts";
import { IndexOptimizer } from "./optimizer/genalgo.ts";

Deno.test.only(async function real() {
  const sql = postgres("postgres://localhost:5432/hatira_dev");
  const introspector = new Introspector(sql);
  const analyzer = new Analyzer();
  const optimizer = new IndexOptimizer(sql);
  const query = await Deno.readTextFile("./test/query-real.sql");
  const params = [10, "01JKCVP4M2CH34SVTQGHSW4Y5G", 20];
  const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
    query,
    params
  );
  // console.log(ansiHighlightedQuery);
  const tables = await introspector.introspect();
  const indexes = analyzer.deriveIndexes(tables, indexesToCheck);
  console.log(indexes);
  await optimizer.run(query, params, indexes, tables);
});

Deno.test(async function analyzer() {
  const analyzer = new Analyzer();
  const query1 = `select "hi" from employees where employees."managerId" = 1`;
  const { indexesToCheck } = await analyzer.analyze(query1, []);
  assertEquals(indexesToCheck, [
    {
      frequency: 0,
      representation: 'employees."managerId"',
      parts: [
        { text: "employees", start: 33, quoted: false },
        { text: "managerId", start: 43, quoted: true },
      ],
      ignored: false,
      position: { start: 33, end: 54 },
    },
  ]);
  // const out = await analyzer.deriveIndexes(
  //   new Introspector(postgres("postgres://localhost:5432/hatira_dev")),
  //   indexesToCheck
  // );
});

Deno.test(async function analyzerNoPrefix() {
  const analyzer = new Analyzer();
  const query1 = `select "hi" from employees where "managerId" = 1 union select "hi" from employees2 where managerId = 2`;
  const { indexesToCheck } = await analyzer.analyze(query1, []);
  const out = analyzer.deriveIndexes(
    [
      {
        table_name: "employees",
        reltuples: 0,
        columns: [
          {
            column_name: "managerId",
            table_name: "employees",
            data_type: "integer",
            is_nullable: false,
          },
        ],
      },
      {
        table_name: "employees2",
        reltuples: 0,
        columns: [
          {
            column_name: "managerid",
            table_name: "employees2",
            data_type: "integer",
            is_nullable: false,
          },
        ],
      },
    ],
    indexesToCheck
  );
  assertEquals(out, [
    {
      table: "employees2",
      column: "managerid",
    },
    {
      table: "employees",
      column: "managerId",
    },
  ]);
  console.log(out);
});

Deno.test(async function analyzer() {
  const analyzer = new Analyzer();
  const query1 = await Deno.readTextFile("./test/query-1.sql");
  const { ansiHighlightedQuery, indexesToCheck } = await analyzer.analyze(
    query1,
    []
  );
  // printLegend();
  // console.log(ansiHighlightedQuery);
  // console.log(indexesToCheck);
  // console.log(indexesToCheck);
  // assertEquals(
  //   indexesToCheck,
  //   new Set([
  //     ["avg_salary"],
  //     ["audits", "result"],
  //     ["audits", "department_id"],
  //     ["employees", "department_id"],
  //     ["projects", "department_id"],
  //     ["projects", "status"],
  //     ["projects", "budget"],
  //     ["departments", "name"],
  //     ["departments", "id"],
  //     ["employees", "id"],
  //     ["employees", "manager_id"],
  //     ["employees", "name"],
  //     ["manager_id"],
  //   ])
  // );
});
Deno.test(async function analyzer2() {
  const analyzer = new Analyzer();
  const query2 = await Deno.readTextFile("./test/query-2.sql");
  const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
    query2,
    []
  );
  // console.log(ansiHighlightedQuery);
  // console.log(indexesToCheck);
  // assertEquals(
  //   indexesToCheck,
  //   new Set([
  //     ["avg_salary"],
  //     ["audits", "result"],
  //     ["audits", "department_id"],
  //     ["employees", "department_id"],
  //     ["projects", "department_id"],
  //     ["projects", "status"],
  //     ["projects", "budget"],
  //     ["departments", "name"],
  //     ["departments", "id"],
  //     ["employees", "id"],
  //     ["employees", "manager_id"],
  //     ["employees", "name"],
  //     ["manager_id"],
  //   ])
  // );
});

Deno.test(async function analyzer() {
  //
});

function printLegend() {
  console.log(`--Legend--------------------------`);
  console.log(`| \x1b[48;5;205m column \x1b[0m | Candidate            |`);
  console.log(`| \x1b[33m column \x1b[0m | Ignored              |`);
  console.log(`| \x1b[34m column \x1b[0m | Temp table reference |`);
  console.log(`-----------------------------------`);
  console.log();
}
