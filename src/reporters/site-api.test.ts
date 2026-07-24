import { gunzipSync } from "node:zlib";
import { test, expect, describe, afterEach, vi } from "vitest";
import {
  classifyIngestFailure,
  compareRuns,
  fetchPreviousRun,
  gateEligibleNewQueries,
  postToSiteApi,
  type CiQueryPayload,
  type PreviousRun,
} from "./site-api.ts";

function makeQuery(hash: string, cost: number = 100): CiQueryPayload {
  // Give each distinct hash a distinct table so the query text (and thus its
  // shape) is unique per hash — real queries can't share text without sharing a
  // hash. This keeps shape-matching (#3367) from conflating unrelated fixtures;
  // the changed-query tests below use explicitly same-shape queries.
  const table = `t_${hash.replace(/[^a-z0-9]/gi, "_")}`;
  return {
    hash,
    query: `SELECT * FROM ${table} WHERE id = $1`,
    formattedQuery: `SELECT *\nFROM ${table}\nWHERE id = $1`,
    optimization: {
      state: "no_improvement_found",
      cost,
      indexesUsed: [],
    },
    nudges: [],
    tags: [],
    tableReferences: [],
  };
}

function makePreviousRun(queries: CiQueryPayload[]): PreviousRun {
  return {
    id: "prev-run-1",
    repo: "test/repo",
    branch: "main",
    commitSha: "abc123",
    queries,
  };
}

describe("compareRuns", () => {
  describe("new query detection via previousRun", () => {
    test("when previousRun has no queries, all current queries are new", async () => {
      const queries = [makeQuery("hash-a"), makeQuery("hash-b")];
      const previousRun = makePreviousRun([]);

      const result = await compareRuns(queries, previousRun, 10);

      expect(result.newQueries).toHaveLength(2);
      expect(result.newQueries.map((q) => q.hash)).toEqual([
        "hash-a",
        "hash-b",
      ]);
      expect(result.regressed).toHaveLength(0);
      expect(result.improved).toHaveLength(0);
    });

    test("when previousRun contains hashes, only non-seen queries are new", async () => {
      const queries = [
        makeQuery("hash-a"),
        makeQuery("hash-b"),
        makeQuery("hash-c"),
      ];
      const previousRun = makePreviousRun([
        makeQuery("hash-a"),
        makeQuery("hash-c"),
      ]);

      const result = await compareRuns(queries, previousRun, 10);

      expect(result.newQueries).toHaveLength(1);
      expect(result.newQueries[0].hash).toBe("hash-b");
    });

    test("query in previousRun with increased cost is flagged as regression", async () => {
      const currentQueries = [makeQuery("hash-a", 500)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(currentQueries, previousRun, 10);

      expect(result.newQueries).toHaveLength(0);
      expect(result.regressed).toHaveLength(1);
      expect(result.regressed[0].hash).toBe("hash-a");
      expect(result.regressed[0].previousCost).toBe(100);
      expect(result.regressed[0].currentCost).toBe(500);
      expect(result.regressed[0].regressionPercentage).toBe(400);
    });
  });

  describe("regression threshold", () => {
    test("cost change within threshold is not flagged", async () => {
      const currentQueries = [makeQuery("hash-a", 115)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(currentQueries, previousRun, 20);

      expect(result.regressed).toHaveLength(0);
      expect(result.improved).toHaveLength(0);
      expect(result.newQueries).toHaveLength(0);
    });

    test("cost decrease beyond threshold is flagged as improved", async () => {
      const currentQueries = [makeQuery("hash-a", 30)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(currentQueries, previousRun, 10);

      expect(result.improved).toHaveLength(1);
      expect(result.improved[0].hash).toBe("hash-a");
      expect(result.improved[0].previousCost).toBe(100);
      expect(result.improved[0].currentCost).toBe(30);
    });

    test("acknowledged regression goes to acknowledgedRegressed, not regressed", async () => {
      const currentQueries = [makeQuery("hash-a", 500)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(
        currentQueries,
        previousRun,
        10,
        0,
        ["hash-a"],
      );

      expect(result.regressed).toHaveLength(0);
      expect(result.acknowledgedRegressed).toHaveLength(1);
      expect(result.acknowledgedRegressed[0].hash).toBe("hash-a");
    });
  });

  describe("minimumCost filtering", () => {
    test("regression where both costs are below minimumCost is skipped", async () => {
      const currentQueries = [makeQuery("hash-a", 8)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 2)]);

      const result = await compareRuns(currentQueries, previousRun, 10, 50);

      expect(result.regressed).toHaveLength(0);
    });

    test("regression where current cost exceeds minimumCost is reported", async () => {
      const currentQueries = [makeQuery("hash-a", 200)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 10)]);

      const result = await compareRuns(currentQueries, previousRun, 10, 50);

      expect(result.regressed).toHaveLength(1);
    });
  });

  describe("disappeared queries", () => {
    test("queries in previousRun but not in current are disappeared", async () => {
      const currentQueries = [makeQuery("hash-a")];
      const previousRun = makePreviousRun([
        makeQuery("hash-a"),
        makeQuery("hash-b"),
        makeQuery("hash-c"),
      ]);

      const result = await compareRuns(currentQueries, previousRun, 10);

      expect(result.disappearedHashes).toEqual(["hash-b", "hash-c"]);
    });
  });

  describe("mixed scenarios", () => {
    test("new, regressed, improved, and disappeared queries together", async () => {
      const currentQueries = [
        makeQuery("hash-a", 500), // regressed (was 100)
        makeQuery("hash-b", 30),  // improved (was 100)
        makeQuery("hash-c", 100), // unchanged
        makeQuery("hash-d", 200), // new
      ];
      const previousRun = makePreviousRun([
        makeQuery("hash-a", 100),
        makeQuery("hash-b", 100),
        makeQuery("hash-c", 100),
        makeQuery("hash-e", 100), // disappeared
      ]);

      const result = await compareRuns(currentQueries, previousRun, 10);

      expect(result.newQueries).toHaveLength(1);
      expect(result.newQueries[0].hash).toBe("hash-d");
      expect(result.regressed).toHaveLength(1);
      expect(result.regressed[0].hash).toBe("hash-a");
      expect(result.improved).toHaveLength(1);
      expect(result.improved[0].hash).toBe("hash-b");
      expect(result.disappearedHashes).toEqual(["hash-e"]);
    });
  });

  describe("test-origin exclusion (#3199)", () => {
    const fromTestFile = (q: CiQueryPayload): CiQueryPayload => ({
      ...q,
      tags: [{ key: "file", value: "tests/pg/postgres.test.ts" }],
    });

    test("a regressed test-origin query is bucketed out of the gate, not regressed", async () => {
      const current = [fromTestFile(makeQuery("hash-a", 500))];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.regressed).toHaveLength(0);
      expect(result.testOriginExcluded.map((q) => q.hash)).toEqual(["hash-a"]);
    });

    test("a new test-origin query never enters newQueries", async () => {
      const current = [fromTestFile(makeQuery("hash-new", 200))];
      const previousRun = makePreviousRun([]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.newQueries).toHaveLength(0);
      expect(result.testOriginExcluded.map((q) => q.hash)).toEqual(["hash-new"]);
    });

    test("production queries in the same run are unaffected", async () => {
      const current = [
        fromTestFile(makeQuery("hash-test", 500)), // was 100 → excluded
        makeQuery("hash-prod", 500),               // was 100 → regressed
      ];
      const previousRun = makePreviousRun([
        makeQuery("hash-test", 100),
        makeQuery("hash-prod", 100),
      ]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.regressed.map((q) => q.hash)).toEqual(["hash-prod"]);
      expect(result.testOriginExcluded.map((q) => q.hash)).toEqual(["hash-test"]);
    });

    test("an untagged query still gates exactly as before", async () => {
      const current = [makeQuery("hash-a", 500)];
      const previousRun = makePreviousRun([makeQuery("hash-a", 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.regressed).toHaveLength(1);
      expect(result.testOriginExcluded).toHaveLength(0);
    });

    // Real SQLCommenter `file` tags carry a `:line:col` suffix
    // (`…repository.spec.ts:509:10`). Before core stripped that suffix, the
    // `$`-anchored `.spec.ts` pattern never matched, so a test read-back leaked
    // into newQueries and phantom-blocked unrelated PRs run after run — the
    // server dropped it as test-origin while the analyzer did not (Site #3606).
    test("excludes a .spec.ts query whose file tag carries a :line:col suffix", async () => {
      const withSuffix: CiQueryPayload = {
        ...makeQuery("hash-new", 200),
        tags: [
          {
            key: "file",
            value:
              "/home/runner/work/Site/Site/apps/api/src/projects/project-queries.repository.spec.ts:509:10",
          },
        ],
      };
      const previousRun = makePreviousRun([]);

      const result = await compareRuns([withSuffix], previousRun, 10);

      expect(result.newQueries).toHaveLength(0);
      expect(result.testOriginExcluded.map((q) => q.hash)).toEqual(["hash-new"]);
    });
  });

  describe("changed-query detection via shape (#3367)", () => {
    // The real Nutcracker case: adding columns to a SELECT changes the hash but
    // not the query's shape.
    const BASE_SQL =
      "SELECT id, share_slug, user_id FROM design_renders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2";
    const WIDER_SQL =
      "SELECT id, share_slug, user_id, session_id, source_payload FROM design_renders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2";

    const q = (
      hash: string,
      sql: string,
      cost: number,
      file = "src/db/postgres.ts",
    ): CiQueryPayload => ({
      hash,
      query: sql,
      formattedQuery: sql,
      optimization: { state: "no_improvement_found", cost, indexesUsed: [] },
      nudges: [],
      tags: [{ key: "file", value: file }],
      tableReferences: [],
    });

    test("a column added to a SELECT reads as one changed query, not new + removed", async () => {
      const current = [q("hash-wide", WIDER_SQL, 100)];
      const previousRun = makePreviousRun([q("hash-base", BASE_SQL, 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.newQueries).toHaveLength(0);
      expect(result.disappearedHashes).toHaveLength(0);
    });

    test("a shape-matched query carries the cost delta against its previous self", async () => {
      const current = [q("hash-wide", WIDER_SQL, 500)];
      const previousRun = makePreviousRun([q("hash-base", BASE_SQL, 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.regressed).toHaveLength(1);
      expect(result.regressed[0]).toMatchObject({
        hash: "hash-wide",
        previousCost: 100,
        currentCost: 500,
      });
      expect(result.newQueries).toHaveLength(0);
      expect(result.disappearedHashes).toHaveLength(0);
    });

    test("the same shape from a different call site is not merged", async () => {
      const current = [q("hash-wide", WIDER_SQL, 100, "src/db/other.ts")];
      const previousRun = makePreviousRun([
        q("hash-base", BASE_SQL, 100, "src/db/postgres.ts"),
      ]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.newQueries.map((x) => x.hash)).toEqual(["hash-wide"]);
      expect(result.disappearedHashes).toEqual(["hash-base"]);
    });

    test("when the original query still runs, the widened variant is genuinely new", async () => {
      const current = [q("hash-base", BASE_SQL, 100), q("hash-wide", WIDER_SQL, 100)];
      const previousRun = makePreviousRun([q("hash-base", BASE_SQL, 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.newQueries.map((x) => x.hash)).toEqual(["hash-wide"]);
      expect(result.disappearedHashes).toHaveLength(0);
    });

    test("a genuinely different query is not shape-matched", async () => {
      const current = [
        q("hash-x", "SELECT id FROM widgets WHERE owner_id = $1", 100),
      ];
      const previousRun = makePreviousRun([q("hash-base", BASE_SQL, 100)]);

      const result = await compareRuns(current, previousRun, 10);

      expect(result.newQueries.map((x) => x.hash)).toEqual(["hash-x"]);
      expect(result.disappearedHashes).toEqual(["hash-base"]);
    });
  });
});

describe("postToSiteApi authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubOkFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "run-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function headersFrom(fetchMock: ReturnType<typeof vi.fn>): Headers {
    return new Headers(fetchMock.mock.calls[0]![1]!.headers);
  }

  test("sends the project token as a Bearer Authorization header", async () => {
    vi.stubEnv("TOKEN", "tok-abc123");
    const fetchMock = stubOkFetch();

    await postToSiteApi("https://api.querydoctor.com", [makeQuery("hash-a")]);

    expect(headersFrom(fetchMock).get("authorization")).toBe("Bearer tok-abc123");
  });

  test("omits the Authorization header when no token is set", async () => {
    vi.stubEnv("TOKEN", "");
    const fetchMock = stubOkFetch();

    await postToSiteApi("https://api.querydoctor.com", [makeQuery("hash-a")]);

    expect(headersFrom(fetchMock).has("authorization")).toBe(false);
  });

  test("gzips the request body and advertises Content-Encoding: gzip", async () => {
    const fetchMock = stubOkFetch();

    await postToSiteApi("https://api.querydoctor.com", [makeQuery("hash-a")]);

    expect(headersFrom(fetchMock).get("content-encoding")).toBe("gzip");
    const body = fetchMock.mock.calls[0]![1]!.body as Buffer;
    expect(JSON.parse(gunzipSync(body).toString("utf8")).repo).toBeDefined();
  });
});

describe("postToSiteApi payload baseBranch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubOkFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "run-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function bodyFrom(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const body = fetchMock.mock.calls[0]![1]!.body as Buffer;
    return JSON.parse(gunzipSync(body).toString("utf8"));
  }

  test("forwards GITHUB_BASE_REF as baseBranch on a PR run", async () => {
    vi.stubEnv("GITHUB_BASE_REF", "main");
    const fetchMock = stubOkFetch();

    await postToSiteApi("https://api.querydoctor.com", [makeQuery("hash-a")]);

    expect(bodyFrom(fetchMock).baseBranch).toBe("main");
  });

  test("omits baseBranch on a push run where GITHUB_BASE_REF is unset", async () => {
    vi.stubEnv("GITHUB_BASE_REF", "");
    const fetchMock = stubOkFetch();

    await postToSiteApi("https://api.querydoctor.com", [makeQuery("hash-a")]);

    expect(bodyFrom(fetchMock)).not.toHaveProperty("baseBranch");
  });
});

describe("classifyIngestFailure", () => {
  test("treats no-response and 5xx as transient (recoverable)", async () => {
    expect(classifyIngestFailure(null)).toBe("transient");
    expect(classifyIngestFailure(500)).toBe("transient");
    expect(classifyIngestFailure(503)).toBe("transient");
  });

  test("treats 401/403 as auth (user must fix the token)", async () => {
    expect(classifyIngestFailure(401)).toBe("auth");
    expect(classifyIngestFailure(403)).toBe("auth");
  });

  test("treats 413 as too_large (payload over the size limit)", async () => {
    expect(classifyIngestFailure(413)).toBe("too_large");
  });

  test("treats other 4xx as a rejected run (contract skew)", async () => {
    expect(classifyIngestFailure(400)).toBe("rejected");
    expect(classifyIngestFailure(422)).toBe("rejected");
  });
});

describe("postToSiteApi outcome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("returns ok with the run on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "run-1", url: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const outcome = await postToSiteApi("https://api.querydoctor.com", [
      makeQuery("hash-a"),
    ]);

    expect(outcome).toEqual({
      ok: true,
      result: { id: "run-1", url: null, metadata: null },
    });
  });

  test("returns a failure carrying the status and body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ZodError: invalid constraintType", { status: 400 }),
      ),
    );

    const outcome = await postToSiteApi("https://api.querydoctor.com", [
      makeQuery("hash-a"),
    ]);

    expect(outcome).toEqual({
      ok: false,
      failure: { status: 400, message: "ZodError: invalid constraintType" },
    });
  });

  test("returns a failure with a null status when the request never completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const outcome = await postToSiteApi("https://api.querydoctor.com", [
      makeQuery("hash-a"),
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ failure: { status: null } });
  });
});

describe("gateEligibleNewQueries", () => {
  function withRecommendation(
    hash: string,
    costReductionPercentage: number,
    hasIndexRecommendation = true,
    cost = 407_000,
  ): CiQueryPayload {
    return {
      hash,
      query: "SELECT * FROM t WHERE user_id = $1",
      formattedQuery: "SELECT *\nFROM t\nWHERE user_id = $1",
      optimization: {
        state: "improvements_available",
        cost,
        optimizedCost: 8.2,
        costReductionPercentage,
        indexRecommendations: hasIndexRecommendation
          ? [
            {
              schema: "public",
              table: "t",
              columns: [{ schema: "public", table: "t", column: "user_id" }],
              definition: "CREATE INDEX ON t (user_id)",
            },
          ]
          : [],
        indexesUsed: [],
      },
      nudges: [],
      tags: [],
      tableReferences: [],
    };
  }

  test("flags a new query whose recommendation exceeds regressionThreshold", async () => {
    const result = gateEligibleNewQueries([withRecommendation("a", 99)], 90);

    expect(result.map((q) => q.hash)).toEqual(["a"]);
  });

  test("with regressionThreshold 0 (flag-all), any real recommendation blocks", async () => {
    const result = gateEligibleNewQueries([withRecommendation("a", 99)], 0);

    expect(result.map((q) => q.hash)).toEqual(["a"]);
  });

  test("ignores a recommendation at or below regressionThreshold", async () => {
    const result = gateEligibleNewQueries([withRecommendation("a", 40)], 90);

    expect(result).toHaveLength(0);
  });

  test("ignores a query with no index recommendation (e.g. test-only query)", async () => {
    const result = gateEligibleNewQueries(
      [withRecommendation("a", 99, false)],
      90,
    );

    expect(result).toHaveLength(0);
  });

  test("ignores a query with no available improvement", async () => {
    const result = gateEligibleNewQueries([makeQuery("a")], 90);

    expect(result).toHaveLength(0);
  });

  test("acknowledged hashes are exempt", async () => {
    const result = gateEligibleNewQueries(
      [withRecommendation("a", 99), withRecommendation("b", 99)],
      90,
      ["a"],
    );

    expect(result.map((q) => q.hash)).toEqual(["b"]);
  });

  test("does not gate a new query whose cost is at or below minimumCost", async () => {
    const result = gateEligibleNewQueries(
      [withRecommendation("a", 99, true, 80)],
      90,
      [],
      100,
    );

    expect(result).toHaveLength(0);
  });

  test("gates a new query whose cost exceeds minimumCost", async () => {
    const result = gateEligibleNewQueries(
      [withRecommendation("a", 99, true, 150)],
      90,
      [],
      100,
    );

    expect(result.map((q) => q.hash)).toEqual(["a"]);
  });

  test("with minimumCost 0 the cost floor is disabled", async () => {
    const result = gateEligibleNewQueries(
      [withRecommendation("a", 99, true, 5)],
      90,
      [],
      0,
    );

    expect(result.map((q) => q.hash)).toEqual(["a"]);
  });
});

describe("fetchPreviousRun retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const foundResponse = () =>
    new Response(
      JSON.stringify({
        id: "run-1",
        repo: "org/repo",
        branch: "main",
        commitSha: "abc",
        queries: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  test("retries a transient timeout and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(foundResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousRun(
      "https://api.querydoctor.com",
      "org/repo",
      "main",
      undefined,
      { retryDelayMs: 0 },
    );

    expect(result).toEqual({
      kind: "found",
      run: { id: "run-1", repo: "org/repo", branch: "main", commitSha: "abc", queries: [] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries a 5xx and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(foundResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousRun(
      "https://api.querydoctor.com",
      "org/repo",
      "main",
      undefined,
      { retryDelayMs: 0 },
    );

    expect(result.kind).toBe("found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not retry a genuine 404 — returns not-found on the first call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousRun(
      "https://api.querydoctor.com",
      "org/repo",
      "main",
      undefined,
      { retryDelayMs: 0 },
    );

    expect(result).toEqual({ kind: "not-found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry a non-404 4xx — returns error on the first call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousRun(
      "https://api.querydoctor.com",
      "org/repo",
      "main",
      undefined,
      { retryDelayMs: 0 },
    );

    expect(result).toEqual({ kind: "error", reason: "HTTP 400" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns error after exhausting retries on persistent transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPreviousRun(
      "https://api.querydoctor.com",
      "org/repo",
      "main",
      undefined,
      { retries: 2, retryDelayMs: 0 },
    );

    expect(result.kind).toBe("error");
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
