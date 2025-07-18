import { assertEquals, assertFalse } from "@std/assert";
import { Analyzer } from "./analyzer.ts";
import dedent from "dedent";

Deno.test(async function analyzer_test() {
  const analyzer = new Analyzer();
  const query = dedent`
  select
    "public"."team_user"."team_user_id",
    "public"."team_user"."team_id"
  from
    "public"."team_user"
  where
    (
      1 = 1
      and "public"."team_user"."team_id" in ($1)
    )
  offset
    $2`;
  const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
    query,
  );
  assertEquals(indexesToCheck, [
    {
      frequency: 1,
      representation: '"public"."team_user"."team_id"',
      parts: [
        { quoted: true, start: 135, text: "public" },
        { quoted: true, start: 144, text: "team_user" },
        { quoted: true, start: 156, text: "team_id" },
      ],
      ignored: false,
      position: { start: 135, end: 165 },
    },
  ]);
});

Deno.test(async function analyzer_test_with_ordering() {
  const analyzer = new Analyzer();
  const query = dedent`
  select
    "public"."team"."team_id"
  from
    "public"."team"
  order by
    team.team_id desc nulls first
  `;
  const { indexesToCheck } = await analyzer.analyze(
    query,
  );
  assertEquals(indexesToCheck, [{
    frequency: 1,
    representation: "team.team_id",
    parts: [
      { quoted: false, start: 42, text: "team" },
      { quoted: false, start: 74, text: "team_id" },
    ],
    ignored: false,
    position: { start: 69, end: 81 },
    sort: {
      dir: "SORTBY_DESC",
      nulls: "SORTBY_NULLS_FIRST",
    },
  }]);
});

Deno.test(async function analyzer_isnull() {
  const analyzer = new Analyzer();
  const query = dedent`
    select * from team
    where team.deleted_at is null
  `;
  const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
    query,
  );
  assertEquals(indexesToCheck, [
    {
      frequency: 1,
      representation: "team.deleted_at",
      parts: [
        { text: "team", start: 14, quoted: false },
        { text: "deleted_at", start: 30, quoted: false },
      ],
      ignored: false,
      position: { start: 25, end: 40 },
      where: { nulltest: "IS_NULL" },
    },
  ]);
});

Deno.test(async function analyzer_test() {
  const analyzer = new Analyzer();
  const query = dedent`
  select
    COUNT(*) as "_count._all"
  from
    (
      select
        "public"."team"."team_id"
      from
        "public"."team"
      where
        (
          "public"."team"."deleted_at" is null
          and exists (
            select
              "t0"."team_id"
            from
              "public"."team_user" as "t0"
            where
              (
                "t0"."user_id" = $1
                and ("public"."team"."team_id") = ("t0"."team_id")
                and "t0"."team_id" is not null
              )
          )
        )
      offset
        $2
    ) as "sub"`;
  const { indexesToCheck } = await analyzer.analyze(query);
  assertEquals(indexesToCheck, [
    {
      frequency: 1,
      representation: '"t0"."team_id"',
      parts: [
        { text: "team_user", start: 273, quoted: true, alias: "t0" },
        { text: "team_id", start: 454, quoted: true },
      ],
      ignored: false,
      position: { start: 449, end: 463 },
      where: {
        nulltest: "IS_NOT_NULL",
      },
    },
    {
      frequency: 1,
      representation: '"public"."team"."team_id"',
      parts: [
        { text: "public", start: 385, quoted: true },
        { text: "team", start: 394, quoted: true },
        { text: "team_id", start: 401, quoted: true },
      ],
      ignored: false,
      position: { start: 385, end: 410 },
    },
    {
      frequency: 1,
      representation: '"t0"."user_id"',
      parts: [
        { text: "team_user", start: 273, quoted: true, alias: "t0" },
        { text: "user_id", start: 351, quoted: true },
      ],
      ignored: false,
      position: { start: 346, end: 360 },
    },
    {
      frequency: 1,
      representation: '"public"."team"."deleted_at"',
      parts: [
        { text: "public", start: 144, quoted: true },
        { text: "team", start: 153, quoted: true },
        { text: "deleted_at", start: 160, quoted: true },
      ],
      ignored: false,
      position: { start: 144, end: 172 },
      where: {
        nulltest: "IS_NULL",
      },
    },
  ]);

  const indexes = analyzer.deriveIndexes(testMetadata, indexesToCheck);
  assertEquals(indexes, [
    {
      schema: "public",
      table: "team_user",
      column: "team_id",
      where: {
        nulltest: "IS_NOT_NULL",
      },
    },
    { schema: "public", table: "team", column: "team_id" },
    { schema: "public", table: "team_user", column: "user_id" },
    {
      schema: "public",
      table: "team",
      column: "deleted_at",
      where: {
        nulltest: "IS_NULL",
      },
    },
  ]);
});

const testMetadata = JSON.parse(Deno.readTextFileSync("test/umami_test.json"));

Deno.test(async function analyzer_with_aliases() {
  const analyzer = new Analyzer();
  const query = dedent`
  select
    "public"."team_user"."team_user_id",
    "public"."team_user"."team_id",
    "public"."team_user"."user_id",
    "public"."team_user"."role",
    "public"."team_user"."created_at",
    "public"."team_user"."updated_at"
  from
    "public"."team_user"
    left join "public"."user" as "j0" on ("j0"."user_id") = ("public"."team_user"."user_id")
  where
    (
      "public"."team_user"."team_id" = $1
      and (
        "j0"."deleted_at" is null
        and ("j0"."user_id" is not null)
      )
    )
  order by
    "public"."team_user"."team_user_id" asc
  limit
    $2
  offset
    $3
  `;
  const { indexesToCheck } = await analyzer.analyze(query);
  const indexes = analyzer.deriveIndexes(testMetadata, indexesToCheck);
  assertEquals(indexes, [
    {
      schema: "public",
      table: "team_user",
      column: "team_user_id",
      sort: {
        dir: "SORTBY_ASC",
        nulls: "SORTBY_NULLS_DEFAULT",
      },
    },
    {
      schema: "public",
      table: "user",
      column: "user_id",
      where: {
        nulltest: "IS_NOT_NULL",
      },
    },
    {
      schema: "public",
      table: "user",
      column: "deleted_at",
      where: {
        nulltest: "IS_NULL",
      },
    },
    { schema: "public", table: "team_user", column: "team_id" },
    { schema: "public", table: "team_user", column: "user_id" },
  ]);
});

Deno.test(async function analyzer_does_not_pickup_aggregate_aliases() {
  const analyzer = new Analyzer();
  const query = dedent`
    select
      "public"."team"."team_id",
      "public"."team"."name",
      "public"."team"."access_code",
      "public"."team"."logo_url",
      "public"."team"."created_at",
      "public"."team"."updated_at",
      "public"."team"."deleted_at",
      COALESCE(
        "aggr_selection_0_Website"."_aggr_count_website",
        0
      ) as "_aggr_count_website",
      COALESCE(
        "aggr_selection_1_TeamUser"."_aggr_count_teamUser",
        0
      ) as "_aggr_count_teamUser"
    from
      "public"."team"
      left join (
        select
          "public"."website"."team_id",
          COUNT(*) as "_aggr_count_website"
        from
          "public"."website"
        where
          "public"."website"."deleted_at" is null
        group by
          "public"."website"."team_id"
      ) as "aggr_selection_0_Website" on (
        "public"."team"."team_id" = "aggr_selection_0_Website"."team_id"
      )
      left join (
        select
          "public"."team_user"."team_id",
          COUNT(*) as "_aggr_count_teamUser"
        from
          "public"."team_user"
          left join "public"."user" as "j0" on ("j0"."user_id") = ("public"."team_user"."user_id")
        where
          (
            "j0"."deleted_at" is null
            and ("j0"."user_id" is not null)
          )
        group by
          "public"."team_user"."team_id"
      ) as "aggr_selection_1_TeamUser" on (
        "public"."team"."team_id" = "aggr_selection_1_TeamUser"."team_id"
      )
    where
      (
        "public"."team"."deleted_at" is null
        and exists (
          select
            "t1"."team_id"
          from
            "public"."team_user" as "t1"
          where
            (
              "t1"."user_id" = $1
              and ("public"."team"."team_id") = ("t1"."team_id")
              and "t1"."team_id" is not null
            )
        )
      )
    order by
      "public"."team"."team_id" asc
    limit
      $2
    offset
      $3`;
  const { indexesToCheck, ansiHighlightedQuery } = await analyzer.analyze(
    query,
  );
  assertFalse(
    indexesToCheck.some((i) =>
      /aggr_selection_0_Website/.test(i.representation)
    ),
  );
  assertFalse(
    indexesToCheck.some((i) =>
      /aggr_selection_1_TeamUser/.test(i.representation)
    ),
  );
});

Deno.test(async function sqlcommenter_test() {
  const analyzer = new Analyzer();
  const query = dedent`
    SELECT * FROM FOO /*action='%2Fparam*d',controller='index',framework='spring',
    traceparent='00-5bd66ef5095369c7b0d1f8f4bd33716a-c532cb4098ac3dd2-01',
    tracestate='congo%3Dt61rcWkgMzE%2Crojo%3D00f067aa0ba902b7'*/
  `;

  const { tags } = await analyzer.analyze(query);
  assertEquals(tags, [
    { key: "action", value: "/param*d" },
    { key: "controller", value: "index" },
    { key: "framework", value: "spring" },
    {
      key: "traceparent",
      value: "00-5bd66ef5095369c7b0d1f8f4bd33716a-c532cb4098ac3dd2-01",
    },
    { key: "tracestate", value: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7" },
  ]);
});
