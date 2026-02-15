import { test, expect, vi, afterEach } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function stubConnector(manager: ConnectionManager, impl: Partial<PostgresConnector>) {
  vi.spyOn(manager, "getConnectorFor").mockReturnValue(impl as PostgresConnector);
}

test("QueryLoader - poll emits poll event with queries", async () => {
  const mockQueries = [
    createMockRecentQuery("SELECT * FROM users"),
    createMockRecentQuery("SELECT * FROM posts"),
  ];

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: () => Promise.resolve(mockQueries),
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 3 });

  const pollEvents: RecentQuery[][] = [];
  loader.on("poll", (queries) => {
    pollEvents.push(queries);
  });

  const shouldContinue = await loader.poll();

  expect(shouldContinue).toEqual(true);
  expect(pollEvents.length).toEqual(1);
  expect(pollEvents[0]).toEqual(mockQueries);
});

test("QueryLoader - poll handles errors and emits pollError", async () => {
  const testError = new PostgresError("Database connection failed");

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: (): Promise<RecentQuery[]> => {
      throw testError;
    },
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 3 });

  const pollErrors: unknown[] = [];
  loader.on("pollError", (error) => {
    pollErrors.push(error);
  });

  const shouldContinue1 = await loader.poll();
  expect(shouldContinue1).toEqual(true);
  expect(pollErrors.length).toEqual(1);
  expect(pollErrors[0]).toEqual(testError);

  const shouldContinue2 = await loader.poll();
  expect(shouldContinue2).toEqual(true);
  expect(pollErrors.length).toEqual(2);

  const shouldContinue3 = await loader.poll();
  expect(shouldContinue3).toEqual(true);
  expect(pollErrors.length).toEqual(3);
});

test("QueryLoader - exits after maxErrors consecutive errors", async () => {
  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: (): Promise<RecentQuery[]> => {
      throw new Error("Connection error");
    },
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 2 });

  const exitEvents: number[] = [];
  loader.on("exit", () => {
    exitEvents.push(Date.now());
  });

  const shouldContinue1 = await loader.poll();
  expect(shouldContinue1).toEqual(true);
  expect(exitEvents.length).toEqual(0);

  const shouldContinue2 = await loader.poll();
  expect(shouldContinue2).toEqual(true);
  expect(exitEvents.length).toEqual(0);

  const shouldContinue3 = await loader.poll();
  expect(shouldContinue3).toEqual(false);
  expect(exitEvents.length).toEqual(1);
});

test("QueryLoader - error counter resets on successful poll", async () => {
  let callCount = 0;

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: (): Promise<RecentQuery[]> => {
      callCount++;
      if (callCount !== 3) {
        throw new Error("Temporary error");
      }
      return Promise.resolve([createMockRecentQuery("SELECT 1")]);
    },
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 2 });

  const pollErrors: unknown[] = [];
  const pollEvents: RecentQuery[][] = [];
  loader.on("pollError", (error) => pollErrors.push(error));
  loader.on("poll", (queries) => pollEvents.push(queries));

  await loader.poll();
  expect(pollErrors.length).toEqual(1);
  expect(pollEvents.length).toEqual(0);

  await loader.poll();
  expect(pollErrors.length).toEqual(2);
  expect(pollEvents.length).toEqual(0);

  const shouldContinue = await loader.poll();
  expect(shouldContinue).toEqual(true);
  expect(pollErrors.length).toEqual(2);
  expect(pollEvents.length).toEqual(1);

  await loader.poll();
  await loader.poll();
  const finalResult = await loader.poll();
  expect(finalResult).toEqual(false);
});

test("QueryLoader - stop prevents further polling", async () => {
  vi.useFakeTimers();

  const mockQueries = [createMockRecentQuery("SELECT 1")];

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: () => Promise.resolve(mockQueries),
  });

  const loader = new QueryLoader(manager, connectable);

  let pollCount = 0;
  loader.on("poll", () => {
    pollCount++;
  });

  loader.start();
  loader.stop();

  await vi.advanceTimersByTimeAsync(10000);

  expect(pollCount).toEqual(0);
});

test("QueryLoader - start schedules polls with default interval", async () => {
  vi.useFakeTimers();

  const mockQueries = [createMockRecentQuery("SELECT 1")];

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: () => Promise.resolve(mockQueries),
  });

  const loader = new QueryLoader(manager, connectable);

  let pollCount = 0;
  loader.on("poll", () => {
    pollCount++;
  });

  loader.start();

  await vi.advanceTimersByTimeAsync(10000);

  expect(pollCount).toBeGreaterThan(0);

  loader.stop();
});

test("QueryLoader - handles non-Error exceptions", async () => {
  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: (): Promise<RecentQuery[]> => {
      throw "String error";
    },
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 1 });

  const pollErrors: unknown[] = [];
  loader.on("pollError", (error) => {
    pollErrors.push(error);
  });

  const shouldContinue = await loader.poll();
  expect(shouldContinue).toEqual(true);
  expect(pollErrors.length).toEqual(1);
});

test("QueryLoader - emits exit on unexpected promise rejection in scheduled poll", async () => {
  vi.useFakeTimers();

  let shouldFail = false;

  const manager = ConnectionManager.forLocalDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");

  stubConnector(manager, {
    getRecentQueries: (): Promise<RecentQuery[]> => {
      if (shouldFail) {
        throw new PostgresError("Unexpected error");
      }
      return Promise.resolve([createMockRecentQuery("SELECT 1")]);
    },
  });

  const loader = new QueryLoader(manager, connectable, { maxErrors: 0 });

  const exitEvents: number[] = [];
  loader.on("exit", () => {
    exitEvents.push(Date.now());
  });

  shouldFail = true;
  loader.start();

  await vi.advanceTimersByTimeAsync(10000);
  await vi.advanceTimersByTimeAsync(0);

  expect(exitEvents.length).toBeGreaterThan(0);
  loader.stop();
});
