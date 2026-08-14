import { expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export function assert(
  condition: unknown,
  message?: string,
): asserts condition {
  expect(condition, message ?? "Assertion failed").toBeTruthy();
}

export function assertDefined<T>(
  value: T,
  message?: string,
): asserts value is NonNullable<T> {
  expect(value, message ?? "Expected value to be defined").toBeTruthy();
}

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ");
}

const TEST_TARGET_CONTAINER_NAME = "postgres:17";

/**
 * Start a Postgres container, seeded from `content` as an initdb script when
 * one is given.
 *
 * Lives here rather than beside the tests that use it: importing it from a
 * `*.test.ts` registers that file's tests into the importer's suite too, so
 * every borrower pays for the lender's containers.
 */
export function testSpawnTarget(
  options: { content?: string; containerName?: string } = {
    containerName: TEST_TARGET_CONTAINER_NAME,
  },
) {
  let pg = new PostgreSqlContainer(
    options.containerName ?? TEST_TARGET_CONTAINER_NAME,
  );
  if (options.content) {
    pg = pg.withCopyContentToContainer([
      {
        content: options.content,
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ]);
  }
  return pg.start();
}
