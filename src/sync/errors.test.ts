import { test, expect } from "vitest";
import {
  PostgresError,
  ExtensionNotInstalledError,
  MaxTableIterationsReached,
} from "./errors.ts";

test("PostgresError serializes to JSON with correct shape", () => {
  const error = new PostgresError("connection failed");
  expect(error.toJSON()).toEqual({
    kind: "error",
    type: "unexpected_error",
    error: "connection failed",
  });
});

test("PostgresError.toResponse returns 500 with JSON body", async () => {
  const error = new PostgresError("something broke");
  const response = error.toResponse();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual(error.toJSON());
});

test("ExtensionNotInstalledError serializes with extension name", () => {
  const error = new ExtensionNotInstalledError("pg_stat_statements");
  expect(error.toJSON()).toEqual({
    kind: "error",
    type: "extension_not_installed",
    extensionName: "extension pg_stat_statements is not installed",
  });
  expect(error.extension).toBe("pg_stat_statements");
});

test("ExtensionNotInstalledError.toResponse returns 400", async () => {
  const error = new ExtensionNotInstalledError("pg_stat_statements");
  const response = error.toResponse();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(error.toJSON());
});

test("MaxTableIterationsReached serializes with bug message", () => {
  const error = new MaxTableIterationsReached(100);
  expect(error.toJSON()).toEqual({
    kind: "error",
    type: "max_table_iterations_reached",
    error: "Max table iterations reached. This is a bug with the syncer",
  });
  expect(error.maxIterations).toBe(100);
});

test("MaxTableIterationsReached.toResponse returns 500", async () => {
  const error = new MaxTableIterationsReached(100);
  const response = error.toResponse();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual(error.toJSON());
});

test("all error classes are instances of Error", () => {
  expect(new PostgresError("x")).toBeInstanceOf(Error);
  expect(new ExtensionNotInstalledError("x")).toBeInstanceOf(Error);
  expect(new MaxTableIterationsReached(1)).toBeInstanceOf(Error);
});
