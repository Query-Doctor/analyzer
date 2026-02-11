import { assertEquals } from "@std/assert/equals";
import { assertGreater } from "@std/assert/greater";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type {
  OptimizedQuery,
  QueryHash,
  RecentQuery,
} from "../sql/recent-query.ts";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { QueryLoader } from "./query-loader.ts";
import { PostgresConnector } from "../sync/pg-connector.ts";
import { PostgresError } from "../sync/errors.ts";

function createMockRecentQuery(query: string): RecentQuery {
  return {
    query,
    username: "test_user",
    formattedQuery: query,
    meanTime: 100,
    calls: "10",
    rows: "5",
    topLevel: true,
    isSystemQuery: false,
    isSelectQuery: true,
    isIntrospection: false,
    isTargetlessSelectQuery: false,
    tableReferences: [],
    columnReferences: [],
    tags: [],
    nudges: [],
    hash: "test_hash" as QueryHash,
    seenAt: Date.now(),
    withOptimization: function () {
      return this as OptimizedQuery;
    },
  } as RecentQuery;
}

Deno.test({
  name: "QueryLoader - poll emits poll event with queries",
  fn: async () => {
    const mockQueries = [
      createMockRecentQuery("SELECT * FROM users"),
      createMockRecentQuery("SELECT * FROM posts"),
    ];

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: () => Promise.resolve(mockQueries),
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable, { maxErrors: 3 });

    const pollEvents: RecentQuery[][] = [];
    loader.on("poll", (queries) => {
      pollEvents.push(queries);
    });

    const shouldContinue = await loader.poll();

    assertEquals(shouldContinue, true);
    assertEquals(pollEvents.length, 1);
    assertEquals(pollEvents[0], mockQueries);
  },
});

Deno.test({
  name: "QueryLoader - poll handles errors and emits pollError",
  fn: async () => {
    const testError = new PostgresError("Database connection failed");

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: (): Promise<RecentQuery[]> => {
        throw testError;
      },
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable, { maxErrors: 3 });

    const pollErrors: unknown[] = [];
    loader.on("pollError", (error) => {
      pollErrors.push(error);
    });

    const shouldContinue1 = await loader.poll();
    assertEquals(shouldContinue1, true);
    assertEquals(pollErrors.length, 1);
    assertEquals(pollErrors[0], testError);

    const shouldContinue2 = await loader.poll();
    assertEquals(shouldContinue2, true);
    assertEquals(pollErrors.length, 2);

    const shouldContinue3 = await loader.poll();
    assertEquals(shouldContinue3, true);
    assertEquals(pollErrors.length, 3);
  },
});

Deno.test({
  name: "QueryLoader - exits after maxErrors consecutive errors",
  fn: async () => {
    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: (): Promise<RecentQuery[]> => {
        throw new Error("Connection error");
      },
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable, { maxErrors: 2 });

    const exitEvents: number[] = [];
    loader.on("exit", () => {
      exitEvents.push(Date.now());
    });

    const shouldContinue1 = await loader.poll();
    assertEquals(shouldContinue1, true);
    assertEquals(exitEvents.length, 0);

    const shouldContinue2 = await loader.poll();
    assertEquals(shouldContinue2, true);
    assertEquals(exitEvents.length, 0);

    const shouldContinue3 = await loader.poll();
    assertEquals(shouldContinue3, false);
    assertEquals(exitEvents.length, 1);
  },
});

Deno.test({
  name: "QueryLoader - error counter resets on successful poll",
  fn: async () => {
    let callCount = 0;

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: (): Promise<RecentQuery[]> => {
        callCount++;
        if (callCount !== 3) {
          throw new Error("Temporary error");
        }
        return Promise.resolve([createMockRecentQuery("SELECT 1")]);
      },
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable, { maxErrors: 2 });

    const pollErrors: unknown[] = [];
    const pollEvents: RecentQuery[][] = [];
    loader.on("pollError", (error) => pollErrors.push(error));
    loader.on("poll", (queries) => pollEvents.push(queries));

    await loader.poll();
    assertEquals(pollErrors.length, 1);
    assertEquals(pollEvents.length, 0);

    await loader.poll();
    assertEquals(pollErrors.length, 2);
    assertEquals(pollEvents.length, 0);

    const shouldContinue = await loader.poll();
    assertEquals(shouldContinue, true);
    assertEquals(pollErrors.length, 2);
    assertEquals(pollEvents.length, 1);

    await loader.poll();
    await loader.poll();
    const finalResult = await loader.poll();
    assertEquals(finalResult, false);
  },
});

Deno.test({
  name: "QueryLoader - stop prevents further polling",
  fn: async () => {
    using time = new FakeTime();

    const mockQueries = [createMockRecentQuery("SELECT 1")];

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: () => Promise.resolve(mockQueries),
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable);

    let pollCount = 0;
    loader.on("poll", () => {
      pollCount++;
    });

    loader.start();
    loader.stop();

    await time.tickAsync(10000);

    assertEquals(pollCount, 0);
  },
});

Deno.test({
  name: "QueryLoader - start schedules polls with default interval",
  fn: async () => {
    using time = new FakeTime();

    const mockQueries = [createMockRecentQuery("SELECT 1")];

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: () => Promise.resolve(mockQueries),
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable);

    let pollCount = 0;
    loader.on("poll", () => {
      pollCount++;
    });

    loader.start();

    await time.tickAsync(10000);

    assertGreater(pollCount, 0);

    loader.stop();
  },
});

Deno.test({
  name:
    "QueryLoader - emits exit on unexpected promise rejection in scheduled poll",
  fn: async () => {
    using time = new FakeTime();

    let shouldFail = false;

    const manager = ConnectionManager.forLocalDatabase();
    const connectable = Connectable.fromString(
      "postgres://localhost:5432/test",
    );

    using _ = stub(manager, "getConnectorFor", () => ({
      getRecentQueries: (): Promise<RecentQuery[]> => {
        if (shouldFail) {
          throw new PostgresError("String error");
        }
        return Promise.resolve([createMockRecentQuery("SELECT 1")]);
      },
    } as PostgresConnector));

    const loader = new QueryLoader(manager, connectable, { maxErrors: 0 });

    const exitEvents: number[] = [];
    loader.on("exit", () => {
      exitEvents.push(Date.now());
    });

    shouldFail = true;
    loader.start();

    await time.tickAsync(10000);
    await time.runMicrotasks();

    assertGreater(exitEvents.length, 0);
    loader.stop();
  },
});
