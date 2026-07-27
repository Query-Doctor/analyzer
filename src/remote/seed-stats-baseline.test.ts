import { describe, expect, it } from "vitest";
import type { ExportedStats } from "@query-doctor/core";
import { Connectable } from "../sync/connectable.ts";
import { ConnectionManager } from "../sync/connection-manager.ts";
import { Remote } from "./remote.ts";
import { detectDrift, type StatsBaseline } from "./stats-drift.ts";

// Seeding only writes to memory, so no database is needed. Constructing Remote
// opens no connection; the managers are only used once work is requested.
function makeRemote(): Remote {
  const target = Connectable.fromString(
    "postgresql://postgres@localhost:5432/postgres",
  );
  return new Remote(target, ConnectionManager.forRemoteDatabase());
}

function table(name: string, reltuples: number): ExportedStats {
  return {
    schemaName: "public",
    tableName: name,
    reltuples,
    relpages: 1,
    relallvisible: 0,
    columns: [],
    indexes: [],
  } as unknown as ExportedStats;
}

/**
 * The baseline is private, so observe it the way the drift check does: seed,
 * then ask whether a schema that has moved on is seen as drifted.
 */
function baselineOf(remote: Remote): StatsBaseline | undefined {
  return (remote as unknown as { statsBaseline?: StatsBaseline }).statsBaseline;
}

describe("Remote.seedStatsBaseline", () => {
  it("adopts the stored snapshot so the next poll can detect drift", () => {
    const remote = makeRemote();

    remote.seedStatsBaseline([table("users", 10_000)]);

    const baseline = baselineOf(remote);
    expect(baseline).toBeDefined();
    // A table the stored snapshot never covered now reads as Shape Drift,
    // which is the whole point of seeding.
    const verdict = detectDrift(baseline!, {
      reltuples: new Map([["public.users", 10_000], ["public.teams", 0]]),
    });
    expect(verdict.drifted).toBe(true);
  });

  it("leaves drift inert when the server holds no snapshot", () => {
    const remote = makeRemote();

    remote.seedStatsBaseline([]);

    expect(baselineOf(remote)).toBeUndefined();
  });

  it("does not overwrite a baseline the analyzer already established", () => {
    // A reconnect must not replace a fresh local baseline with the server's
    // older copy, or every reconnect would re-dump.
    const remote = makeRemote();
    remote.seedStatsBaseline([table("users", 10_000)]);
    const first = baselineOf(remote);

    remote.seedStatsBaseline([table("users", 999), table("teams", 5)]);

    expect(baselineOf(remote)).toBe(first);
  });

  it("does not push what it seeded", () => {
    // Seeding adopts numbers that came from the server. Emitting them would
    // republish a stale snapshot as if it were a fresh dump.
    const remote = makeRemote();
    let pushed = false;
    remote.on("statsApplied", () => {
      pushed = true;
    });

    remote.seedStatsBaseline([table("users", 10_000)]);

    expect(pushed).toBe(false);
  });
});
