import { test, expect } from "vitest";
import { Connectable } from "./connectable.ts";
import { PgIdentifier } from "@query-doctor/core";

test("connectable", () => {
  const connectable = Connectable.fromString(
    "postgres://user:password@localhost:5432/dbname?a=b&c=d",
  );
  const newConnectable = connectable.withDatabaseName(
    PgIdentifier.fromString("testing"),
  );
  expect(newConnectable.toString()).toEqual(
    "postgres://user:password@localhost:5432/testing?a=b&c=d",
  );
});
