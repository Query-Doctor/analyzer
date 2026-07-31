import { describe, expect, it } from "vitest";
import { evaluateGates, summarizeGates } from "./evaluate.ts";

describe("summarizeGates", () => {
  it("counts the roster the comment heading reports, and concludes from it", () => {
    const gates = evaluateGates({ indexedNewQueryCount: 2, newQueryCount: 4 });

    // new-query-index blocks; new-query surfaces; the other four found nothing.
    expect(summarizeGates(gates)).toEqual({
      failing: 1,
      successful: 4,
      neutral: 1,
      conclusion: "failure",
    });
  });

  it("concludes success when nothing fired", () => {
    expect(summarizeGates(evaluateGates({}))).toMatchObject({
      failing: 0,
      successful: 6,
      conclusion: "success",
    });
  });
});

describe("evaluateGates", () => {
  it("reports every condition on a clean run, none of them fired", () => {
    const gates = evaluateGates({});

    expect(gates.map((g) => g.condition)).toEqual([
      "regression-beyond-threshold",
      "untested-data-access",
      "new-query",
      "new-query-index",
      "schema-drift",
      "high-value-nudge",
    ]);
    expect(gates.every((g) => g.fired)).toBe(false);
    expect(gates.every((g) => g.conclusion === "success")).toBe(true);
  });

  it("blocks the check when a regression clears the threshold", () => {
    const gates = evaluateGates({ regressedCount: 2 });
    const regression = gates.find(
      (g) => g.condition === "regression-beyond-threshold",
    );

    expect(regression).toMatchObject({ fired: true, conclusion: "failure" });
  });

  it("labels each condition the way the Gate Policies screen does", () => {
    const gates = evaluateGates({});

    expect(
      gates.find((g) => g.condition === "new-query-index")?.label,
    ).toBe("New query with index recommendation");
    expect(
      gates.find((g) => g.condition === "regression-beyond-threshold")?.label,
    ).toBe("Cost regression");
  });

  it("drops a suppressed condition from the roster entirely", () => {
    const gates = evaluateGates(
      { regressedCount: 2 },
      { "regression-beyond-threshold": "off" },
    );

    expect(
      gates.some((g) => g.condition === "regression-beyond-threshold"),
    ).toBe(false);
  });

  it("fires new-query informationally but new-query-index blocks", () => {
    const gates = evaluateGates({ newQueryCount: 4, indexedNewQueryCount: 2 });

    expect(gates.find((g) => g.condition === "new-query")).toMatchObject({
      fired: true,
      conclusion: "neutral",
    });
    expect(gates.find((g) => g.condition === "new-query-index")).toMatchObject({
      fired: true,
      conclusion: "failure",
    });
  });

  it("fires schema-drift and untested-data-access from their own facts", () => {
    const gates = evaluateGates({
      schemaChanged: true,
      untestedDataAccessFileCount: 3,
    });

    expect(gates.find((g) => g.condition === "schema-drift")).toMatchObject({
      fired: true,
      conclusion: "failure",
    });
    expect(
      gates.find((g) => g.condition === "untested-data-access"),
    ).toMatchObject({ fired: true, conclusion: "failure" });
  });

  it("surfaces a warn condition without blocking", () => {
    const gates = evaluateGates(
      { regressedCount: 2 },
      { "regression-beyond-threshold": "warn" },
    );

    expect(
      gates.find((g) => g.condition === "regression-beyond-threshold"),
    ).toMatchObject({ fired: true, conclusion: "neutral" });
  });
});

describe("gate copy", () => {
  it("says what each condition found, or that it found nothing", () => {
    const gates = evaluateGates({ indexedNewQueryCount: 2, newQueryCount: 4 });
    const found = (c: string) => gates.find((g) => g.condition === c)?.found;

    expect(found("new-query-index")).toBe(
      "2 new queries ship a high-impact index recommendation",
    );
    expect(found("new-query")).toBe("4 new queries, none with a prior baseline");
    expect(found("schema-drift")).toBe("No schema changes");
  });

  it("uses the singular when one thing fired", () => {
    const gates = evaluateGates({ indexedNewQueryCount: 1, newQueryCount: 1 });
    const found = (c: string) => gates.find((g) => g.condition === c)?.found;

    expect(found("new-query-index")).toBe(
      "1 new query ships a high-impact index recommendation",
    );
    expect(found("new-query")).toBe("1 new query, with no prior baseline");
  });
});
