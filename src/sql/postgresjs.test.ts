import { describe, it, expect } from "vitest";
import { getSslConfig } from "./postgresjs.ts";
import { Connectable } from "../sync/connectable.ts";

function connectable(url: string) {
  return Connectable.fromString(url);
}

describe("getSslConfig", () => {
  it("returns undefined when no sslmode is set", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db"))).toBeUndefined();
  });

  it("returns undefined for sslmode=disable", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=disable"))).toBeUndefined();
  });

  it("returns rejectUnauthorized: false for sslmode=require", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=require"))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("returns rejectUnauthorized: false for sslmode=prefer", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=prefer"))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("returns rejectUnauthorized: false for sslmode=allow", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=allow"))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("returns true for sslmode=verify-full", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=verify-full"))).toBe(true);
  });

  it("returns true for sslmode=verify-ca", () => {
    expect(getSslConfig(connectable("postgres://user:pass@host/db?sslmode=verify-ca"))).toBe(true);
  });
});
