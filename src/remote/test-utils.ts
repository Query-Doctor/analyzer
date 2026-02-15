import { expect } from "vitest";

/**
 * Vitest's expect().toBeTruthy() doesn't narrow types like
 * Deno's assert(). This helper uses an assertion signature
 * to narrow nullable values after checking.
 */
export function assertDefined<T>(
  value: T,
  message?: string,
): asserts value is NonNullable<T> {
  expect(value, message ?? "Expected value to be defined").toBeTruthy();
}
