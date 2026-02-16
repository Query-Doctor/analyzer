import { expect } from "vitest";

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
