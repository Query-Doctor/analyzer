import { assertEquals } from "@std/assert";
import { Connectable } from "./connectable.ts";

Deno.test("connectable", () => {
  const connectable = Connectable.fromString(
    "postgres://user:password@localhost:5432/dbname?a=b&c=d",
  );
  const newConnectable = connectable.withDatabaseName("testing");
  assertEquals(
    newConnectable.toString(),
    "postgres://user:password@localhost:5432/testing?a=b&c=d",
  );
});
