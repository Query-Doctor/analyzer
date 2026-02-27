import { test, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { connectToSource } from "./postgresjs.ts";
import { Connectable } from "../sync/connectable.ts";

test("connects to postgres with sslmode=require and self-signed cert", async () => {
  const pg = await new PostgreSqlContainer("postgres:17")
    .withCommand([
      "-c", "ssl=on",
      "-c", "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
      "-c", "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key",
    ])
    .start();

  const baseUrl = pg.getConnectionUri();
  const url = `${baseUrl}?sslmode=require`;
  const connectable = Connectable.fromString(url);
  const db = connectToSource(connectable);

  const rows = await db.exec("SELECT 1 AS ok");
  expect(rows).toEqual([{ ok: 1 }]);

  // @ts-expect-error | close is not yet in the Postgres interface
  await db.close();
  await pg.stop();
});
