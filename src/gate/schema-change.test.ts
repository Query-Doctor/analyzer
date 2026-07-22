import { describe, expect, it } from "vitest";
import { gateSchemaChange } from "./schema-change.ts";

describe("gateSchemaChange", () => {
  it("blocks a schema change by default", () => {
    expect(gateSchemaChange({ changed: true })).toEqual({
      conclusion: "failure",
      message: expect.stringContaining("changes the database schema"),
    });
  });

  it("softens to a non-blocking warning under a warn policy", () => {
    expect(
      gateSchemaChange({ changed: true }, { "schema-drift": "warn" })?.conclusion,
    ).toBe("neutral");
  });

  it("drops the gate under an off policy", () => {
    expect(
      gateSchemaChange({ changed: true }, { "schema-drift": "off" }),
    ).toBeNull();
  });

  it("passes when the run reports no schema change", () => {
    expect(gateSchemaChange({ changed: false })).toBeNull();
  });

  it("passes when the API returned no schema-change signal", () => {
    expect(gateSchemaChange(null)).toBeNull();
    expect(gateSchemaChange(undefined)).toBeNull();
  });
});
