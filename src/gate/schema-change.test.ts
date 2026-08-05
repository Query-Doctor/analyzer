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

  it("passes once someone has approved the migration", () => {
    expect(gateSchemaChange({ changed: true, approved: true })).toBeNull();
  });

  it("still blocks a schema change nobody has approved", () => {
    expect(gateSchemaChange({ changed: true, approved: false })?.conclusion).toBe(
      "failure",
    );
  });

  // An API that predates the field sends no `approved` at all. Reading that as
  // approved would drop the gate for every repo on an older deployment.
  it("blocks when the API sends no approval field", () => {
    expect(gateSchemaChange({ changed: true })?.conclusion).toBe("failure");
  });

  it("names the tool that clears the gate", () => {
    expect(gateSchemaChange({ changed: true })!.message).toContain(
      "approve_schema_change",
    );
  });

  it("passes when the API returned no schema-change signal", () => {
    expect(gateSchemaChange(null)).toBeNull();
    expect(gateSchemaChange(undefined)).toBeNull();
  });
});
