import { test, expect, vi } from "vitest";

test("returns original URL when HOSTED is false", async () => {
  vi.stubEnv("HOSTED", "false");
  vi.resetModules();
  const { sanitizePostgresUrl } = await import("./sanitize.ts");
  const url = "postgres://user:pass@host:5432/db";
  expect(sanitizePostgresUrl(url)).toBe(url);
});

test("returns hashed URL when HOSTED is true", async () => {
  vi.stubEnv("HOSTED", "true");
  vi.resetModules();
  const { sanitizePostgresUrl } = await import("./sanitize.ts");
  const url = "postgres://user:pass@host:5432/db";
  const result = sanitizePostgresUrl(url);
  expect(result).toMatch(/^omitted__[a-f0-9]{8}$/);
  expect(result).not.toContain("user");
  expect(result).not.toContain("pass");
  expect(result).not.toContain("host");
});

test("same input produces same hash", async () => {
  vi.stubEnv("HOSTED", "true");
  vi.resetModules();
  const { sanitizePostgresUrl } = await import("./sanitize.ts");
  const url = "postgres://user:pass@host:5432/db";
  expect(sanitizePostgresUrl(url)).toBe(sanitizePostgresUrl(url));
});

test("different inputs produce different hashes", async () => {
  vi.stubEnv("HOSTED", "true");
  vi.resetModules();
  const { sanitizePostgresUrl } = await import("./sanitize.ts");
  const a = sanitizePostgresUrl("postgres://a@host/db1");
  const b = sanitizePostgresUrl("postgres://b@host/db2");
  expect(a).not.toBe(b);
});
