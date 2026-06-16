import { test, expect, vi, afterEach } from "vitest";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { SchemaLoader } from "./schema-loader.ts";
import type { FullSchema, Postgres } from "@query-doctor/core";
import { dumpSchema } from "@query-doctor/core";
import type { Op } from "jsondiffpatch/formatters/jsonpatch";

vi.mock(import("@query-doctor/core"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, dumpSchema: vi.fn() };
});

const mockedDumpSchema = vi.mocked(dumpSchema);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeSchema(overrides?: Partial<FullSchema>): FullSchema {
  return {
    indexes: [],
    tables: [],
    constraints: [],
    functions: [],
    extensions: [],
    views: [],
    types: [],
    triggers: [],
    ...overrides,
  };
}

function makeLoader() {
  const manager = ConnectionManager.forRemoteDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");
  vi.spyOn(manager, "getOrCreateConnection").mockReturnValue({} as Postgres);
  return new SchemaLoader(manager, connectable);
}

test("SchemaLoader - poll diffs against the previously seen schema", async () => {
  const loader = makeLoader();

  mockedDumpSchema.mockResolvedValueOnce(makeSchema());
  const first = await loader.poll();
  expect(first.diffs).toEqual([]);

  mockedDumpSchema.mockResolvedValueOnce(
    makeSchema({ tables: [{ type: "table", oid: 1 } as never] }),
  );
  const second = await loader.poll();
  expect(second.diffs.length).toBeGreaterThan(0);
  expect(loader.getLatestSchema()?.tables.length).toEqual(1);
});

test("SchemaLoader - start emits diff on schema change", async () => {
  vi.useFakeTimers();
  const loader = makeLoader();

  mockedDumpSchema.mockResolvedValueOnce(makeSchema());
  mockedDumpSchema.mockResolvedValueOnce(
    makeSchema({ tables: [{ type: "table", oid: 1 } as never] }),
  );

  const diffs: Op[][] = [];
  loader.on("diff", (ops) => diffs.push(ops));

  loader.start();

  await vi.advanceTimersByTimeAsync(60_000);
  expect(diffs.length).toEqual(0);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(diffs.length).toEqual(1);

  loader.stop();
});

test("SchemaLoader - does not emit diff when schema is unchanged", async () => {
  vi.useFakeTimers();
  const loader = makeLoader();

  mockedDumpSchema.mockResolvedValue(makeSchema());

  const diffs: Op[][] = [];
  loader.on("diff", (ops) => diffs.push(ops));

  loader.start();
  await vi.advanceTimersByTimeAsync(180_000);

  expect(diffs.length).toEqual(0);
  loader.stop();
});

test("SchemaLoader - stop prevents further polling", async () => {
  vi.useFakeTimers();
  const loader = makeLoader();
  mockedDumpSchema.mockClear();
  mockedDumpSchema.mockResolvedValue(makeSchema());

  let pollCount = 0;
  loader.on("diff", () => pollCount++);

  loader.start();
  loader.stop();

  await vi.advanceTimersByTimeAsync(120_000);
  expect(mockedDumpSchema).not.toHaveBeenCalled();
  expect(pollCount).toEqual(0);
});

test("SchemaLoader - exits after maxErrors consecutive errors", async () => {
  vi.useFakeTimers();
  const manager = ConnectionManager.forRemoteDatabase();
  const connectable = Connectable.fromString("postgres://localhost:5432/test");
  vi.spyOn(manager, "getOrCreateConnection").mockReturnValue({} as Postgres);
  const loader = new SchemaLoader(manager, connectable, { maxErrors: 1, interval: 1_000 });

  mockedDumpSchema.mockRejectedValue(new Error("dump failed"));

  const pollErrors: unknown[] = [];
  const exits: number[] = [];
  loader.on("pollError", (error) => pollErrors.push(error));
  loader.on("exit", () => exits.push(Date.now()));

  loader.start();

  await vi.advanceTimersByTimeAsync(1_000);
  expect(pollErrors.length).toEqual(1);
  expect(exits.length).toEqual(0);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(pollErrors.length).toEqual(2);
  expect(exits.length).toEqual(1);

  loader.stop();
});
